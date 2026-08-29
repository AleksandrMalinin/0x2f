// Phone ACCEPT / remote state-changing action settlement (item 2).
//
// The phone's remote command round-trip must NEVER hang forever: a relay
// response lost in transit used to leave the action promise pending
// indefinitely and the control surface stuck "disabled". The remote client
// now bounds every command with an AbortController and settles with an
// honest error — so the caller can reconcile with the Mac's authoritative
// state (the app reloads tasks after every remote POST, success or failure).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deriveKeyRaw, importKey, b64encode } from "../src/web/e2e.mjs";
import { createRemoteClient } from "../src/web/remote.mjs";

// A relay that accepts POST /api/command but NEVER responds — the lost-
// response condition the timeout backstops. Each accepted request is kept
// open until the client aborts it.
async function hangingRelay(t) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/command") {
      // Intentionally never write a response; the socket stays open.
      req.resume();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function makeClient(t, relayUrl, timeoutMs) {
  const raw = await deriveKeyRaw("PAIRCODE-TEST-020", "token-020");
  const key = await importKey(raw);
  const state = {
    relayUrl,
    session: "session-020",
    phoneId: "phone-020",
    deviceId: "device-020",
    key: b64encode(raw)
  };
  const client = await createRemoteClient(state, { commandTimeoutMs: timeoutMs });
  return { client, key };
}

test("a remote command whose response is lost settles with an honest error (never hangs forever)", async t => {
  const relayUrl = await hangingRelay(t);
  const { client } = await makeClient(t, relayUrl, 200);
  const start = Date.now();
  await assert.rejects(
    client.api("/api/tasks/1/close", { method: "POST" }),
    err => {
      assert.match(err.message, /did not respond in time/);
      assert.equal(err.status, 504);
      return true;
    }
  );
  assert.ok(Date.now() - start < 5000, "settled promptly, not after an unbounded hang");
});

test("the timeout error is surfaced, not silently retried into a double action", async t => {
  const relayUrl = await hangingRelay(t);
  const { client } = await makeClient(t, relayUrl, 150);
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    attempts += 1;
    // The retry loop only retries 503s; a lost response must NOT be retried
    // (the Mac may already have executed the action). Assert the real fetch
    // was called exactly once per command.
    return originalFetch(...args);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await assert.rejects(client.api("/api/tasks/1/close", { method: "POST" }));
  await new Promise(r => setTimeout(r, 400)); // let any (wrong) retry fire
  assert.equal(attempts, 1, "a lost response is surfaced, never retried");
});
