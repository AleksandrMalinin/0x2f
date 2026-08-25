// Phase 3A adversarial tests: the target security property is that
// compromising the hosted relay alone grants neither execution authority on
// the Mac nor readable remote task content. These tests attack the REAL stack
// (relay + agent + runtime) the way a compromised relay would.
//
// Covered, per the phase requirements:
//   1. relay-forged commands are rejected;
//   2. modified envelopes are rejected;
//   3. captured commands cannot be replayed;
//   4. replay protection survives Mac/runtime restart;
//   5. legitimate retries return the same ack without double execution;
//   6. old/revoked pairing keys cannot execute commands;
//   7. relay state/content holds no task/source/result payloads;
//   8. the remote projection does not leak the sensitive fields;
//   9. the existing remote-control behavior still works end-to-end (the
//      relay.test.mjs suite covers this; one end-to-end flow is re-asserted).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";
import { deriveKeyRaw, importKey, encrypt, decrypt } from "../src/web/e2e.mjs";
import { pairPhone, createPhoneClient } from "./e2e-phone.mjs";
import { projectTask, projectEvent } from "../src/relay/project.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const TEST_CODE = "PAIRCODE-TEST-014";

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return 111;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return 222;
    },
    async cancelExecution() {},
    calls
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
      } catch {
        /* no log yet */
      }
    }
    return out;
  };
}

async function writeRelayConfig(configPath, cfg) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

async function waitFor(condition, message, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${message}`);
    await new Promise(r => setTimeout(r, 15));
  }
}

// A relay + agent + runtime harness WITHOUT a paired phone (for forged/tamper
// tests) plus a variant that returns the full pairing material.
async function makeStack(t, { pair = false } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-e2esec-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataFile = path.join(base, "state.json");
  const relay = createRelayServer({ dataFile, log: quiet, commandTimeoutMs: 4000 });
  const handle = await relay.start();
  t.after(() => handle.close());

  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-" + Math.random().toString(36).slice(2, 10);
  const deviceSecret = "secret-" + Math.random().toString(36).slice(2, 14);
  const token = "pair-" + Math.random().toString(36).slice(2, 18);
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret,
    token,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: TEST_CODE,
    pairing: "pending"
  });

  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const tailer = createTailer({
    interval: 15,
    emit: event => runtime.events.emit(event),
    readLines: makeReadLines(runtime.store)
  });
  tailer.start();
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => {
    agent.stop();
    tailer.stop();
  });
  agent.start();
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === true,
    "agent to connect"
  );

  let phone = null;
  if (pair) {
    phone = await pairPhone({ relayUrl: handle.url, token, deviceId, code: TEST_CODE });
    await waitFor(
      () => agent.status().pairing === "confirmed",
      "pair-hello to be confirmed"
    );
  }
  return { base, dataFile, handle, node, runtime, agent, configPath, deviceId, deviceSecret, token, phone };
}

// POST an envelope to the relay exactly as the phone would, but with arbitrary
// contents — what a malicious relay (which can only forward, never encrypt)
// would be stuck producing.
async function postEnvelope({ relayUrl, session, from, requestId, iv, data }) {
  const res = await fetch(`${relayUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + session },
    body: JSON.stringify({ requestId, from, iv, data })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// --- 1. relay-forged commands are rejected -----------------------------------

test("a relay cannot forge a command: envelopes without the pairing key never execute", async t => {
  const { handle, node, phone, token, deviceId } = await makeStack(t, { pair: true });

  // The attacker holds a DIFFERENT key (e.g. from a separate pairing attempt
  // against the same relay) and tries to create a task as the phone.
  const attackerRaw = await deriveKeyRaw("ATTACKER-CODE-9876", token);
  const attackerKey = await importKey(attackerRaw);
  const attackerPhoneId = "phone-attacker";
  const requestId = "forge-" + Math.random().toString(36).slice(2, 10);
  const { iv, data } = await encrypt(
    attackerKey,
    { cmd: "command", op: "create", body: { title: "Forged task" }, requestId, ts: Date.now() },
    { from: attackerPhoneId, requestId }
  );
  const res = await postEnvelope({
    relayUrl: handle.url,
    session: phone.session,
    from: attackerPhoneId,
    requestId,
    iv,
    data
  });
  // The Mac drops the envelope (bad key) and never acks, so the relay's
  // pending request times out — the attacker gets no valid response either.
  assert.ok(res.status === 200 || res.status === 504, `status ${res.status}`);
  if (res.status === 200) {
    const ack = await decrypt(attackerKey, res.body, { from: deviceId, requestId });
    assert.equal(ack, null, "the Mac never answered the forged envelope");
  }
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(node.calls, [], "no execution happened");
  const tasks = await phone.api("/api/tasks");
  assert.deepEqual(tasks, []);
});

// --- 2. modified envelopes are rejected --------------------------------------

test("a tampered envelope (bit flip in the ciphertext) is rejected", async t => {
  const { handle, node, phone, deviceId } = await makeStack(t, { pair: true });
  const { key, phoneId, session } = phone;

  const requestId = "tamper-" + Math.random().toString(36).slice(2, 10);
  const { iv, data } = await encrypt(
    key,
    { cmd: "command", op: "create", body: { title: "Tampered" }, requestId, ts: Date.now() },
    { from: phoneId, requestId }
  );
  const flipped = data.slice(0, 4) + (data[4] === "A" ? "B" : "A") + data.slice(5);
  const res = await postEnvelope({
    relayUrl: handle.url,
    session,
    from: phoneId,
    requestId,
    iv,
    data: flipped
  });
  assert.ok(res.status === 200 || res.status === 504, `status ${res.status}`);
  if (res.status === 200) {
    const ack = await decrypt(key, res.body, { from: deviceId, requestId });
    assert.equal(ack, null, "the tampered envelope got no verifiable answer");
  }
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(node.calls, []);
});

// --- 3. captured commands cannot be replayed ---------------------------------

test("a captured command envelope cannot be replayed to execute twice", async t => {
  const { node, phone } = await makeStack(t, { pair: true });
  const requestId = "capture-" + Math.random().toString(36).slice(2, 10);

  await phone.command("create", { body: { title: "Once" } }, { requestId });
  // The SAME envelope (same requestId) replayed: the persisted ack cache
  // answers without executing again.
  const again = await phone.command("create", { body: { title: "Once" } }, { requestId });
  assert.equal(again.title, "Once");
  assert.equal(node.calls.length, 1);

  // A NEW requestId with an OLD timestamp is rejected outright (the replay
  // bound once the cache evicts).
  await assert.rejects(
    () =>
      phone.command("create", { body: { title: "Stale" } }, { requestId: "stale-" + Math.random().toString(36).slice(2, 10), ts: Date.now() - 10 * 60 * 1000 }),
    error => error.status === 400 && /stale|replayed/i.test(error.message)
  );
  assert.equal(node.calls.length, 1);
});

// --- 4. replay protection survives Mac restart -------------------------------

test("replay protection survives a Mac/runtime restart (persisted ack cache)", async t => {
  const { handle, configPath, node, phone, agent } = await makeStack(t, { pair: true });
  const requestId = "restart-" + Math.random().toString(36).slice(2, 10);
  await phone.command("create", { body: { title: "Before restart" } }, { requestId });
  assert.equal(node.calls.length, 1);

  // Stop the agent (flushing the ack cache to disk) and wait for the relay to
  // observe the disconnect, then start a fresh one over the same config — the
  // Mac "restarted". (Waiting for the offline transition removes the reconnect
  // race between the old socket's close and the new one's hello.)
  agent.stop();
  await waitFor(
    () => handle.state.devices.get(phone.deviceId)?.online === false,
    "agent to go offline"
  );

  const node2 = fakeNode();
  const runtime2 = createRuntime(path.dirname(path.dirname(configPath)), { node: node2 });
  const tailer2 = createTailer({ interval: 15, emit: () => {}, readLines: async () => [] });
  tailer2.start();
  const agent2 = createRelayAgent({ runtime: runtime2, configPath, log: quiet, configPollMs: 40 });
  t.after(() => {
    agent2.stop();
    tailer2.stop();
  });
  agent2.start();
  await waitFor(
    () => handle.state.devices.get(phone.deviceId)?.online === true,
    "agent to reconnect after restart"
  );
  await new Promise(r => setTimeout(r, 100)); // let the new connection settle

  // The replayed command may hit a transient 503 while the reconnected
  // connection settles — retry with the SAME requestId (as the real client
  // does): the persisted ack cache must answer, never a second execution.
  let replayed = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      replayed = await phone.command("create", { body: { title: "Replay after restart" } }, { requestId });
      break;
    } catch (error) {
      if (error.status !== 503) throw error;
      await new Promise(r => setTimeout(r, 150));
    }
  }
  assert.ok(replayed, "the replay eventually got an ack");
  assert.equal(replayed.title, "Before restart", "the cached ack came back");
  assert.equal(node2.calls.length, 0, "no second execution after restart");
  assert.equal(node.calls.length, 1);
});

// --- 5. legitimate retries return the same ack -------------------------------

test("legitimate retries (same requestId) return the same ack without double execution", async t => {
  const { node, phone } = await makeStack(t, { pair: true });
  const requestId = "retry-" + Math.random().toString(36).slice(2, 10);
  const first = await phone.command("create", { body: { title: "Retry me" } }, { requestId });
  const second = await phone.command("create", { body: { title: "Retry me" } }, { requestId });
  assert.deepEqual(second, first);
  assert.equal(node.calls.length, 1);
});

// --- 6. old/revoked pairing keys cannot execute ------------------------------

test("a re-paired (rotated) Mac rejects envelopes from the old phone key", async t => {
  const { handle, configPath, node, phone, deviceId, deviceSecret } = await makeStack(t, { pair: true });

  // `2f pair` again: rotate the Mac's credential at the relay (authorized by
  // the current deviceSecret) and write a NEW token + code — the Mac rotates
  // the E2E key, retiring the old phone's key.
  const newToken = "pair-new-" + Math.random().toString(36).slice(2, 18);
  const newCode = "NEWCODE-TEST-0142";
  const nextSecret = "secret-new-" + Math.random().toString(36).slice(2, 14);
  const rotated = await fetch(handle.url + "/api/devices/rotate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      deviceSecret,
      nextSecret,
      token: newToken,
      tokenExpiresAt: new Date(Date.now() + 600_000).toISOString()
    })
  });
  assert.equal(rotated.status, 200);
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret: nextSecret,
    token: newToken,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: newCode,
    pairing: "pending"
  });
  // The old phone's SESSION is revoked by the rotation (relay generation bump)
  // — it cannot even reach the Mac anymore.
  const oldRes = await postEnvelope({
    relayUrl: handle.url,
    session: phone.session,
    from: phone.phoneId,
    requestId: "old-session-" + Math.random().toString(36).slice(2, 10),
    iv: "AAAAAAAAAAAAAAAAAAAAAA",
    data: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  });
  assert.equal(oldRes.status, 401, "the old phone's session is revoked");

  // A fresh phone with the NEW code pairs and works.
  const fresh = await pairPhone({ relayUrl: handle.url, token: newToken, deviceId, code: newCode });
  await waitFor(async () => (await fresh.status()).mac === "online", "fresh pair");

  // The old KEY is also dead: with a VALID session, an envelope encrypted
  // with the retired key is dropped by the Mac (no execution, no answer).
  const { iv, data } = await encrypt(
    phone.key,
    { cmd: "command", op: "create", body: { title: "Old key" }, requestId: "old-key", ts: Date.now() },
    { from: phone.phoneId, requestId: "old-key" }
  );
  const before = node.calls.length;
  const oldKeyRes = await postEnvelope({
    relayUrl: handle.url,
    session: fresh.session,
    from: phone.phoneId,
    requestId: "old-key",
    iv,
    data
  });
  assert.ok(oldKeyRes.status === 200 || oldKeyRes.status === 504, `status ${oldKeyRes.status}`);
  if (oldKeyRes.status === 200) {
    const ack = await decrypt(phone.key, oldKeyRes.body, { from: deviceId, requestId: "old-key" });
    assert.equal(ack, null, "the old key got no verifiable answer");
  }
  await new Promise(r => setTimeout(r, 200));
  assert.equal(node.calls.length, before, "the old key never executed");

  const created = await fresh.api("/api/tasks", { method: "POST", body: { title: "Fresh works" } });
  assert.equal(created.title, "Fresh works");
});

// --- 7. relay state holds no task/source/result payloads ---------------------

test("relay state and persisted state hold no task/source/result payloads", async t => {
  const { handle, dataFile, phone } = await makeStack(t, { pair: true });
  const task = await phone.api("/api/tasks", { method: "POST", body: { title: "Top secret task" } });
  await phone.api("/api/tasks/" + task.id + "/close", { method: "POST" });
  await new Promise(r => setTimeout(r, 150));
  await handle.state.flushSave();

  for (const device of handle.state.devices.values()) {
    assert.equal(device.tasks, undefined);
    assert.equal(device.events, undefined);
    assert.equal(device.base, undefined);
  }
  const raw = await fs.readFile(dataFile, "utf8");
  assert.ok(!raw.includes("Top secret task"), "state.json has no task content");
  assert.ok(!raw.includes("tasks"), "state.json has no task fields");
});

// --- 8. the remote projection does not leak sensitive fields -----------------

test("the remote projection drops raw inputs, diffs, session ids, absolute paths and base", () => {
  const base = "/Users/bob/secret/project";

  const task = {
    id: 1,
    title: "t",
    status: "needs_you",
    execution: { provider: "claude-code", node: "local", workspace: "local", externalSessionId: "sess-42", model: "m" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pid: 1234,
    blockedOn: {
      type: "permission",
      tool: "Edit",
      file: base + "/src/a.ts",
      plannedChange: "one → two",
      raw: { tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "one", new_string: "two" } },
      canAllow: true,
      canReject: true,
      live: false,
      options: [{ optionId: "1", name: "Allow", kind: "allow_once" }]
    },
    runs: [
      {
        run: 1,
        provider: "claude-code",
        node: "local",
        workspace: "local",
        externalSessionId: "sess-42",
        model: "m",
        outcome: "needs_you",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        durationMs: 60000,
        attempts: 1,
        requestedProvider: "auto",
        routing: { mode: "auto", reason: "claude-code available" },
        error: undefined,
        blockedOn: undefined
      }
    ],
    context: { notes: [{ at: "2026-01-01T00:00:00.000Z", text: "secret note" }] },
    error: undefined
  };
  const p = projectTask(task, base);
  assert.equal(p.blockedOn.raw, undefined);
  assert.equal(p.blockedOn.file, "src/a.ts"); // relative, not absolute
  assert.equal(p.blockedOn.plannedChange, "one → two"); // the allow/reject summary survives
  assert.equal(p.blockedOn.options[0].kind, "allow_once");
  assert.equal(p.runs[0].externalSessionId, undefined);
  assert.equal(p.runs[0].node, undefined);
  assert.equal(p.runs[0].routing.mode, "auto");
  assert.equal(p.context, undefined);
  assert.equal(p.execution, undefined);
  assert.equal(p.pid, undefined);

  const ev = projectEvent(
    {
      type: "tool.started",
      taskId: 1,
      run: 1,
      at: "2026-01-01T00:00:00.000Z",
      name: "Edit",
      input: { file_path: base + "/src/a.ts", old_string: "one", new_string: "two", extra: "x" }
    },
    base
  );
  assert.equal(ev.input.file_path, "src/a.ts");
  assert.equal(ev.input.old_string, undefined);
  assert.equal(ev.input.new_string, undefined);
  assert.equal(ev.input.extra, undefined);

  const runStarted = projectEvent(
    { type: "run.started", taskId: 1, run: 1, at: "2026-01-01T00:00:00.000Z", sessionId: "sess-42" },
    base
  );
  assert.equal(runStarted.sessionId, undefined);

  // Out-of-workspace paths reduce to a basename — the machine layout never
  // leaves the Mac.
  const outside = projectEvent(
    { type: "file.changed", taskId: 1, run: 1, at: "2026-01-01T00:00:00.000Z", path: "/Users/bob/.ssh/known_hosts" },
    base
  );
  assert.equal(outside.path, "known_hosts");
});

// --- 9. existing remote-control behavior works end-to-end --------------------

test("the full remote-control loop works end-to-end over the E2E channel", async t => {
  const { phone } = await makeStack(t, { pair: true });
  const snap = await phone.snapshot();
  assert.ok(Array.isArray(snap.tasks));
  const created = await phone.api("/api/tasks", { method: "POST", body: { title: "E2E task" } });
  assert.equal(created.status, "working");
  const detail = await phone.api("/api/tasks/" + created.id);
  assert.equal(detail.id, created.id);
  const closed = await phone.api("/api/tasks/" + created.id + "/close", { method: "POST" });
  assert.equal(closed.status, "done");
});
