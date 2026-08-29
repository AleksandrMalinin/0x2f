// The safe user-facing result crosses the relay to the phone (item 3).
//
// Real relay + real agent + real runtime + a PAIRED phone speaking the E2E
// protocol: the phone's snapshot, task detail and run detail all carry the
// written result that already exists on the Mac — while a failed task never
// leaks a stale result.md across the boundary.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { pairPhone } from "./e2e-phone.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const TEST_CODE = "PAIRCODE-TEST-016";

function fakeNode() {
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution() { return 111; },
    async resumeExecution() { return 222; },
    async cancelExecution() {},
    calls: []
  };
}

function makeReadLines(store) {
  return async () => {
    const dir = store.tasksDir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const text = await fs.readFile(path.join(dir, entry.name, "events.jsonl"), "utf8");
        out.push({ slug: entry.name, text });
      } catch {}
    }
    return out;
  };
}

async function writeRelayConfig(configPath, cfg) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

async function waitFor(condition, message, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${message}`);
    await new Promise(r => setTimeout(r, 15));
  }
}

async function makeHarness(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-result-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataFile = path.join(base, "state.json");
  const relay = createRelayServer({ dataFile, log: quiet });
  const handle = await relay.start();
  t.after(() => handle.close());

  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-" + Math.random().toString(36).slice(2, 10);
  const token = "pair-" + Math.random().toString(36).slice(2, 18);
  await writeRelayConfig(configPath, {
    url: handle.url, enabled: true, deviceId,
    deviceSecret: "secret-" + Math.random().toString(36).slice(2, 14),
    token,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: TEST_CODE, pairing: "pending"
  });

  const runtime = createRuntime(base, { node: fakeNode() });
  const tailer = createTailer({ interval: 15, emit: e => runtime.events.emit(e), readLines: makeReadLines(runtime.store) });
  tailer.start();
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => { agent.stop(); tailer.stop(); });
  agent.start();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === true, "agent connect");

  const phone = await pairPhone({ relayUrl: handle.url, token, deviceId, code: TEST_CODE });
  await waitFor(() => agent.status().pairing === "confirmed", "pair confirmed");
  return { runtime, phone };
}

const RESULT = "The startup recovery sweep now anchors to the last persisted event.";

// Mark task 1 ready with a written result the way the worker does: task.json
// via the shared lifecycle, plus result.md and the per-run result file.
async function writeReadyTask(runtime, result = RESULT) {
  const task = await runtime.store.findTask(1);
  const dir = runtime.store.taskDir(task.slug);
  const ready = applyOutcome(task, { status: "ready", result });
  await runtime.store.writeJson(path.join(dir, "task.json"), ready);
  await fs.writeFile(path.join(dir, "result.md"), result, "utf8");
  await fs.mkdir(path.join(dir, "runs", "1"), { recursive: true });
  await fs.writeFile(path.join(dir, "runs", "1", "result.md"), result, "utf8");
  return task;
}

test("the phone sees the safe user-facing result in the snapshot, task detail and run detail", async t => {
  const { runtime, phone } = await makeHarness(t);
  const created = await phone.api("/api/tasks", { method: "POST", body: { brief: "Write a result" } });
  assert.equal(created.id, 1);
  await writeReadyTask(runtime);

  // Snapshot: the phone's initial/cached state now carries the result.
  const snap = await phone.snapshot();
  assert.equal(snap.tasks.find(x => x.id === 1).result, RESULT);

  // Task detail (get op).
  const remote = await phone.api("/api/tasks/1");
  assert.equal(remote.result, RESULT);

  // Run detail (getRun op).
  const run = await phone.api("/api/tasks/1/runs/1");
  assert.equal(run.result, RESULT);
});

test("a failed task never leaks a stale result.md to the phone", async t => {
  const { runtime, phone } = await makeHarness(t);
  const created = await phone.api("/api/tasks", { method: "POST", body: { brief: "Write a result" } });
  assert.equal(created.id, 1);
  await writeReadyTask(runtime);

  // A later run fails: result.md is stale (from the earlier ready run) but
  // the task status is failed — the phone must not see it.
  const task = await runtime.store.findTask(1);
  const dir = runtime.store.taskDir(task.slug);
  const failed = applyOutcome(task, { status: "failed", error: "boom" });
  await runtime.store.writeJson(path.join(dir, "task.json"), failed);

  const remote = await phone.api("/api/tasks/1");
  assert.equal(remote.status, "failed");
  assert.ok(!("result" in remote), "a failed task carries no result across the relay");
  const snap = await phone.snapshot();
  assert.ok(!("result" in snap.tasks.find(x => x.id === 1)));
});
