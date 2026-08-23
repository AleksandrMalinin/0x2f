// Interactive ACP permissions — end to end through the REAL worker.
//
// The loop this iteration exists for:
//
//   WORKING
//     ↓  ACP session/request_permission
//   NEEDS YOU   (blockedOn.live — the run's process stays alive)
//     ↓  allowWork / rejectWork  (writes the per-task decision file)
//   the ORIGINAL ACP request is answered in place
//     ↓
//   the SAME session continues  →  READY
//
// The fake ACP agent sends a permission request and waits for the response
// before completing — exactly like a real agent. The worker is the real
// detached worker spawned by the real local node.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";

const FAKE_AGENT = `#!/usr/bin/env node
import readline from "node:readline";
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
let promptId = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  // The response to our permission request.
  if (m.id === 100) {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "sess-e2e", update: { sessionUpdate: "agent_message_chunk", messageId: "m2",
        content: { type: "text", text: "## Result\\ncompleted after the human decided\\n## Needs human decision\\nNone" } } } });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (m.method === "session/cancel") { process.exit(0); }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-acp" }, authMethods: [] } });
    return;
  }
  if (m.method === "session/new") {
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-e2e" } });
    return;
  }
  if (m.method === "session/prompt") {
    promptId = m.id;
    send({ jsonrpc: "2.0", id: 100, method: "session/request_permission", params: {
      sessionId: "sess-e2e",
      toolCall: { toolCallId: "call-1", title: "Edit submit-capture.ts", kind: "edit", locations: [{ path: "/w/src/submit-capture.ts", line: 42 }] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }
      ]
    }});
    return; // wait for the human's decision
  }
});
`;

async function writeFakeAgent(dir) {
  const bin = path.join(dir, "fake-acp-interactive.mjs");
  await fs.writeFile(bin, FAKE_AGENT);
  await fs.chmod(bin, 0o755);
  return bin;
}

async function waitForStatus(runtime, id, expected, opts = {}) {
  const { timeout = 10000, tolerate = [] } = opts;
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    const task = await runtime.store.findTask(id);
    if (task.status === expected) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 60));
  }
}

async function makeInteractiveProject() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-acp-interactive-"));
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-acp-interactive-bins-"));
  const agent = await writeFakeAgent(bins);
  const dir = path.join(base, ".work", "providers");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "acp.json"), JSON.stringify({
    id: "acp",
    displayName: "ACP Agent",
    transport: "acp",
    command: [agent, "--acp"]
    // permissions omitted -> the default "interactive"
  }));
  return { base, bins };
}

test("INTERACTIVE E2E: permission request -> NEEDS YOU -> ALLOW -> the same run continues to READY", async () => {
  const { base, bins } = await makeInteractiveProject();
  try {
    const runtime = createRuntime(base);
    const task = await runtime.actions.createWork({
      title: "Interactive permission flow",
      provider: "acp"
    });

    // The run pauses for the human: needs_you with a LIVE permission block.
    const paused = await waitForStatus(runtime, task.id, "needs_you", {
      tolerate: []
    });
    assert.equal(paused.blockedOn.live, true);
    assert.equal(paused.blockedOn.type, "permission");
    assert.equal(paused.blockedOn.tool, "Edit submit-capture.ts");
    assert.equal(paused.blockedOn.file, "/w/src/submit-capture.ts"); // only what ACP supplied
    assert.equal(paused.blockedOn.canAllow, true);
    assert.equal(paused.blockedOn.canReject, true);
    assert.equal(paused.runs[0].outcome, "needs_you");
    assert.equal(paused.runs[0].blockedOn.live, true);
    assert.equal(paused.execution.externalSessionId, "sess-e2e");

    // The human ALLOWS; the decision goes to the live worker, which answers
    // the ORIGINAL ACP request and continues the SAME session.
    const resumed = await runtime.actions.allowWork(task.id);
    assert.equal(resumed.live, true);
    const done = await waitForStatus(runtime, task.id, "ready", { tolerate: ["needs_you"] });

    // Same session, same run, no restart — attempts stays 1.
    assert.equal(done.runs.length, 1);
    assert.equal(done.runs[0].outcome, "ready");
    assert.equal(done.runs[0].externalSessionId, "sess-e2e");
    assert.equal(done.runs[0].attempts, 1);
    assert.equal(done.execution.externalSessionId, "sess-e2e");
    const result = await fs.readFile(
      path.join(runtime.store.taskDir(task.slug), "result.md"),
      "utf8"
    );
    assert.match(result, /completed after the human decided/);

    // The event log carries the pause and the in-place resolution.
    const events = await runtime.store.readEvents(task.slug);
    assert.ok(events.some(e => e.type === "needs_user" && e.blockedOn?.live));
    assert.ok(events.some(e => e.type === "permission.resolved" && e.grant === "allow"));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(bins, { recursive: true, force: true });
  }
});

test("INTERACTIVE E2E: REJECT answers with the rejection and the run continues", async () => {
  const { base, bins } = await makeInteractiveProject();
  try {
    const runtime = createRuntime(base);
    const task = await runtime.actions.createWork({
      title: "Interactive rejection flow",
      provider: "acp"
    });
    await waitForStatus(runtime, task.id, "needs_you");

    const resumed = await runtime.actions.rejectWork(task.id);
    assert.equal(resumed.live, true);
    const done = await waitForStatus(runtime, task.id, "ready", { tolerate: ["needs_you"] });

    assert.equal(done.runs.length, 1);
    assert.equal(done.runs[0].outcome, "ready");
    assert.equal(done.runs[0].externalSessionId, "sess-e2e");
    const events = await runtime.store.readEvents(task.slug);
    assert.ok(events.some(e => e.type === "permission.resolved" && e.grant === "reject"));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(bins, { recursive: true, force: true });
  }
});
