// Provider availability at the action boundary.
//
// The dogfooding finding: `2f new "..." --provider deepseek-harness` created
// a task and started a run even when the provider's executable was KNOWN to
// be unavailable — a guaranteed-fail run. Availability is a runtime fact
// (executable resolution), and the manual-selection path must enforce it at
// the action boundary, BEFORE any work or run is persisted:
//
//   - no task/run for a manually selected unavailable provider
//   - manual selection never bypasses availability (AUTO already excludes
//     unavailable providers)
//   - no silent fallback, no degrading an explicit provider into AUTO
//   - an unspecified request (the configured/runtime default) is not a
//     manual selection and keeps its historical behavior
//
// Availability is made deterministic by pointing PATH at an empty bin dir, so
// these tests pass identically whether or not dsh/claude are installed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";
import { startServer } from "../src/server.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return null;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return null;
    },
    async cancelExecution() {},
    calls
  };
}

// A runtime whose PATH cannot resolve ANY provider executable: both natives
// are deterministically unavailable, exactly like a machine without either
// harness installed.
async function makeRuntimeWithoutProviders() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-unavailable-"));
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-unavailable-bins-"));
  const env = { ...process.env, PATH: bins };
  const node = fakeNode();
  const runtime = createRuntime(base, { node, env });
  return { ...runtime, node, base, bins };
}

test("createWork refuses a manually selected unavailable provider BEFORE persisting anything", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    assert.equal(rt.providers.available("deepseek-harness"), false);

    await assert.rejects(
      () => rt.actions.createWork({ title: "Doomed", provider: "deepseek-harness" }),
      error => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Execution provider "deepseek-harness" is unavailable/);
        assert.match(error.message, /Expected executable: dsh/);
        assert.match(error.message, /Install or configure DeepSeek Harness, then retry\./);
        return true;
      }
    );

    // Nothing was persisted, nothing was launched, and the refusal never
    // fell back to another provider or to AUTO.
    assert.deepEqual(await rt.store.listTasks(), []);
    assert.deepEqual(rt.node.calls, []);
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("an unavailable manual provider is never turned into AUTO", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    await assert.rejects(
      () => rt.actions.createWork({ title: "Doomed", provider: "deepseek-harness" }),
      /Execution provider "deepseek-harness" is unavailable/
    );
    // The task never exists, so the ledger shows nothing — not a task routed
    // somewhere else.
    assert.deepEqual(await rt.store.listTasks(), []);
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("rerunWork refuses an explicitly selected unavailable provider; the previous run survives", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    // A task that ran successfully BEFORE the harness disappeared.
    const task = await rt.actions.createWork({ title: "Was fine" });
    const { updateRun } = await import("../src/core/runs.mjs");
    const done = updateRun(applyOutcome(task, { status: "ready", result: "ok" }), 1, {
      outcome: "ready",
      completedAt: new Date().toISOString(),
      durationMs: 1,
      attempts: 1,
      error: undefined,
      blockedOn: undefined
    });
    await rt.store.writeJson(
      path.join(rt.store.taskDir(task.slug), "task.json"),
      done
    );

    await assert.rejects(
      () => rt.actions.rerunWork(task.id, { provider: "deepseek-harness" }),
      /Execution provider "deepseek-harness" is unavailable/
    );

    // No new run was appended; run 1 is untouched.
    const persisted = await rt.store.findTask(task.id);
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.runs[0].provider, "claude-code");
    assert.equal(persisted.runs[0].outcome, "ready");
    assert.deepEqual(rt.node.calls, [["start", task.slug]]); // no second launch
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("AUTO keeps excluding unavailable providers (never routes to a missing executable)", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    await assert.rejects(
      () => rt.actions.createWork({ title: "Nothing", provider: "auto" }),
      /AUTO routing: no execution provider is available/
    );
    assert.deepEqual(await rt.store.listTasks(), []);
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("an unspecified request is not a manual selection: the runtime default keeps its historical behavior", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    // The user did not pick a provider — the default resolves, and the task
    // is created as before (its run fails in the worker, exactly as it did
    // before availability was enforced for manual selections).
    const task = await rt.actions.createWork({ title: "Default" });
    assert.equal(task.execution.provider, "claude-code");
    assert.equal((await rt.store.findTask(task.id)).execution.provider, "claude-code");
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("POST /api/tasks with an unavailable provider -> 400 from the shared action (the Web UI is not the authority)", async () => {
  const rt = await makeRuntimeWithoutProviders();
  try {
    const handle = await startServer(rt.base, 0, {
      runtime: rt,
      interval: 20
    });
    try {
      const res = await fetch(handle.url + "/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Doomed", provider: "deepseek-harness" })
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /Execution provider "deepseek-harness" is unavailable/);
      assert.match(body.error, /Expected executable: dsh/);

      // The server enforced it independently of any client: no task exists.
      const tasks = await fetch(handle.url + "/api/tasks").then(r => r.json());
      assert.deepEqual(tasks, []);
      assert.deepEqual(rt.node.calls, []);
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});
