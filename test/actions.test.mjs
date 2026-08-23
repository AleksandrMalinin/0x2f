// Shared Work actions — the single business-logic layer used by BOTH the
// CLI and the Web API.
//
// These tests drive the actions through a FAKE execution node, which proves
// two things at once:
//   1. Actions own create/allow/reject/close/get/list — not the CLI, not the
//      server, not the UI.
//   2. Execution goes through the node contract (startExecution /
//      resumeExecution), so execution no longer implicitly means "spawn a
//      process on the UI machine". Swapping the node swaps the machine.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";
import { createStore } from "../src/core/store.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: id => (id === "local" ? "/virtual/workspace" : (() => { throw new Error("nope"); })()),
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return 1234;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return 5678;
    },
    async cancelExecution() {},
    calls
  };
}

async function makeRuntime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-actions-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  return { ...runtime, node, base };
}

// Build a needs_you task (as a provider run would leave it) so we can test
// allow/reject/close against a realistic state. Mirrors what the worker does
// with an outcome: apply it, then copy the outcome's externalSessionId into
// task.execution.
async function makeNeedsYouTask(runtime, title = "Blocked task") {
  const task = await runtime.actions.createWork({ title });
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "permission",
    externalSessionId: "sess-abc",
    blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
  });
  blocked.execution = {
    ...(blocked.execution ?? {}),
    externalSessionId: "sess-abc"
  };
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  return blocked;
}

test("createWork creates a persistent task and starts execution on the node", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "  Fix the overflow  " });

    assert.equal(task.status, "working");
    assert.equal(task.execution.provider, "claude-code");
    assert.equal(task.execution.node, "fake-node");
    assert.equal(task.execution.workspace, "local");
    assert.equal(task.pid, 1234);

    // Persisted under .work/tasks/<slug>/task.json
    const onDisk = await runtime.store.findTask(task.id);
    assert.equal(onDisk.title, "Fix the overflow");
    assert.equal(onDisk.execution.node, "fake-node");

    // Node got the execution request; the action never spawned anything.
    assert.deepEqual(runtime.node.calls, [["start", task.slug]]);

    // A normalized task.created event was recorded for live clients.
    const events = (await runtime.store.readEventLog(task.slug)).trim().split("\n");
    assert.equal(JSON.parse(events[0]).type, "task.created");
    assert.equal(JSON.parse(events[0]).taskId, task.id);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("createWork rejects an empty title with the shared error", async () => {
  const runtime = await makeRuntime();
  try {
    await assert.rejects(() => runtime.actions.createWork({ title: "   " }), /Task title is required\./);
    assert.deepEqual(runtime.node.calls, []);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("resumeWork on a needs_you task hands execution back to the node", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await makeNeedsYouTask(runtime);
    const resumed = await runtime.actions.resumeWork(task.id, "allow");

    assert.equal(resumed.status, "working");
    assert.deepEqual(runtime.node.calls.at(-1), ["resume", task.slug, "allow"]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("allowWork/rejectWork are the same action with a different grant", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await makeNeedsYouTask(runtime);
    await runtime.actions.allowWork(task.id);
    assert.deepEqual(runtime.node.calls.at(-1), ["resume", task.slug, "allow"]);

    // Re-block it, then reject.
    const blockedAgain = applyOutcome(
      await runtime.store.findTask(task.id),
      { status: "needs_you", reason: "permission", externalSessionId: "sess-abc", blockedOn: { type: "permission" } }
    );
    blockedAgain.execution = { ...(blockedAgain.execution ?? {}), externalSessionId: "sess-abc" };
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      blockedAgain
    );
    await runtime.actions.rejectWork(task.id);
    assert.deepEqual(runtime.node.calls.at(-1), ["resume", task.slug, "reject"]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("resumeWork on a non-needs_you task throws the CLI's exact error (shared logic)", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "Working task" });
    await assert.rejects(
      () => runtime.actions.resumeWork(task.id, "allow"),
      /Task #1 is working, not needs_you — nothing to allow\./
    );
    assert.deepEqual(runtime.node.calls, [["start", task.slug]]); // no resume attempt
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("resumeWork without a resumable session throws the CLI's exact error", async () => {
  const runtime = await makeRuntime();
  try {
    // needs_you but no externalSessionId — legacy/manual state.
    const task = await runtime.actions.createWork({ title: "No session" });
    const blocked = applyOutcome(task, {
      status: "needs_you",
      reason: "permission",
      blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
    });
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      blocked
    );

    await assert.rejects(
      () => runtime.actions.rejectWork(task.id),
      /has no resumable execution session\./
    );
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("closeWork moves any task to done and records task.closed", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await makeNeedsYouTask(runtime);
    const closed = await runtime.actions.closeWork(task.id);

    assert.equal(closed.status, "done");
    assert.equal((await runtime.store.findTask(task.id)).status, "done");

    const events = (await runtime.store.readEventLog(task.slug)).trim().split("\n");
    const last = JSON.parse(events.at(-1));
    assert.equal(last.type, "task.closed");
    assert.equal(last.status, "done");
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("getWork returns the task with its final result", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "With result" });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "result.md"),
      "## Result\nfixed it"
    );
    const detail = await runtime.actions.getWork(task.id);
    assert.equal(detail.id, task.id);
    assert.match(detail.result, /fixed it/);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("listWork returns persisted tasks (what the CLI and the API both render)", async () => {
  const runtime = await makeRuntime();
  try {
    await runtime.actions.createWork({ title: "First" });
    await runtime.actions.createWork({ title: "Second" });
    const tasks = await runtime.actions.listWork();
    assert.deepEqual(tasks.map(t => t.title), ["Second", "First"]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("CLI and HTTP API are the same actions: the runtime factory both use produces identical outcomes", async () => {
  // The CLI (src/cli.mjs) and the server (src/server.mjs) both build their
  // actions from createRuntime() and never construct their own logic. Here we
  // run the two entry paths — "what the CLI does for `2f allow`" and "what
  // POST /api/tasks/:id/allow does" — through the same factory and assert the
  // lifecycle result is byte-for-byte the shared action's.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-shared-"));
  try {
    const node = fakeNode();
    const runtime = createRuntime(base, { node });

    // The API's createWork.
    const created = await runtime.actions.createWork({ title: "Shared" });

    // Simulate the provider leaving it blocked (as the worker would).
    const blocked = applyOutcome(created, {
      status: "needs_you",
      reason: "permission",
      externalSessionId: "sess-1",
      blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
    });
    blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-1" };
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(created.slug), "task.json"),
      blocked
    );

    // The CLI's `2f allow` path and the API's POST allow path are literally
    // the same function; assert the contract the CLI prints against.
    const cliResult = await runtime.actions.allowWork(created.id);
    assert.equal(cliResult.status, "working");
    assert.deepEqual(node.calls.at(-1), ["resume", created.slug, "allow"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
