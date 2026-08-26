// LAN-first pairing (v0.5): the phone and the Mac on the same local network,
// no relay, no tunnels, no accounts. These tests drive the REAL runtime +
// REAL mounted relay + REAL agent + REAL phone protocol client over the Mac's
// private LAN address and pin down the security boundary:
//
//   `2f pair` → the runtime serves private-LAN hosts ONLY the static client
//   + the relay protocol (the normal local API is never LAN-reachable);
//   loopback keeps the full local API; foreign hosts stay 403 (DNS-rebinding
//   protection intact); `2f pair --off` (enabled:false) closes the LAN
//   surface; the phone pairs and controls tasks over the LAN through the
//   SAME encrypted protocol the hosted relay uses.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startServer } from "../src/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createTailer } from "../src/core/events.mjs";
import { isPrivateLanIp, detectLanAddress } from "../src/relay/lan.mjs";
import { pairDevice } from "../src/relay/pair.mjs";
import { _forceNobleFallback } from "../src/web/e2e.mjs";
import { TEST_AUTH_TOKEN, authHeaders } from "./helpers.mjs";
import { pairPhone } from "./e2e-phone.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const TEST_CODE = "PAIRCODE-LAN-001";

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

async function writeConfig(base, cfg) {
  const configPath = path.join(base, ".work", "relay.json");
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

// A request to the server with a chosen Host header, so the routing can be
// exercised with a LAN hostname regardless of this machine's real addresses
// (the server binds 0.0.0.0 in LAN mode; we connect via loopback).
function lanReq(port, pathname, { host = "192.168.1.163", method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: { host: `${host}:${port}`, ...headers }
      },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- LAN address helpers -----------------------------------------------------

test("isPrivateLanIp accepts RFC1918 ranges and rejects everything else", () => {
  for (const ok of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.163"]) {
    assert.equal(isPrivateLanIp(ok), true, ok);
  }
  for (const no of ["203.0.113.5", "8.8.8.8", "127.0.0.1", "192.169.1.1", "172.32.0.1", "11.0.0.1", "not-an-ip"]) {
    assert.equal(isPrivateLanIp(no), false, no);
  }
});

test("detectLanAddress finds a private IPv4 and skips internal/loopback", () => {
  const fakeIfaces = () => ({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en1: [{ family: "IPv6", internal: false, address: "fe80::1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.163" }]
  });
  assert.equal(detectLanAddress(fakeIfaces), "192.168.1.163");

  const none = () => ({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] });
  assert.equal(detectLanAddress(none), null);
});

test("LAN re-pair brings the runtime up BEFORE rotating (the runtime hosts the relay)", async t => {
  delete process.env["0X2F_RELAY_URL"];
  delete process.env["0X2F_CLIENT_ORIGIN"];
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-lan-repair-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // A previous LAN pairing exists (deviceSecret set, runtime long gone).
  const configPath = path.join(base, ".work", "relay.json");
  await writeConfig(base, {
    url: "http://192.168.1.163:4242",
    clientOrigin: "http://192.168.1.163:4242",
    transport: "lan",
    enabled: true,
    deviceId: "device-repair",
    deviceSecret: "secret-old",
    token: "pair-old-token",
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    code: "OLDPAIRCODE001",
    pairing: "confirmed"
  });

  // The fake relay answers health (lan up, this workspace), rotate, and the
  // registration poll — and records the ORDER of the calls.
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith("/api/health")) {
      return { ok: true, json: async () => ({ ok: true, mode: "local", base, lan: true }) };
    }
    if (url.includes("/api/devices/rotate")) {
      return { ok: true, json: async () => ({ ok: true, generation: 2 }) };
    }
    return { ok: true, json: async () => ({ registered: true }) };
  };
  const fakeIfaces = () => ({ en0: [{ family: "IPv4", internal: false, address: "192.168.1.163" }] });

  const result = await pairDevice({
    base,
    waitMs: 50,
    pollMs: 10,
    networkInterfaces: fakeIfaces,
    killImpl: async () => {},
    ensure: async () => ({ status: "started", url: "http://127.0.0.1:4242" }),
    fetchImpl
  });

  // The runtime (health probe) was brought up BEFORE the rotate call — the
  // regression: previously rotate ran first and hit a dead LAN relay.
  const healthAt = calls.findIndex(u => u.endsWith("/api/health"));
  const rotateAt = calls.findIndex(u => u.includes("/api/devices/rotate"));
  assert.ok(healthAt >= 0 && rotateAt > healthAt, `health (${healthAt}) must precede rotate (${rotateAt})`);

  const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(cfg.transport, "lan");
  assert.notEqual(cfg.deviceSecret, "secret-old", "the credential was rotated");
  assert.equal(cfg.code, result.code);
  assert.ok(result.url.startsWith("http://192.168.1.163:4242/pair?"));
});

test("LAN pairing falls back to a free port when the requested port is foreign", async t => {
  delete process.env["0X2F_RELAY_URL"];
  delete process.env["0X2F_CLIENT_ORIGIN"];
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-lan-port-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Port 4242 answers as ANOTHER workspace's loopback runtime (the stale
  // runtime from a pre-LAN pairing — the exact situation that used to fail
  // with "Could not rotate ... (fetch failed)"); 4243+ is free.
  const fetchImpl = async url => {
    if (url.endsWith("/api/health") && url.includes(":4242/")) {
      return {
        ok: true,
        json: async () => ({ ok: true, mode: "local", base: "/some/other/workspace" })
      };
    }
    if (url.endsWith("/api/health")) {
      return { ok: true, json: async () => ({ ok: true, mode: "local", base, lan: true }) };
    }
    if (url.includes("/api/devices/rotate")) {
      return { ok: true, json: async () => ({ ok: true, generation: 2 }) };
    }
    return { ok: true, json: async () => ({ registered: true }) };
  };
  const fakeIfaces = () => ({ en0: [{ family: "IPv4", internal: false, address: "192.168.1.163" }] });

  // A previous LAN pairing (deviceSecret) so the rotate path runs.
  await writeConfig(base, {
    url: "http://192.168.1.163:4242",
    clientOrigin: "http://192.168.1.163:4242",
    transport: "lan",
    enabled: true,
    deviceId: "device-port",
    deviceSecret: "secret-port",
    token: "pair-port-token",
    tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    code: "OLDPAIRCODEX02",
    pairing: "confirmed"
  });

  const result = await pairDevice({
    base,
    waitMs: 50,
    pollMs: 10,
    networkInterfaces: fakeIfaces,
    killImpl: async () => {},
    ensure: async () => ({ status: "started", url: "http://127.0.0.1:4243" }),
    fetchImpl
  });

  // The pairing moved to the next free port; the phone opens the printed URL.
  assert.ok(result.url.startsWith("http://192.168.1.163:4243/pair?"), result.url);
  const cfg = JSON.parse(await fs.readFile(path.join(base, ".work", "relay.json"), "utf8"));
  assert.equal(cfg.url, "http://192.168.1.163:4243");
  assert.notEqual(cfg.deviceSecret, "secret-port", "the credential was rotated on the new port");
});

// --- LAN server routing + security boundary ----------------------------------

async function makeLanServer(t, cfg) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-lan-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await writeConfig(base, cfg);
  const handle = await startServer(base, 0, {
    lan: true,
    lanGateTtlMs: 50,
    authToken: TEST_AUTH_TOKEN,
    relayLog: quiet
  });
  t.after(() => handle.close());
  return { base, handle, port: handle.port };
}

test("LAN hosts get the client + relay protocol only; the local API stays loopback-only", async t => {
  const { port } = await makeLanServer(t, {
    enabled: true,
    transport: "lan",
    url: "http://192.168.1.163:0"
  });

  // LAN host: the pairing page and the app are served (no auth cookie — the
  // LAN client uses the relay session, not the per-runtime token).
  const pair = await lanReq(port, "/pair");
  assert.equal(pair.status, 200);
  assert.ok(pair.body.includes("PAIR"));
  assert.equal(pair.headers["set-cookie"], undefined);

  const shell = await lanReq(port, "/");
  assert.equal(shell.status, 200);
  assert.ok(shell.body.includes("0x2f-bootstrap"));

  const app = await lanReq(port, "/app/app.js");
  assert.equal(app.status, 200);
  assert.ok(app.body.includes("0x2F Web"));

  // The pure-JS crypto fallback (no WebCrypto on a plain-http LAN page) is
  // part of the client and must reach the phone.
  const vendor = await lanReq(port, "/app/vendor/@noble/hashes/pbkdf2.js");
  assert.equal(vendor.status, 200);
  assert.ok(vendor.body.includes("pbkdf2"));

  // LAN host: the relay protocol is mounted (claim answers with the relay's
  // own error for an unknown token, not the local API's 404 shape).
  const claim = await lanReq(port, "/api/pair/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "unknown" })
  });
  assert.equal(claim.status, 400);
  assert.ok(claim.body.includes("Pairing code is invalid"));

  // LAN host: the NORMAL local API is NOT served — the relay's session gate
  // answers (401 "Not paired"), never the task list. The health probe (which
  // carries the workspace path) is not served to LAN hosts either.
  const tasks = await lanReq(port, "/api/tasks");
  assert.equal(tasks.status, 401);
  assert.ok(tasks.body.includes("Not paired"));
  const lanHealth = await lanReq(port, "/api/health");
  assert.notEqual(lanHealth.status, 200);
  assert.ok(!lanHealth.body.includes("base"));
  const providers = await lanReq(port, "/api/providers");
  assert.equal(providers.status, 401);
  // The mutation surface is not LAN-reachable either.
  const create = await lanReq(port, "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: "must not run" })
  });
  assert.equal(create.status, 401);

  // Loopback keeps the full local API, token-gated as before.
  const localNoAuth = await lanReq(port, "/api/tasks", { host: "127.0.0.1" });
  assert.equal(localNoAuth.status, 401);
  const localAuth = await lanReq(port, "/api/tasks", {
    host: "127.0.0.1",
    headers: authHeaders()
  });
  assert.equal(localAuth.status, 200);
  // ...and the loopback shell still sets the auth cookie.
  const localShell = await lanReq(port, "/", { host: "127.0.0.1" });
  const cookieText = Array.isArray(localShell.headers["set-cookie"])
    ? localShell.headers["set-cookie"].join("; ")
    : (localShell.headers["set-cookie"] ?? "");
  assert.ok(cookieText.includes("0x2f_auth"));

  // A foreign (DNS-rebinding) host stays 403 whether or not LAN is on.
  const evil = await lanReq(port, "/api/tasks", { host: "evil.example.com" });
  assert.equal(evil.status, 403);
});

test("the LAN surface closes when `2f pair --off` disables the config", async t => {
  const { base, port } = await makeLanServer(t, {
    enabled: true,
    transport: "lan",
    url: "http://192.168.1.163:0"
  });
  assert.equal((await lanReq(port, "/pair")).status, 200);

  // `2f pair --off` writes enabled:false — the gate closes within its TTL.
  await writeConfig(base, {
    enabled: false,
    transport: "lan",
    url: "http://192.168.1.163:0"
  });
  await new Promise(r => setTimeout(r, 120));
  const closed = await lanReq(port, "/pair");
  assert.equal(closed.status, 403);
  const closedApi = await lanReq(port, "/api/pair/claim", { method: "POST" });
  assert.equal(closedApi.status, 403);
  // Loopback is untouched by --off.
  const local = await lanReq(port, "/api/health", { host: "127.0.0.1" });
  assert.equal(local.status, 200);
});

test("health reports lan so `2f pair` knows whether a running runtime serves the phone", async t => {
  const { port } = await makeLanServer(t, {
    enabled: true,
    transport: "lan",
    url: "http://192.168.1.163:0"
  });
  const h = await lanReq(port, "/api/health", { host: "127.0.0.1" });
  assert.equal(h.status, 200);
  assert.ok(JSON.parse(h.body).lan === true);
});

// --- the full LAN phone flow (real protocol, real LAN address) ---------------

test("a phone pairs over the LAN and controls a task; the local API stays off-LAN", async t => {
  const lanIp = detectLanAddress();
  if (!lanIp) {
    t.skip("no private LAN address on this machine");
    return;
  }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-lan-e2e-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const tailer = createTailer({
    interval: 15,
    emit: event => runtime.events.emit(event),
    readLines: makeReadLines(runtime.store)
  });
  tailer.start();

  // The runtime server with the LAN surface mounted (as server-entry starts
  // it after `2f pair` writes the LAN transport). Started before the config
  // so the real port is known; the gate reads the config lazily.
  const handle = await startServer(base, 0, {
    lan: true,
    lanGateTtlMs: 50,
    relayLog: quiet
  });
  t.after(() => handle.close());
  const port = handle.port;

  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-lan-" + Math.random().toString(36).slice(2, 10);
  const deviceSecret = "secret-lan-" + Math.random().toString(36).slice(2, 14);
  const token = "pair-lan-" + Math.random().toString(36).slice(2, 18);
  const relayUrl = `http://${lanIp}:${port}`;
  await writeConfig(base, {
    url: relayUrl,
    clientOrigin: relayUrl,
    transport: "lan",
    enabled: true,
    deviceId,
    deviceSecret,
    token,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: TEST_CODE,
    pairing: "pending"
  });

  // The agent connects outbound to the Mac's own LAN relay (its /ws).
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => {
    agent.stop();
    tailer.stop();
  });
  agent.start();
  await waitFor(
    () => handle.relay.state.devices.get(deviceId)?.online === true,
    "agent to connect to the LAN relay"
  );

  // The phone pairs through the LAN address — the same E2E ceremony as hosted.
  const phone = await pairPhone({ relayUrl, token, deviceId, code: TEST_CODE });
  await waitFor(
    () => handle.relay.state.devices.get(deviceId)?.online === true && agent.status().pairing === "confirmed",
    "pair-hello to be confirmed"
  );
  const status = await phone.status();
  assert.equal(status.mac, "online");

  const snap0 = await phone.snapshot();
  assert.deepEqual(snap0.tasks, []);

  // Encrypted events reach the phone over the LAN (subscribe first, then act).
  const received = [];
  const controller = new AbortController();
  let streamOpen;
  const opened = new Promise(r => (streamOpen = r));
  const stream = phone.events(p => received.push(p), {
    signal: controller.signal,
    onOpen: () => streamOpen()
  });
  await opened;
  const created = await phone.api("/api/tasks", {
    method: "POST",
    body: { brief: "LAN task" }
  });
  await waitFor(() => received.some(p => p.cmd === "event"), "a LAN event", 8000);
  const snap1 = await phone.snapshot();
  assert.ok(snap1.tasks.some(task => task.id === created.id), "task visible to the phone");
  controller.abort();
  await stream.catch(() => {});

  // The normal local API is still not reachable from the LAN host.
  const tasks = await lanReq(port, "/api/tasks", { host: lanIp });
  assert.equal(tasks.status, 401);

  // `2f pair --off` closes the LAN surface (gate TTL is 50ms in tests): the
  // phone can no longer reach the pairing page, the relay API, or its
  // session — everything LAN-bound is refused.
  await writeConfig(base, {
    ...JSON.parse(await fs.readFile(configPath, "utf8")),
    enabled: false
  });
  await new Promise(r => setTimeout(r, 120));
  assert.equal((await lanReq(port, "/pair", { host: lanIp })).status, 403);
  const after = await fetch(`${relayUrl}/api/status`, {
    headers: { authorization: "Bearer " + phone.session }
  });
  assert.equal(after.status, 403);
});

// A phone on a plain-http LAN page has no WebCrypto `subtle` (not a secure
// context) — the client falls back to the vendored pure-JS crypto. This runs
// the FULL pairing + control flow with the fallback forced, proving the LAN
// phone scenario end to end (cross-path compatibility with WebCrypto is
// covered in test/e2e-crypto.test.mjs).
test("the LAN phone flow works with the pure-JS crypto fallback (no WebCrypto subtle)", async t => {
  const lanIp = detectLanAddress();
  if (!lanIp) {
    t.skip("no private LAN address on this machine");
    return;
  }
  _forceNobleFallback(true);
  t.after(() => _forceNobleFallback(false));

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-lan-noble-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const tailer = createTailer({
    interval: 15,
    emit: event => runtime.events.emit(event),
    readLines: makeReadLines(runtime.store)
  });
  tailer.start();
  t.after(() => tailer.stop());

  const handle = await startServer(base, 0, { lan: true, lanGateTtlMs: 50, relayLog: quiet });
  t.after(() => handle.close());
  const port = handle.port;
  const relayUrl = `http://${lanIp}:${port}`;
  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-lan-noble-" + Math.random().toString(36).slice(2, 8);
  const token = "pair-lan-noble-" + Math.random().toString(36).slice(2, 14);
  await writeConfig(base, {
    url: relayUrl,
    clientOrigin: relayUrl,
    transport: "lan",
    enabled: true,
    deviceId,
    deviceSecret: "secret-noble-" + Math.random().toString(36).slice(2, 12),
    token,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: "NOBLECODE00001",
    pairing: "pending"
  });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs: 40 });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(() => handle.relay.state.devices.get(deviceId)?.online === true, "agent up");

  const phone = await pairPhone({ relayUrl, token, deviceId, code: "NOBLECODE00001" });
  await waitFor(() => agent.status().pairing === "confirmed", "pair-hello confirmed");
  assert.equal((await phone.status()).mac, "online");
  const snap = await phone.snapshot();
  assert.deepEqual(snap.tasks, []);
  const created = await phone.api("/api/tasks", { method: "POST", body: { brief: "noble task" } });
  assert.ok(created.id >= 1);
  const snap2 = await phone.snapshot();
  assert.ok(snap2.tasks.some(task => task.id === created.id));
});
