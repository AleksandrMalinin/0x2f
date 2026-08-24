// 0x2F Remote Control — the relay + agent working together.
//
// These tests run the REAL relay server (relay/server.mjs) and the REAL
// agent (src/relay/agent.mjs) against a real local runtime with a fake node,
// over real WebSockets and HTTP on ephemeral ports. They prove the control
// loop end to end:
//
//   Mac authenticates outbound → pairing one-time → snapshot matches local →
//   local events reach a remote SSE client → ALLOW/REJECT / NOTE / SEND BACK /
//   ACCEPT through the relay → duplicate requestId cannot double-execute →
//   disconnect/reconnect restores state → offline is explicit, not queued →
//   the local-only API/UI surface is unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { pairDevice, pairOff } from "../src/relay/pair.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { updateRun } from "../src/core/runs.mjs";
import { startServer } from "../src/server.mjs";
import { withFakeBin } from "./helpers.mjs";

const quiet = { log() {}, warn() {}, error() {} };

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
      const logPath = path.join(dir, entry.name, "events.jsonl");
      try {
        const text = await fs.readFile(logPath, "utf8");
        out.push({ slug: entry.name, text });
      } catch {
        /* no event log yet */
      }
    }
    return out;
  };
}

async function writeRelayConfig(configPath, cfg) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

async function waitFor(condition, message, timeout = 4000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for: ${message}`);
    }
    await new Promise(r => setTimeout(r, 15));
  }
}

async function claim(relayUrl, token) {
  const res = await fetch(relayUrl + "/api/pair/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(res.status, 200, "claim should succeed");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/0x2f_session=([^;]+)/);
  assert.ok(match, "claim should set the session cookie");
  return match[1];
}

const withSession = session => ({ cookie: "0x2f_session=" + session });

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {})
  });
}

// The full stack: a real relay, a real agent on a real runtime (fake node),
// a tailer feeding the bus (exactly like the UI runtime), and a paired
// phone session. The Mac is ONLINE.
async function makeHarness(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-"));
  const dataFile = path.join(base, "state.json");
  const relay = createRelayServer({ dataFile, log: quiet });
  const handle = await relay.start();

  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const tailer = createTailer({
    interval: 15,
    emit: event => runtime.events.emit(event),
    readLines: makeReadLines(runtime.store)
  });
  tailer.start();

  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-" + Math.random().toString(36).slice(2, 10);
  const deviceSecret = "secret-" + Math.random().toString(36).slice(2, 14);
  const token = "pair-" + Math.random().toString(36).slice(2, 18);
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret,
    token
  });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  agent.start();
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === true,
    "agent to connect and authenticate outbound"
  );
  const session = await claim(handle.url, token);

  t.after(async () => {
    agent.stop();
    tailer.stop();
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  return { base, handle, node, runtime, agent, configPath, deviceId, deviceSecret, token, session, relayUrl: handle.url };
}

async function makeTask(runtime, title) {
  return runtime.actions.createWork({ title });
}

// A non-live permission block with a resumable session — the resume path
// that ALLOW/REJECT drive remotely (the worker's applyOutcome + session id).
async function blockPermission(runtime, task) {
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "permission",
    externalSessionId: "sess-1",
    blockedOn: {
      type: "permission",
      tool: "Edit",
      file: "src/a.ts",
      plannedChange: "x -> y"
    }
  });
  blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-1" };
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  return blocked;
}

// --- 1. auth + connection ---------------------------------------------------

test("the Mac authenticates outbound and the relay reports it online; unpaired and mismatched hellos are rejected", async t => {
  const { base, dataFile } = await (async () => {
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-auth-"));
    const d = path.join(b, "state.json");
    return { base: b, dataFile: d };
  })();
  const relay = createRelayServer({ dataFile, log: quiet });
  const handle = await relay.start();
  try {
    // An unregistered device with no token is rejected explicitly.
    const unregistered = await rawHello(handle.url, {
      protocolVersion: 1,
      deviceId: "fresh-device",
      requestId: "r1",
      type: "hello",
      payload: { protocolVersion: 1, deviceSecret: "s" }
    });
    assert.equal(unregistered.payload?.ok, false);
    assert.equal(unregistered.payload?.error, "unregistered");

    // A well-formed hello with the wrong protocol version gets a version
    // error, not silence.
    const mismatch = await rawHello(handle.url, {
      protocolVersion: 999,
      deviceId: "fresh-device",
      requestId: "r2",
      type: "hello",
      payload: { protocolVersion: 999, deviceSecret: "s" }
    });
    assert.equal(mismatch.payload?.ok, false);
    assert.match(mismatch.payload?.error ?? "", /protocol mismatch/);

    // A real agent with a token registers and comes online.
    const runtime = createRuntime(base, { node: fakeNode() });
    const configPath = path.join(base, ".work", "relay.json");
    await writeRelayConfig(configPath, {
      url: handle.url,
      enabled: true,
      deviceId: "device-auth",
      deviceSecret: "secret-auth",
      token: "pair-auth"
    });
    const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
    t.after(() => agent.stop());
    agent.start();
    await waitFor(
      () => handle.state.devices.get("device-auth")?.online === true,
      "agent to come online"
    );
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

function rawHello(url, frame) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    const timer = setTimeout(() => done({ error: "timeout" }), 3000);
    ws.on("open", () => ws.send(JSON.stringify(frame)));
    ws.on("message", data => done(JSON.parse(data.toString())));
    ws.on("error", () => done({ error: "socket-error" }));
    ws.on("close", () => done({ error: "closed" }));
  });
}

test("GET /api/status with the session reports the Mac online", async t => {
  const { handle, session, relayUrl } = await makeHarness(t);
  const res = await fetch(relayUrl + "/api/status", { headers: withSession(session) });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.mode, "relay");
  assert.equal(info.mac, "online");
  assert.equal(handle.state.devices.size >= 1, true);
});

// --- 2. pairing is one-time and expires -------------------------------------

test("a pairing token is one-time: a second claim fails", async t => {
  const { handle, token, relayUrl } = await makeHarness(t);
  const second = await postJson(relayUrl + "/api/pair/claim", { token });
  assert.equal(second.status, 400);
  assert.match((await second.json()).error, /invalid, already used, or expired/);
  assert.equal(handle.state.tokens.get(token).claimed, true);
});

test("an expired pairing token cannot be claimed", async t => {
  const { handle, relayUrl } = await makeHarness(t);
  const expired = "pair-expired";
  handle.state.tokens.set(expired, {
    deviceId: handle.state.devices.keys().next().value,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    claimed: false
  });
  const res = await postJson(relayUrl + "/api/pair/claim", { token: expired });
  assert.equal(res.status, 400);
});

// --- 3. snapshot matches local canonical state -------------------------------

test("the relay's last-known snapshot matches the local canonical Task state", async t => {
  const { handle, runtime, agent, deviceId, session, relayUrl } = await makeHarness(t);
  const a = await makeTask(runtime, "First");
  const b = await makeTask(runtime, "Second");
  await waitFor(
    () => (handle.state.devices.get(deviceId)?.tasks ?? []).length === 2,
    "snapshot to include both tasks"
  );

  // Take the Mac offline; reads now come from the bounded cache.
  agent.stop();
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === false,
    "the Mac to go offline"
  );

  const stale = await fetch(relayUrl + "/api/tasks", { headers: withSession(session) });
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("x-0x2f-stale"), "1");
  const cached = await stale.json();
  assert.deepEqual(cached, await runtime.actions.listWork());

  const detail = await fetch(relayUrl + "/api/tasks/" + a.id, { headers: withSession(session) });
  assert.equal(detail.status, 200);
  const cachedDetail = await detail.json();
  assert.equal(cachedDetail.title, "First");
  assert.equal(cachedDetail.result, null); // result text is never cached
});

// --- 4. local events reach the remote client --------------------------------

test("local normalized events reach a remote SSE client through the relay", async t => {
  const { runtime, session, relayUrl } = await makeHarness(t);
  const controller = new AbortController();
  try {
    const streamRes = await fetch(relayUrl + "/api/events", {
      headers: withSession(session),
      signal: controller.signal
    });
    assert.equal(streamRes.status, 200);
    let text = "";
    const reader = streamRes.body.getReader();
    const readLoop = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await waitFor(() => text.includes(": connected"), "SSE to connect");

    await makeTask(runtime, "Live from Mac");
    await waitFor(() => text.includes("event: task.created"), "task.created over SSE");
    const block = text.slice(text.indexOf("event: task.created"));
    assert.match(block, /"type":"task.created"/);
    assert.match(block, /"taskId":1/);

    controller.abort();
    await readLoop.catch(() => {});
  } finally {
    controller.abort();
  }
});

// --- 5–8. the control loop through the relay --------------------------------

test("creating a Task through the relay starts it on the Mac's node", async t => {
  const { node, session, relayUrl } = await makeHarness(t);
  const res = await postJson(relayUrl + "/api/tasks", { title: "From the phone" }, withSession(session));
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.status, "working");
  assert.equal(task.title, "From the phone");
  assert.deepEqual(node.calls.at(-1), ["start", task.slug]);
});

test("ALLOW remotely resumes the same run/session through the shared action", async t => {
  const { runtime, node, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "Blocked");
  await blockPermission(runtime, task);

  const res = await postJson(relayUrl + "/api/tasks/" + task.id + "/allow", {}, withSession(session));
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, "working");
  assert.deepEqual(node.calls.at(-1), ["resume", task.slug, "allow"]);
});

test("REJECT remotely declines the permission and resumes the session", async t => {
  const { runtime, node, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "Blocked again");
  await blockPermission(runtime, task);

  const res = await postJson(relayUrl + "/api/tasks/" + task.id + "/reject", {}, withSession(session));
  assert.equal(res.status, 202);
  assert.deepEqual(node.calls.at(-1), ["resume", task.slug, "reject"]);
});

test("NOTE remotely updates Task context without starting any execution", async t => {
  const { runtime, node, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "Noted");
  const before = node.calls.length;

  const res = await postJson(
    relayUrl + "/api/tasks/" + task.id + "/note",
    { note: "Keep the CLI plain." },
    withSession(session)
  );
  assert.equal(res.status, 202);
  const fresh = await runtime.store.findTask(task.id);
  assert.deepEqual(fresh.context.notes.at(-1)?.text, "Keep the CLI plain.");
  assert.equal(node.calls.length, before); // no execution
});

test("SEND BACK creates a new run through Task Continuity (notes carried into the next prompt)", async t => {
  const { runtime, node, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "Send back");

  // Let run 1 finish as the worker would, and record a correction.
  let done = applyOutcome(task, { status: "ready", result: "first pass" });
  const completedAt = new Date().toISOString();
  done = updateRun(done, 1, {
    outcome: "ready",
    completedAt,
    durationMs: 1000,
    attempts: 1,
    error: undefined,
    blockedOn: undefined
  });
  await runtime.store.writeJson(path.join(runtime.store.taskDir(task.slug), "task.json"), done);
  await runtime.actions.noteWork(task.id, { note: "Make it quieter." });

  const res = await withFakeBin("DSH_BIN", "dsh", () =>
    postJson(
      relayUrl + "/api/tasks/" + task.id + "/rerun",
      { provider: "deepseek-harness" },
      withSession(session)
    )
  );
  assert.equal(res.status, 201);
  const rerun = await res.json();
  assert.equal(rerun.id, task.id);
  assert.equal(rerun.title, "Send back"); // the intent is unchanged
  assert.equal(rerun.status, "working");
  assert.equal(rerun.runs.length, 2);
  assert.equal(rerun.runs[1].provider, "deepseek-harness");
  // The next run's prompt was rebuilt from current Task state — the note is
  // in it, exactly as Task Continuity promises.
  const runPrompt = await runtime.store.readText(
    path.join(runtime.store.taskDir(task.slug), "runs", "2", "prompt.md")
  );
  assert.match(runPrompt, /Make it quieter\./);
  assert.deepEqual(node.calls.at(-1), ["start", task.slug]);
});

test("ACCEPT closes the correct Task remotely", async t => {
  const { runtime, session, relayUrl } = await makeHarness(t);
  const keep = await makeTask(runtime, "Keep");
  const closeMe = await makeTask(runtime, "Close me");

  const res = await postJson(relayUrl + "/api/tasks/" + closeMe.id + "/close", {}, withSession(session));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "done");
  assert.equal((await runtime.store.findTask(closeMe.id)).status, "done");
  assert.equal((await runtime.store.findTask(keep.id)).status, "working");
});

// --- 9. duplicate requestId cannot execute twice -----------------------------

test("a duplicate requestId returns the cached acknowledgement and never runs the action twice", async t => {
  const { runtime, node, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "Dedupe");
  await blockPermission(runtime, task);

  const headers = { ...withSession(session), "x-0x2f-request-id": "dup-allow-1" };
  const first = await postJson(relayUrl + "/api/tasks/" + task.id + "/allow", {}, headers);
  const second = await postJson(relayUrl + "/api/tasks/" + task.id + "/allow", {}, headers);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  // Only ONE resume happened — the second delivery was answered from the
  // agent's bounded idempotency cache.
  assert.equal(node.calls.filter(c => c[0] === "resume").length, 1);

  // Distinct requestIds are distinct commands.
  const headers2 = { ...withSession(session), "x-0x2f-request-id": "dup-allow-2" };
  await blockPermission(runtime, await runtime.store.findTask(task.id));
  const third = await postJson(relayUrl + "/api/tasks/" + task.id + "/allow", {}, headers2);
  assert.equal(third.status, 202);
  assert.equal(node.calls.filter(c => c[0] === "resume").length, 2);
});

// --- 10–12. disconnect / reconnect / offline ---------------------------------

test("disconnect and reconnect restore the relay's view from local canonical state", async t => {
  const { handle, runtime, agent, deviceId, session, relayUrl, configPath } = await makeHarness(t);
  const first = await makeTask(runtime, "Before disconnect");
  await waitFor(
    () => (handle.state.devices.get(deviceId)?.tasks ?? []).length === 1,
    "first snapshot"
  );

  // Disconnect the Mac; create a task while it is away.
  agent.stop();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === false, "offline");
  await makeTask(runtime, "Created while offline");
  await waitFor(
    () => (handle.state.devices.get(deviceId)?.tasks ?? []).length === 1,
    "cache stays at last-known while offline"
  );

  // A fresh agent (same identity, same config) reconnects and re-pushes the
  // snapshot, so the relay's view is restored from local canonical state.
  const reconnected = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  reconnected.start();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === true, "reconnect");
  await waitFor(
    () => (handle.state.devices.get(deviceId)?.tasks ?? []).length === 2,
    "snapshot restored after reconnect"
  );

  // The stale (offline) read now shows both tasks — canonical state won.
  reconnected.stop();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === false, "offline again");
  const cached = await fetch(relayUrl + "/api/tasks", { headers: withSession(session) }).then(r => r.json());
  assert.deepEqual(cached.map(x => x.title).sort(), ["Before disconnect", "Created while offline"]);
  void first;
});

test("an offline Mac is reported clearly", async t => {
  const { handle, agent, deviceId, session, relayUrl } = await makeHarness(t);
  agent.stop();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === false, "offline");
  const res = await fetch(relayUrl + "/api/status", { headers: withSession(session) });
  const info = await res.json();
  assert.equal(info.mode, "relay");
  assert.equal(info.mac, "offline");
});

test("mutating actions are rejected while the Mac is offline — never queued", async t => {
  const { runtime, agent, session, relayUrl } = await makeHarness(t);
  const task = await makeTask(runtime, "While offline");
  await blockPermission(runtime, task);
  agent.stop();
  await new Promise(r => setTimeout(r, 200));

  const allow = await postJson(relayUrl + "/api/tasks/" + task.id + "/allow", {}, withSession(session));
  assert.equal(allow.status, 503);
  assert.match((await allow.json()).error, /Mac is offline/);

  const rerun = await postJson(relayUrl + "/api/tasks/" + task.id + "/rerun", {}, withSession(session));
  assert.equal(rerun.status, 503);

  const close = await postJson(relayUrl + "/api/tasks/" + task.id + "/close", {}, withSession(session));
  assert.equal(close.status, 503);
});

test("an unpaired session is refused (401)", async t => {
  const { relayUrl } = await makeHarness(t);
  const res = await fetch(relayUrl + "/api/tasks");
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Not paired/);
});

// --- relay restart / persistence --------------------------------------------

test("a relay restart loses no Task state and keeps the phone paired", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-restart-"));
  const dataFile = path.join(base, "state.json");
  const relay1 = createRelayServer({ dataFile, log: quiet });
  const handle1 = await relay1.start();
  let session;
  let agent;
  const deviceId = "device-restart";
  try {
    const runtime = createRuntime(base, { node: fakeNode() });
    const tailer = createTailer({
      interval: 15,
      emit: event => runtime.events.emit(event),
      readLines: makeReadLines(runtime.store)
    });
    tailer.start();
    const configPath = path.join(base, ".work", "relay.json");
    await writeRelayConfig(configPath, {
      url: handle1.url,
      enabled: true,
      deviceId,
      deviceSecret: "secret-restart",
      token: "pair-restart"
    });
    agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
    t.after(() => agent.stop());
    agent.start();
    await waitFor(() => handle1.state.devices.get(deviceId)?.online === true, "online");
    session = await claim(handle1.url, "pair-restart");
    await makeTask(runtime, "Survives restart");
    await waitFor(
      () => (handle1.state.devices.get(deviceId)?.tasks ?? []).length === 1,
      "snapshot"
    );
    tailer.stop();
  } finally {
    await handle1.close();
  }

  // A fresh relay process over the same data file.
  const relay2 = createRelayServer({ dataFile, log: quiet });
  const handle2 = await relay2.start();
  try {
    const res = await fetch(handle2.url + "/api/status", { headers: withSession(session) });
    assert.equal(res.status, 200, "the phone session survives the relay restart");
    const info = await res.json();
    assert.equal(info.mode, "relay");
    assert.equal(info.mac, "offline"); // the Mac reconnects on its own
    assert.equal(info.base, base);

    const tasks = await fetch(handle2.url + "/api/tasks", { headers: withSession(session) });
    const cached = await tasks.json();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].title, "Survives restart");
  } finally {
    await handle2.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- `2f pair` ---------------------------------------------------------------

test("2f pair writes the config, registers the token, and prints the pairing URL", async t => {
  const { base, handle, agent, relayUrl, session } = await makeHarness(t);
  const result = await pairDevice({
    base,
    url: relayUrl,
    waitMs: 5000,
    pollMs: 40,
    ensure: async () => ({ status: "reused", url: relayUrl })
  });
  assert.equal(result.registered, true);
  assert.ok(result.url.startsWith(relayUrl + "/pair/"));
  assert.notEqual(result.token, session); // a fresh token, not the claimed one

  // The config on disk is the agent's source of truth — enabled, stable id.
  const cfg = JSON.parse(await fs.readFile(path.join(base, ".work", "relay.json"), "utf8"));
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.deviceId);
  assert.ok(cfg.deviceSecret);
  assert.equal(cfg.token, result.token);
  void agent;
});

test("2f pair --off disables remote control; the agent goes idle", async t => {
  const { base, handle, agent, deviceId } = await makeHarness(t);
  await pairOff({ base });
  await waitFor(() => handle.state.devices.get(deviceId)?.online === false, "agent to disconnect");
  const cfg = JSON.parse(await fs.readFile(path.join(base, ".work", "relay.json"), "utf8"));
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.token, undefined);
  agent.stop();
});

// --- 13. local-only surface unchanged ----------------------------------------

test("the local server reports mode 'local' — the client keeps its local behavior", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-local-"));
  try {
    const runtime = createRuntime(base, { node: fakeNode() });
    const handle = await startServer(base, 0, { runtime, interval: 20 });
    const res = await fetch(handle.url + "/api/status");
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.mode, "local");
    assert.equal(info.mac, "online");
    assert.equal(info.base, base);
    await handle.close();
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the relay serves the same web client assets as the local server", async t => {
  const { relayUrl, session } = await makeHarness(t);
  const page = await fetch(relayUrl + "/", { headers: withSession(session) });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="module" src="\/app\/app.js">/);

  for (const p of ["/app/app.js", "/app/ledger.mjs", "/app/sound.mjs", "/app/sound-policy.mjs"]) {
    const asset = await fetch(relayUrl + p);
    assert.equal(asset.status, 200, p);
  }

  // No session -> the relay serves the pairing landing page instead.
  const anon = await fetch(relayUrl + "/");
  const anonHtml = await anon.text();
  assert.match(anonHtml, /0X2F \/ PAIR/);

  // The one-time pairing page serves for a token, and polls the public
  // status endpoint until the Mac registers it.
  const pairPage = await fetch(relayUrl + "/pair/some-token");
  const pairHtml = await pairPage.text();
  assert.match(pairHtml, /0X2F \/ PAIR/);
  assert.match(pairHtml, /api\/pair\/claim/);
});
