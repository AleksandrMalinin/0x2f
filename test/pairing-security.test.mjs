// Security tests for pairing, sessions, and device identity (audit findings
// H2/H3 and the phase-2 credential-lifecycle requirements).
//
// These tests exercise the REAL relay + REAL agent over real HTTP/WebSockets
// and pin down: every pairing token expires (including re-pair tokens), phone
// sessions expire and are revoked by `2f pair --off` and by re-pairing, stale
// sessions stay dead after reconnects, deviceSecret rotation is authorized by
// the old secret, plain-HTTP relays are refused except localhost, and the
// credential files are written with restrictive permissions.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { pairDevice, pairOff, validateRelayUrl } from "../src/relay/pair.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";

const quiet = { log() {}, warn() {}, error() {} };

function fakeNode() {
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution() {
      return 111;
    },
    async resumeExecution() {
      return 222;
    },
    async cancelExecution() {}
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

async function waitFor(condition, message, timeout = 4000) {
  const start = Date.now();
  while (!condition()) {
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
  assert.match(setCookie, /Max-Age=/); // sessions must expire
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

// A real relay (optionally with a controllable clock) and a workspace dir.
async function makeRelay(t, opts = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-pairsec-"));
  const dataFile = path.join(base, "state.json");
  const relay = createRelayServer({ dataFile, log: quiet, ...opts });
  const handle = await relay.start();
  t.after(async () => {
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataFile, handle };
}

// A real agent on a real runtime (fake node) connected to `handle`'s relay
// with a fresh identity; the token is claimed so a phone session exists.
async function makePaired(t, handle) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-pairsec-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
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
  const runtime = createRuntime(base, { node: fakeNode() });
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
  const session = await claim(handle.url, token);
  return { base, configPath, deviceId, deviceSecret, token, session, agent, runtime };
}

// Reconnect the Mac with the SAME identity (same deviceId + deviceSecret) —
// what happens after an offline period or a runtime restart, without re-pairing.
function startAgent(t, handle, { configPath, deviceId, deviceSecret, token }) {
  const runtime = createRuntime(path.dirname(path.dirname(configPath)), { node: fakeNode() });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => agent.stop());
  agent.start();
  return agent;
}

// --- every pairing token expires ---------------------------------------------

test("an agent-registered pairing token always has an expiry (never claimable forever)", async t => {
  const fakeNow = { value: Date.now() };
  const { handle } = await makeRelay(t, {
    now: () => fakeNow.value,
    tokenTtlMs: 60_000
  });
  const { token } = await makePaired(t, handle);

  const record = handle.state.tokens.get(token);
  assert.ok(record, "token registered");
  assert.ok(record.expiresAt, "token has an expiry");
  assert.equal(
    Date.parse(record.expiresAt),
    fakeNow.value + 60_000,
    "relay TTL applied when the Mac provides none"
  );
});

test("a re-pair token (rotate-registered) cannot be claimed after it expires", async t => {
  const fakeNow = { value: Date.now() };
  const { handle } = await makeRelay(t, {
    now: () => fakeNow.value,
    tokenTtlMs: 60_000
  });
  const { deviceId, deviceSecret } = await makePaired(t, handle);

  const token = "pair-expiring-" + Math.random().toString(36).slice(2, 10);
  const rotated = await postJson(handle.url + "/api/devices/rotate", {
    deviceId,
    deviceSecret,
    nextSecret: "next-secret-" + Math.random().toString(36).slice(2, 14),
    token,
    tokenExpiresAt: new Date(fakeNow.value + 60_000).toISOString()
  });
  assert.equal(rotated.status, 200);

  fakeNow.value += 61_000; // past the token's expiry
  const late = await postJson(handle.url + "/api/pair/claim", { token });
  assert.equal(late.status, 400, "an expired re-pair token cannot be claimed");
  assert.match((await late.json()).error, /expired/);
});

// --- phone sessions expire and are revocable ---------------------------------

test("a phone session expires after its TTL and stops authenticating", async t => {
  const fakeNow = { value: Date.now() };
  const { handle } = await makeRelay(t, {
    now: () => fakeNow.value,
    sessionTtlMs: 60_000
  });
  const { session } = await makePaired(t, handle);

  const ok = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(ok.status, 200);

  fakeNow.value += 61_000; // the session has expired
  const expired = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(expired.status, 401);
});

test("2f pair --off revokes remote access at the relay: sessions and tokens die immediately", async t => {
  const { handle } = await makeRelay(t);
  const { base, deviceId, token, session } = await makePaired(t, handle);

  const revoked = await pairOff({ base });
  assert.ok(revoked.endsWith("relay.json"));

  // The phone session is dead right away; the pairing token is gone too.
  const res = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(res.status, 401);
  const reuse = await postJson(handle.url + "/api/pair/claim", { token });
  assert.equal(reuse.status, 400);
  assert.equal(handle.state.sessions.size, 0);
  assert.equal(
    [...handle.state.tokens.values()].filter(v => v.deviceId === deviceId).length,
    0
  );
});

test("a stale session stays dead after the Mac reconnects post-revocation", async t => {
  const { handle } = await makeRelay(t);
  const { base, configPath, deviceId, deviceSecret, session, agent } = await makePaired(t, handle);
  await pairOff({ base });
  agent.stop();

  // The Mac comes back with the SAME valid credentials (the identity was not
  // rotated by revocation) — a reconnection, not a re-pairing.
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret,
    token: "pair-reconnect-" + Math.random().toString(36).slice(2, 10)
  });
  startAgent(t, handle, { configPath, deviceId, deviceSecret });
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === true,
    "reconnected agent to come online"
  );

  // The pre-revocation session must NOT silently become valid again.
  const res = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(res.status, 401);
});

// --- re-pairing (rotation) retires the old phone -----------------------------

test("re-pairing (rotate) retires old sessions; only the new token's session works", async t => {
  const { handle } = await makeRelay(t);
  const { deviceId, deviceSecret, session: oldSession } = await makePaired(t, handle);

  const nextSecret = "next-secret-" + Math.random().toString(36).slice(2, 14);
  const newToken = "pair-new-" + Math.random().toString(36).slice(2, 18);
  const rotated = await postJson(handle.url + "/api/devices/rotate", {
    deviceId,
    deviceSecret,
    nextSecret,
    token: newToken,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString()
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.json()).generation, 2);

  // The old phone session is gone; the new token is claimable and works.
  const stale = await fetch(handle.url + "/api/status", { headers: withSession(oldSession) });
  assert.equal(stale.status, 401);
  const newSession = await claim(handle.url, newToken);
  const fresh = await fetch(handle.url + "/api/status", { headers: withSession(newSession) });
  assert.equal(fresh.status, 200);

  // The old secret no longer authenticates; the new one does.
  const oldHello = await rawHello(handle.url, {
    protocolVersion: 1,
    deviceId,
    requestId: "r-old",
    type: "hello",
    payload: { protocolVersion: 1, deviceSecret }
  });
  assert.equal(oldHello.payload?.ok, false);
  const newHello = await rawHello(handle.url, {
    protocolVersion: 1,
    deviceId,
    requestId: "r-new",
    type: "hello",
    payload: { protocolVersion: 1, deviceSecret: nextSecret }
  });
  assert.equal(newHello.payload?.ok, true);
});

test("a plain reconnect (same generation) does NOT revoke the phone session", async t => {
  const { handle } = await makeRelay(t);
  const { base, configPath, deviceId, deviceSecret, session, agent } = await makePaired(t, handle);

  // Mac goes offline; the session stays valid (bounded last-known state).
  agent.stop();
  await waitFor(
    () => ![...handle.state.devices.values()].some(d => d.online),
    "agent to go offline"
  );
  const offline = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(offline.status, 200);

  // Mac reconnects with the SAME credentials — no re-pairing happened, so the
  // SAME session is valid again (the documented product behavior).
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret,
    token: "pair-reconnect-" + Math.random().toString(36).slice(2, 10)
  });
  startAgent(t, handle, { configPath, deviceId, deviceSecret });
  await waitFor(
    () => handle.state.devices.get(deviceId)?.online === true,
    "reconnected agent to come online"
  );
  const back = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(back.status, 200);
  void base;
});

// --- rotation authorization and fresh-identity fallback ----------------------

test("rotation is authorized by the current deviceSecret; a wrong secret changes nothing", async t => {
  const { handle } = await makeRelay(t);
  const { deviceId, deviceSecret, session } = await makePaired(t, handle);

  const bad = await postJson(handle.url + "/api/devices/rotate", {
    deviceId,
    deviceSecret: "wrong-secret",
    nextSecret: "attacker-secret",
    token: "pair-attacker-" + Math.random().toString(36).slice(2, 10)
  });
  assert.equal(bad.status, 401);
  // Nothing changed: the old secret still works, the session is untouched.
  assert.equal(handle.state.devices.get(deviceId).deviceSecret, deviceSecret);
  const ok = await fetch(handle.url + "/api/status", { headers: withSession(session) });
  assert.equal(ok.status, 200);
});

test("2f pair falls back to a fresh identity when the relay rejects the old credential", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-pairsec-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { handle } = await makeRelay(t);

  // The config claims a device the relay has never seen (e.g. relay state was
  // reset). rotate is rejected -> pairDevice starts a fresh identity and the
  // agent's hello registers it.
  const configPath = path.join(base, ".work", "relay.json");
  await writeRelayConfig(configPath, {
    url: handle.url,
    enabled: true,
    deviceId: "device-orphaned",
    deviceSecret: "secret-orphaned",
    token: "pair-orphaned"
  });
  const oldId = JSON.parse(await fs.readFile(configPath, "utf8")).deviceId;

  const result = await pairDevice({
    base,
    url: handle.url,
    waitMs: 1500,
    pollMs: 50,
    ensure: async () => ({ status: "reused", url: handle.url })
  });
  const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.notEqual(cfg.deviceId, oldId, "a fresh identity was created");
  assert.ok(cfg.deviceSecret);
  assert.equal(cfg.token, result.token);

  // The agent picks up the new config and registers at the relay.
  const runtime = createRuntime(base, { node: fakeNode() });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(
    () => handle.state.devices.get(cfg.deviceId)?.online === true,
    "fresh identity to register"
  );
  const info = await fetch(handle.url + "/api/pair/" + cfg.token).then(r => r.json());
  assert.equal(info.registered, true);
});

// --- transport policy --------------------------------------------------------

test("plain-HTTP relay URLs are refused except explicit loopback development", async () => {
  assert.ok(validateRelayUrl("http://192.168.1.5:8080"));
  assert.ok(validateRelayUrl("http://relay.example.com"));
  assert.ok(validateRelayUrl("ftp://relay.example.com"));
  assert.equal(validateRelayUrl("http://127.0.0.1:8080"), null);
  assert.equal(validateRelayUrl("http://localhost:8080"), null);
  assert.equal(validateRelayUrl("http://[::1]:8080"), null);
  assert.equal(validateRelayUrl("https://relay.example.com"), null);
});

test("2f pair refuses a non-loopback plain-HTTP relay; the agent refuses to connect to one", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-pairsec-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      pairDevice({
        base,
        url: "http://192.168.1.5:8080",
        ensure: async () => ({ status: "reused", url: "http://192.168.1.5:8080" })
      }),
    /must use https/
  );

  // A hand-edited config pointing at a plaintext non-loopback relay: the agent
  // goes idle instead of sending the deviceSecret over the wire.
  const { handle } = await makeRelay(t);
  const configPath = path.join(base, ".work", "relay.json");
  await writeRelayConfig(configPath, {
    url: "http://192.168.1.5:9999",
    enabled: true,
    deviceId: "device-plain",
    deviceSecret: "secret-plain",
    token: "pair-plain"
  });
  const runtime = createRuntime(base, { node: fakeNode() });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => agent.stop());
  agent.start();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(agent.status().state, "idle");
  assert.equal(handle.state.devices.has("device-plain"), false);
});

// --- file permissions --------------------------------------------------------

test("relay.json and the relay state file are written with mode 0600", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-pairsec-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const { handle, dataFile } = await makeRelay(t);

  const configPath = path.join(base, ".work", "relay.json");
  await pairDevice({
    base,
    url: handle.url,
    waitMs: 800,
    pollMs: 50,
    ensure: async () => ({ status: "reused", url: handle.url })
  });
  const cfgMode = (await fs.stat(configPath)).mode & 0o777;
  assert.equal(cfgMode, 0o600, "relay.json must be owner-only");

  await handle.state.flushSave();
  const stateMode = (await fs.stat(dataFile)).mode & 0o777;
  assert.equal(stateMode, 0o600, "relay state.json must be owner-only");
});
