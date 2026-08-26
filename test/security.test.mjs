// Security tests for the local 0x2F runtime boundary (audit finding C1).
//
// The local API must refuse every attack path a malicious website could use:
// unauthenticated simple requests, form posts, CORS preflights, DNS-rebinding
// Host headers, and same-site-foreign-page requests — and require the
// per-runtime token for anything under /api/. These tests attack the server
// the way an attacker would; the happy path (authenticated browser flow) is
// covered by api.test.mjs and the shell-cookie test below.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import {
  MAX_BODY_BYTES,
  MAX_BRIEF,
  MAX_NOTE,
  MAX_ANSWER
} from "../src/core/limits.mjs";
import { TEST_AUTH_TOKEN, authHeaders } from "./helpers.mjs";

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

async function startTestServer() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-sec-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const handle = await startServer(base, 0, {
    runtime,
    interval: 20,
    authToken: TEST_AUTH_TOKEN
  });
  return { base, node, runtime, handle };
}

// A raw HTTP request so tests can control headers a browser (or fetch) would
// never let a page set: Host (DNS rebinding), Origin, Sec-Fetch-Site.
// `agent: false` — the server refuses oversized bodies by closing the
// connection mid-stream, and a pooled (reused) half-closed socket would make
// the NEXT request arrive malformed.
function rawRequest({ port, path: p, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers, agent: false },
      res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- layer 1: per-runtime authentication -------------------------------------

test("unauthenticated /api requests are refused with 401 — no task can be started", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    // The C1 attack shape: a cross-site "simple request" carries no custom
    // headers and no preflight — and, critically, no SameSite=Strict cookie.
    const simple = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ brief: "Exfiltrate the repo" })
    });
    assert.equal(simple.status, 401);

    const get = await fetch(handle.url + "/api/tasks");
    assert.equal(get.status, 401);
    const status = await fetch(handle.url + "/api/status");
    assert.equal(status.status, 401);
    const sse = await fetch(handle.url + "/api/events");
    assert.equal(sse.status, 401);
    const history = await fetch(handle.url + "/api/events/history");
    assert.equal(history.status, 401);
    const unknown = await fetch(handle.url + "/api/nope");
    assert.equal(unknown.status, 401); // no route disclosure either

    // Nothing ran, nothing was created.
    assert.deepEqual(node.calls, []);
    const tasks = await runtime.store.listTasks();
    assert.deepEqual(tasks, []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a wrong or absent token is refused; the correct token is accepted", async () => {
  const { base, handle } = await startTestServer();
  try {
    const wrong = await fetch(handle.url + "/api/tasks", {
      headers: { "x-0x2f-auth": "not-the-token" }
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(handle.url + "/api/tasks", {
      headers: authHeaders()
    });
    assert.equal(ok.status, 200);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the shell issues the per-runtime auth cookie, and the cookie authenticates the API (the browser flow)", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const page = await fetch(handle.url + "/");
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^0x2f_auth=${TEST_AUTH_TOKEN}`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);

    // A browser would now attach that cookie to same-origin requests —
    // including the SSE stream, which cannot carry custom headers.
    const cookie = "0x2f_auth=" + TEST_AUTH_TOKEN;
    const created = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ brief: "Via cookie" })
    });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.deepEqual(node.calls, [["start", task.slug]]);

    const sse = await fetch(handle.url + "/api/events", { headers: { cookie } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type"), /text\/event-stream/);
    sse.body?.cancel?.().catch(() => {});
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- layer 2: Host allowlist (DNS rebinding) --------------------------------

test("a foreign Host header (DNS rebinding) is refused on every route", async () => {
  const { base, handle } = await startTestServer();
  try {
    for (const host of ["evil.example", "192.168.1.5", "attacker.com:4242"]) {
      const shell = await rawRequest({
        port: handle.port,
        path: "/",
        headers: { host }
      });
      assert.equal(shell.status, 403, `shell with Host ${host}`);
      const api = await rawRequest({
        port: handle.port,
        path: "/api/tasks",
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: JSON.stringify({ brief: "Rebound" })
      });
      assert.equal(api.status, 403, `api with Host ${host}`);
    }

    // The loopback aliases the server actually answers for.
    const localhost = await rawRequest({
      port: handle.port,
      path: "/api/health",
      headers: { host: `localhost:${handle.port}` }
    });
    assert.equal(localhost.status, 200);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- layer 3: Origin / Sec-Fetch-Site (browser request validation) ----------

test("cross-origin requests are refused even with a valid token", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const attrs = { "content-type": "application/json", ...authHeaders() };

    // A foreign website's origin.
    const evil = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { ...attrs, origin: "https://evil.example" },
      body: JSON.stringify({ brief: "From evil" })
    });
    assert.equal(evil.status, 403);

    // Another page on the SAME machine (127.0.0.1:9999): same-site for
    // SameSite cookies, but not our origin — refused by the Origin check.
    const localOtherPort = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { ...attrs, origin: "http://127.0.0.1:9999" },
      body: JSON.stringify({ brief: "From local port" })
    });
    assert.equal(localOtherPort.status, 403);

    // A CORS preflight from a foreign origin.
    const preflight = await rawRequest({
      port: handle.port,
      path: "/api/tasks",
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST"
      }
    });
    assert.equal(preflight.status, 403);

    // A same-origin request (what the real UI sends) is accepted.
    const sameOrigin = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { ...attrs, origin: handle.url },
      body: JSON.stringify({ brief: "Same origin" })
    });
    assert.equal(sameOrigin.status, 201);

    assert.deepEqual(
      node.calls.map(c => c[0]),
      ["start"]
    );
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("Sec-Fetch-Site: cross-site and same-site browser requests are refused", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const attrs = { "content-type": "application/json", ...authHeaders() };

    for (const site of ["cross-site", "same-site"]) {
      const res = await fetch(handle.url + "/api/tasks", {
        method: "POST",
        headers: { ...attrs, "sec-fetch-site": site },
        body: JSON.stringify({ brief: `Fetch-site ${site}` })
      });
      assert.equal(res.status, 403, site);
    }

    // A form POST navigates with Sec-Fetch-Site: cross-site in the browser.
    const form = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...authHeaders(),
        "sec-fetch-site": "cross-site"
      },
      body: "title=form+attack"
    });
    assert.equal(form.status, 403);

    // The browser's own same-origin fetches carry same-origin and pass.
    const ok = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { ...attrs, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ brief: "Same origin fetch-site" })
    });
    assert.equal(ok.status, 201);

    assert.deepEqual(
      node.calls.map(c => c[0]),
      ["start"]
    );
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the full C1 chain: no unauthenticated or cross-site path starts agent work", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const attempts = [
      // Simple request, no credentials.
      { headers: { "content-type": "text/plain" }, expect: 401 },
      // Simple request, correct token but browser-declared cross-site.
      {
        headers: { "content-type": "text/plain", ...authHeaders(), "sec-fetch-site": "cross-site" },
        expect: 403
      },
      // Form POST, no credentials.
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=attack",
        expect: 401
      }
    ];
    for (const attempt of attempts) {
      const res = await fetch(handle.url + "/api/tasks", {
        method: "POST",
        headers: attempt.headers,
        body: attempt.body ?? JSON.stringify({ brief: "attack" })
      });
      assert.equal(res.status, attempt.expect);
    }
    assert.deepEqual(node.calls, []);
    assert.deepEqual(await runtime.store.listTasks(), []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- layer 4: body and input size limits -------------------------------------

test("request bodies over the cap are refused with 413 (declared and streamed)", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    // Declared length lies about the body — refused before reading.
    const declared = await rawRequest({
      port: handle.port,
      path: "/api/tasks",
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(),
        "content-length": String(MAX_BODY_BYTES + 1)
      },
      body: "{}"
    });
    assert.equal(declared.status, 413);

    // A streamed (chunked) body that actually outgrows the cap. The server
    // refuses as soon as the cap is crossed; because the server closes the
    // connection mid-stream, the client may see the 413 response or the
    // reset (ECONNRESET) — both are a refusal. Either way, nothing runs.
    const streamed = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/api/tasks",
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          agent: false
        },
        res => {
          let data = "";
          res.on("data", c => (data += c));
          res.on("end", () => finish({ status: res.statusCode, body: data }));
        }
      );
      // Give the response a moment to arrive before treating a reset as final.
      req.on("error", () => {
        setTimeout(() => finish({ status: 0, body: "" }), 100);
      });
      const chunk = Buffer.alloc(64 * 1024, "a");
      let sent = 0;
      const pump = () => {
        while (!done && sent < MAX_BODY_BYTES + 64 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        if (!done) req.end();
      };
      pump();
    });
    if (streamed.status === 0) {
      // The connection was reset mid-stream — the server refused the body.
    } else {
      assert.equal(streamed.status, 413);
      assert.match(streamed.body, /too large/);
    }
    assert.deepEqual(node.calls, []);
    assert.deepEqual(await runtime.store.listTasks(), []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("oversized inputs are refused by the shared actions — the CLI and the API share the caps", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    // Action boundary (what the CLI calls):
    await assert.rejects(
      () => runtime.actions.createWork({ brief: "x".repeat(MAX_BRIEF + 1) }),
      /Task brief is too long/
    );
    await assert.rejects(
      () => runtime.actions.createWork({ brief: "t", provider: "p".repeat(201) }),
      /Provider id is too long/
    );
    const task = await runtime.actions.createWork({ brief: "ok" });
    await assert.rejects(
      () => runtime.actions.noteWork(task.id, { note: "n".repeat(MAX_NOTE + 1) }),
      /Note is too long/
    );
    // Answer only applies to a needs_you/decision block — block the task so
    // the length cap (not the state guard) is what refuses.
    const blocked = applyOutcome(task, {
      status: "needs_you",
      reason: "decision",
      blockedOn: { type: "decision", text: "Decide" }
    });
    await runtime.store.updateTask(blocked);
    await assert.rejects(
      () => runtime.actions.answerWork(task.id, { answer: "a".repeat(MAX_ANSWER + 1) }),
      /Answer is too long/
    );

    // API boundary:
    const res = await fetch(handle.url + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ brief: "y".repeat(MAX_BRIEF + 1) })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Task brief is too long/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- unauthenticated surface and headers -------------------------------------

test("the health probe is unauthenticated but Host-guarded; static assets carry the CSP", async () => {
  const { base, handle } = await startTestServer();
  try {
    const health = await fetch(handle.url + "/api/health");
    assert.equal(health.status, 200);
    // Unauthenticated, but the ONLY thing beyond the mode is the workspace
    // path — which the browser shell bootstrap and the AUTHENTICATED
    // /api/status already carry, and which LAN hosts never see (the LAN
    // surface serves the relay protocol, not this route). `2f pair` uses
    // `base` to tell a same-workspace runtime from a foreign one when it must
    // choose a LAN port.
    assert.deepEqual(await health.json(), { ok: true, mode: "local", base });

    const rebound = await rawRequest({
      port: handle.port,
      path: "/api/health",
      headers: { host: "evil.example" }
    });
    assert.equal(rebound.status, 403);

    const shell = await fetch(handle.url + "/");
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
    const html = await shell.text();
    // No external dependencies — the remote font links are gone.
    assert.ok(!html.includes("fonts.googleapis.com"));
    assert.ok(!html.includes("fonts.gstatic.com"));
    // The styles moved to a same-origin stylesheet.
    assert.match(html, /<link rel="stylesheet" href="\/app\/app.css"/);

    const css = await fetch(handle.url + "/app/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.match(css.headers.get("content-security-policy") ?? "", /style-src 'self'/);

    const js = await fetch(handle.url + "/app/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
