// Remote control, Phase 3A: the relay is an opaque broker and the phone ↔ Mac
// channel is end-to-end encrypted. These tests drive the REAL relay + REAL
// agent + REAL runtime over the REAL protocol (WebSockets, HTTP, AES-GCM
// envelopes) and prove the remote-control product behavior still works:
//
//   Mac authenticates outbound → phone pairs via a signed pair-hello →
//   snapshot → encrypted commands (create / ALLOW / REJECT / NOTE / ACCEPT) →
//   redacted encrypted events reach the phone → idempotent retries →
//   offline is explicit (503, never queued) → relay restart keeps the phone
//   paired → the relay holds NO task content.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { startServer } from "../src/server.mjs";
import { TEST_AUTH_TOKEN, authHeaders } from "./helpers.mjs";
import { pairPhone, createPhoneClient } from "./e2e-phone.mjs";

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

async function waitFor(condition, message, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${message}`);
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

// The full stack: real relay, real agent on a real runtime (fake node), a
// tailer feeding the bus, and a PAIRED phone speaking the E2E protocol.
async function makeHarness(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataFile = path.join(base, "state.json");
  const relay = createRelayServer({ dataFile, log: quiet });
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

  const phone = await pairPhone({ relayUrl: handle.url, token, deviceId, code: TEST_CODE });
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === true && agent.status().pairing === "confirmed",
    "pair-hello to be confirmed"
  );
  return { base, dataFile, handle, node, runtime, agent, configPath, deviceId, token, phone };
}

// --- hello-level auth (unchanged) -------------------------------------------

test("the Mac authenticates outbound; unpaired and mismatched hellos are rejected", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-auth-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const relay = createRelayServer({ log: quiet });
  const handle = await relay.start();
  t.after(() => handle.close());
  try {
    const unregistered = await rawHello(handle.url, {
      protocolVersion: 2,
      deviceId: "fresh-device",
      requestId: "r1",
      type: "hello",
      payload: { protocolVersion: 2, deviceSecret: "s" }
    });
    assert.equal(unregistered.payload?.ok, false);
    assert.equal(unregistered.payload?.error, "unregistered");
  } finally {
    await handle.close();
  }
});

// --- pairing tokens (unchanged semantics) -----------------------------------

test("a pairing token is one-time: a second claim fails", async t => {
  const { handle, token } = await makeHarness(t);
  const second = await fetch(handle.url + "/api/pair/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(second.status, 400);
  assert.equal(handle.state.tokens.get(token).claimed, true);
});

test("an expired pairing token cannot be claimed", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-exp-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const relay = createRelayServer({ log: quiet });
  const handle = await relay.start();
  t.after(() => handle.close());
  try {
    handle.state.tokens.set("pair-expired-token", {
      deviceId: "d",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      claimed: false
    });
    const res = await fetch(handle.url + "/api/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "pair-expired-token" })
    });
    assert.equal(res.status, 400);
  } finally {
    await handle.close();
  }
});

// --- the E2E remote-control surface -----------------------------------------

test("the phone pairs end-to-end and pulls a redacted snapshot", async t => {
  const { phone } = await makeHarness(t);
  const snap = await phone.snapshot();
  assert.deepEqual(snap.tasks, []);
  assert.ok(Array.isArray(snap.providers));
  assert.ok(snap.providers.some(p => p.id === "claude-code"));
  assert.equal(typeof snap.serverTime, "number");
  phone.setClockOffset(snap.serverTime - Date.now());
  assert.ok(snap.eventsByTask && typeof snap.eventsByTask === "object");
});

test("creating a Task through the encrypted channel starts it on the Mac's node", async t => {
  const { node, phone } = await makeHarness(t);
  const created = await phone.api("/api/tasks", { method: "POST", body: { title: "Remote task" } });
  assert.equal(created.status, "working");
  assert.deepEqual(node.calls.map(c => c[0]), ["start"]);

  const tasks = await phone.api("/api/tasks");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Remote task");
  // The remote projection is redacted: no internal execution metadata.
  assert.equal(tasks[0].provider, "claude-code");
  assert.equal(tasks[0].execution, undefined);
  assert.equal(tasks[0].pid, undefined);
});

test("redacted encrypted events reach the phone; sensitive tool inputs stay on the Mac", async t => {
  const { runtime, phone } = await makeHarness(t);
  const task = await runtime.actions.createWork({ title: "Events" });
  await runtime.store.appendEvent(task.slug, {
    type: "tool.started",
    taskId: task.id,
    at: new Date().toISOString(),
    name: "Edit",
    input: {
      file_path: path.join(runtime.store.base, "src", "secret.ts"),
      old_string: "old secret content",
      new_string: "new secret content",
      extra: "must not leak"
    }
  });

  const received = [];
  const controller = new AbortController();
  const stream = phone.events(plaintext => received.push(plaintext), { signal: controller.signal });
  await waitFor(
    () => received.some(p => p.cmd === "event" && p.event?.type === "tool.started"),
    "tool.started event to arrive"
  );
  controller.abort();
  await stream.catch(() => {});

  const envelope = received.find(p => p.cmd === "event" && p.event?.type === "tool.started");
  const event = envelope.event;
  assert.equal(event.type, "tool.started");
  assert.equal(event.name, "Edit");
  // The single argument survives (relative to the workspace)…
  assert.equal(event.input.file_path, path.join("src", "secret.ts"));
  // …but the complete tool input does not.
  assert.equal(event.input.old_string, undefined);
  assert.equal(event.input.new_string, undefined);
  assert.equal(event.input.extra, undefined);
});

test("ALLOW / REJECT / NOTE / ACCEPT work remotely through the shared actions", async t => {
  const { node, runtime, phone } = await makeHarness(t);

  // ALLOW a live permission block.
  const task = await runtime.actions.createWork({ title: "Blocked" });
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "permission",
    externalSessionId: "sess-1",
    blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
  });
  blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-1" };
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  const allowed = await phone.api("/api/tasks/" + task.id + "/allow", { method: "POST" });
  assert.equal(allowed.status, "working");
  assert.deepEqual(node.calls.at(-1), ["resume", task.slug, "allow"]);

  // NOTE records a constraint without execution. (The stored task is still
  // needs_you — the fake node never runs the worker that would resume it.)
  const noted = await phone.api("/api/tasks/" + task.id + "/note", {
    method: "POST",
    body: { note: "keep it small" }
  });
  assert.equal(noted.context.notes.at(-1).text, "keep it small");
  assert.equal(node.calls.at(-1)[0], "resume"); // no new execution from the note

  // ACCEPT (close) moves the task to done.
  const closed = await phone.api("/api/tasks/" + task.id + "/close", { method: "POST" });
  assert.equal(closed.status, "done");
  assert.deepEqual((await runtime.store.findTask(task.id)).status, "done");
});

test("a duplicate requestId returns the cached acknowledgement and never executes twice", async t => {
  const { node, phone } = await makeHarness(t);
  const requestId = "fixed-rid-" + Math.random().toString(36).slice(2, 10);
  const first = await phone.command("create", { body: { title: "One" } }, { requestId });
  const second = await phone.command("create", { body: { title: "One" } }, { requestId });
  assert.deepEqual(second, first);
  assert.equal(node.calls.length, 1, "the action ran exactly once");
});

test("the Mac is offline: status reports offline and commands answer 503 — never queued", async t => {
  const { agent, phone } = await makeHarness(t);
  agent.stop();
  await waitFor(async () => (await phone.status()).mac === "offline", "mac offline", 5000);
  await assert.rejects(
    () => phone.api("/api/tasks", { method: "POST", body: { title: "Nope" } }),
    error => error.status === 503
  );
});

test("a relay restart loses no session and keeps the phone paired", async t => {
  const { base, dataFile, handle, phone, agent, runtime } = await makeHarness(t);
  await runtime.actions.createWork({ title: "Survives restart" });
  await handle.close();

  // Restart the relay on the SAME port (as a production redeploy would): the
  // Mac's agent reconnects to the same URL and the phone's session survived
  // in the state file.
  const relay2 = createRelayServer({ dataFile, host: "127.0.0.1", port: handle.port, log: quiet });
  const handle2 = await relay2.start();
  t.after(() => handle2.close());
  try {
    await waitFor(() => agent.status().state === "online", "agent to reconnect to the restarted relay");
    const phone2 = createPhoneClient({
      relayUrl: handle2.url,
      session: phone.session,
      phoneId: phone.phoneId,
      deviceId: phone.deviceId,
      key: phone.key
    });
    const status = await phone2.status();
    assert.equal(status.mac, "online");
    const snap = await phone2.snapshot();
    assert.equal(snap.tasks.length, 1);
    assert.equal(snap.tasks[0].title, "Survives restart");
  } finally {
    await handle2.close();
  }
});

test("the relay holds no task content — state and state.json are content-free", async t => {
  const { base, dataFile, handle, phone } = await makeHarness(t);
  await phone.api("/api/tasks", { method: "POST", body: { title: "Secret task" } });
  await new Promise(r => setTimeout(r, 100)); // let the relay settle
  await handle.state.flushSave();

  for (const device of handle.state.devices.values()) {
    assert.equal(device.tasks, undefined);
    assert.equal(device.events, undefined);
    assert.equal(device.base, undefined);
  }
  const raw = await fs.readFile(dataFile, "utf8");
  assert.ok(!raw.includes("Secret task"), "state.json must not contain task content");
  assert.equal(raw.includes("tasks"), false);
});

test("the relay is a broker: it serves no client or pairing page", async t => {
  const { handle } = await makeHarness(t);
  for (const p of ["/", "/pair/some-token", "/app/app.js", "/app/app.css"]) {
    // Unauthenticated requests to the relay get refused (401 at the session
    // gate / 404 for nothing matching) — never the app shell or pairing page.
    const res = await fetch(handle.url + p);
    assert.ok([401, 404].includes(res.status), `${p} -> ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes("0X2F"), `${p} served no client content`);
    assert.ok(!text.includes("<script"), `${p} served no client script`);
  }
});

// --- the local surface is unchanged -----------------------------------------

test("the local server reports mode 'local' — the client keeps its local behavior", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-local-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const runtime = createRuntime(base, { node: fakeNode() });
  const handle = await startServer(base, 0, {
    runtime,
    interval: 20,
    authToken: TEST_AUTH_TOKEN
  });
  t.after(() => handle.close());
  const res = await fetch(handle.url + "/api/status", { headers: authHeaders() });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.mode, "local");
  assert.equal(info.mac, "online");
});

