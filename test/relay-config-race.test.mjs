// The relay agent's config snapshot — no use-after-null across an await.
//
// REGRESSION: `cfg` is module-level in src/relay/agent.mjs and the config
// poller reassigns it every CONFIG_POLL_MS, to null when the relay is
// disabled or its config file disappears. `onPairHello` validated `cfg`,
// then did `await writeConfig(cfg)`, then read `cfg.phoneId` twice. A poll
// landing inside that await turned the next line into:
//
//   TypeError: Cannot read properties of null (reading 'phoneId')
//
// The frame handler calls `onRelayFrame(frame)` with no await and no catch
// (src/relay/agent.mjs, the sock "message" handler), so that TypeError
// surfaced as an UNHANDLED REJECTION — which is exactly how these tests
// detect it. It was first seen as an intermittent failure of
// test/relay.test.mjs under full-suite parallel load, where teardown removes
// the temp workspace while the agent is still polling.
//
// The fix: every handler that reads the config across an await (or in a
// deferred callback) captures ONE snapshot and uses it throughout —
// `onPairHello`, `sendEnvelope`, `connect`'s open handler, `onHelloAck`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRelayServer } from "../relay/server.mjs";
import { createRelayAgent } from "../src/relay/agent.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { deriveKeyRaw, importKey, encrypt, decrypt, randomId } from "../src/web/e2e.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const TEST_CODE = "PAIRCODE-RACE-001";

function fakeNode() {
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution() { return 111; },
    async resumeExecution() { return 222; },
    async cancelExecution() {}
  };
}

async function waitFor(condition, message, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${message}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

// A real relay + a real agent with pairing PENDING, plus the phone-side
// material needed to send a genuine signed pair-hello. Deliberately smaller
// than relay.test.mjs's harness: nothing here needs a paired phone, because
// the pairing ceremony is the thing under test.
async function makeHarness(t, { configPollMs = 40 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-relay-race-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const relay = createRelayServer({ dataFile: path.join(base, "state.json"), log: quiet });
  const handle = await relay.start();
  t.after(() => handle.close());

  const configPath = path.join(base, ".work", "relay.json");
  const deviceId = "device-" + Math.random().toString(36).slice(2, 10);
  const token = "pair-" + Math.random().toString(36).slice(2, 18);
  const config = {
    url: handle.url,
    enabled: true,
    deviceId,
    deviceSecret: "secret-" + Math.random().toString(36).slice(2, 14),
    token,
    tokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    code: TEST_CODE,
    pairing: "pending"
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const runtime = createRuntime(base, { node: fakeNode() });
  const agent = createRelayAgent({ runtime, configPath, log: quiet, configPollMs });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(() => handle.state.devices.get(deviceId)?.online === true, "agent to connect");

  // The phone side of the ceremony.
  const key = await importKey(await deriveKeyRaw(TEST_CODE, token));
  const phoneId = "phone-" + Math.random().toString(36).slice(2, 14);
  const claim = await fetch(`${handle.url}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, phoneId })
  });
  assert.ok(claim.ok, "the pairing token should claim");
  const { session } = await claim.json();

  // Send a genuine signed pair-hello. Returns the relay's raw response —
  // the caller decides whether an ack was expected, so a deliberately
  // unanswered ceremony is a normal outcome here, not a thrown error.
  async function sendPairHello() {
    const requestId = randomId();
    const { iv, data } = await encrypt(
      key,
      { cmd: "pair-hello", token, phoneId, ts: Date.now() },
      { from: phoneId, requestId }
    );
    const res = await fetch(`${handle.url}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + session },
      body: JSON.stringify({ requestId, from: phoneId, iv, data })
    });
    if (!res.ok) return { ok: false, status: res.status };
    const frame = await res.json();
    const ack = await decrypt(key, frame, { from: deviceId, requestId });
    return { ok: true, status: res.status, ack };
  }

  return { base, handle, agent, configPath, deviceId, phoneId, sendPairHello };
}

// Collect unhandled rejections for the duration of one test. The original
// bug produced exactly this, because the frame handler neither awaits nor
// catches onRelayFrame.
function collectUnhandledRejections(t) {
  const seen = [];
  const onRejection = reason => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}

// --- the happy path must still work -----------------------------------------
//
// The fix adds a post-write liveness check (`cfg !== config`). If that check
// were too strict it would silently stop confirming NORMAL pairings — the one
// real risk the change introduces — so pin the ordinary ceremony first.

test("a normal pair-hello still confirms: the liveness check does not fire on the happy path", async t => {
  const rejections = collectUnhandledRejections(t);
  const h = await makeHarness(t);

  const { ok, ack } = await h.sendPairHello();
  assert.equal(ok, true, "the relay should forward the pair-hello and return the Mac's ack");
  assert.equal(ack?.ok, true, "the Mac must confirm a valid pairing");
  assert.equal(ack.body.phoneId, h.phoneId);

  await waitFor(() => h.agent.status().pairing === "confirmed", "pairing to be confirmed");
  assert.equal(h.agent.status().phoneId, h.phoneId);
  assert.deepEqual(rejections, [], "a normal ceremony must not reject anything");
});

// `pairing` and `phoneId` are in neither connectionKey nor cryptoKey, so a
// pairing write must NOT cause the poller to swap the config object. This is
// the invariant that makes `cfg !== config` a precise "no longer live" test
// rather than a false alarm on every successful pairing.
test("writing the confirmed pairing does not make the poller swap the config object", async t => {
  const h = await makeHarness(t, { configPollMs: 5 });

  const { ack } = await h.sendPairHello();
  assert.equal(ack?.ok, true);

  // Let many poll ticks run over the freshly written config.
  await new Promise(r => setTimeout(r, 120));
  assert.equal(h.agent.status().pairing, "confirmed", "the pairing must survive repeated polls");
  assert.equal(h.agent.status().phoneId, h.phoneId);
});

// --- the race itself --------------------------------------------------------

test("the config vanishing during the pairing ceremony never throws", async t => {
  const rejections = collectUnhandledRejections(t);

  // Poll as fast as the agent allows, and remove the config at the moment the
  // pair-hello is in flight — the window `writeConfig`'s mkdir + writeFile +
  // chmod opens. Several attempts, because the interleaving is a real race:
  // the assertion is exact (zero unhandled rejections, ever), while landing
  // inside the window is probabilistic. On the unfixed agent this reliably
  // produced "Cannot read properties of null (reading 'phoneId')".
  for (let attempt = 0; attempt < 6; attempt++) {
    const h = await makeHarness(t, { configPollMs: 1 });

    const inFlight = h.sendPairHello();
    await fs.rm(h.configPath, { force: true });
    await inFlight.catch(() => {}); // an unanswered ceremony is a valid outcome

    // Let the poller observe the deletion and settle.
    await new Promise(r => setTimeout(r, 40));

    // Whatever happened, the agent is intact and still answering.
    assert.doesNotThrow(() => h.agent.status(), "status() must remain callable");
  }

  assert.deepEqual(
    rejections.map(r => String(r?.message ?? r)),
    [],
    "no handler may read the config after an await without a snapshot"
  );
});

test("a pair-hello arriving with no live config is refused, not crashed on", async t => {
  const rejections = collectUnhandledRejections(t);
  const h = await makeHarness(t, { configPollMs: 5 });

  // Disable the relay and let the poller null the agent's config.
  await fs.writeFile(
    h.configPath,
    JSON.stringify({ enabled: false }, null, 2) + "\n",
    "utf8"
  );
  await waitFor(() => h.agent.status().url === null, "the agent to drop its config");

  // The ceremony cannot succeed, and must not throw on the way to failing.
  const result = await h.sendPairHello().catch(error => ({ ok: false, threw: error }));
  assert.notEqual(result.ack?.ok, true, "a config-less agent must never confirm a pairing");

  assert.equal(h.agent.status().pairing, null);
  assert.deepEqual(rejections, [], "refusing must be quiet, not an unhandled rejection");
});
