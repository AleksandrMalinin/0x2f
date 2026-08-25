// Work local API: the Web client talks to the runtime through HTTP + SSE.
// The server is a thin client of the SHARED actions — these tests prove the
// API surface maps 1:1 onto core actions and that live normalized events
// reach SSE subscribers.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { TEST_AUTH_TOKEN, authHeaders, withFakeBin } from "./helpers.mjs";

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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-api-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const handle = await startServer(base, 0, {
    runtime,
    interval: 20,
    authToken: TEST_AUTH_TOKEN
  });
  return { base, node, runtime, handle };
}

async function blockTask(runtime, task) {
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "permission",
    externalSessionId: "sess-1",
    blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts", plannedChange: "x -> y" }
  });
  // Mirror the worker: the outcome's externalSessionId lands on task.execution.
  blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-1" };
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  return blocked;
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {})
  });
}

// Fetch the local API as an authenticated client would.
function apiFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) }
  });
}

async function waitFor(condition, timeout = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await new Promise(r => setTimeout(r, 10));
  }
}

test("POST /api/tasks creates a task through the shared action and starts it on the node", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { title: "API task" });
    assert.equal(res.status, 201);
    const task = await res.json();
    assert.equal(task.status, "working");
    assert.equal(task.execution.provider, "claude-code");
    assert.equal(task.execution.node, "fake-node");
    assert.equal(task.execution.workspace, "local");
    assert.equal(task.pid, 111);
    assert.deepEqual(node.calls, [["start", task.slug]]);
    assert.match(task.slug, /^001-api-task$/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks without a title -> 400 from the shared action", async () => {
  const { base, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { title: "   " });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Task title is required.");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/tasks and GET /api/tasks/:id (with result)", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const created = await runtime.actions.createWork({ title: "List me" });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(created.slug), "result.md"),
      "## Result\nok"
    );

    const list = await apiFetch(handle.url + "/api/tasks").then(r => r.json());
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "List me");

    const detail = await apiFetch(handle.url + "/api/tasks/" + created.id).then(r => r.json());
    assert.equal(detail.id, created.id);
    assert.match(detail.result, /ok/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks/:id/allow and /reject resume via the shared action; guards return 400", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Blocked" });
    await blockTask(runtime, task);

    const allow = await postJson(handle.url + "/api/tasks/" + task.id + "/allow");
    assert.equal(allow.status, 202);
    assert.equal((await allow.json()).status, "working");
    assert.deepEqual(node.calls.at(-1), ["resume", task.slug, "allow"]);

    // Re-block and reject.
    await blockTask(runtime, await runtime.store.findTask(task.id));
    const reject = await postJson(handle.url + "/api/tasks/" + task.id + "/reject");
    assert.equal(reject.status, 202);
    assert.deepEqual(node.calls.at(-1), ["resume", task.slug, "reject"]);

    // Guard: allow on a task that is not needs_you -> the shared action's 400.
    const notBlocked = await runtime.actions.createWork({ title: "Working" });
    const res = await postJson(handle.url + "/api/tasks/" + notBlocked.id + "/allow");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not needs_you — nothing to allow\./);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks/:id/close moves the task to done", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Close me" });
    const res = await postJson(handle.url + "/api/tasks/" + task.id + "/close");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "done");
    assert.equal((await runtime.store.findTask(task.id)).status, "done");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("unknown routes -> 404; missing task -> 404", async () => {
  const { base, handle } = await startTestServer();
  try {
    const unknown = await apiFetch(handle.url + "/api/nope");
    assert.equal(unknown.status, 404);
    const missing = await apiFetch(handle.url + "/api/tasks/999");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "Task 999 not found.");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("server binds to localhost by default (local-first, not LAN-exposed)", async () => {
  const { base, handle } = await startTestServer();
  try {
    assert.ok(handle.url.startsWith("http://127.0.0.1:"));
    assert.equal(handle.server.address().address, "127.0.0.1");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("SSE delivers normalized task.created when a task is created through the API", async () => {
  const { base, handle } = await startTestServer();
  const controller = new AbortController();
  try {
    const streamRes = await apiFetch(handle.url + "/api/events", { signal: controller.signal });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type"), /text\/event-stream/);

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

    // Wait for the SSE connection to be live, then create a task.
    await waitFor(() => text.includes(": connected"));
    const res = await postJson(handle.url + "/api/tasks", { title: "Live task" });
    assert.equal(res.status, 201);

    await waitFor(() => text.includes("event: task.created"));
    const block = text.slice(text.indexOf("event: task.created"));
    assert.match(block, /"type":"task.created"/);
    assert.match(block, /"taskId":1/);
    assert.match(block, /"status":"working"/);

    controller.abort();
    await readLoop.catch(() => {});
  } finally {
    controller.abort();
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET / serves the 0x2F Web shell and its module assets", async () => {
  const { base, handle } = await startTestServer();
  try {
    const page = await apiFetch(handle.url + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    // The shell is a shell: it loads the client module, it does not inline
    // a copy of the UI.
    assert.match(html, /<script type="module" src="\/app\/app.js">/);
    assert.match(html, /0x2F/);

    for (const path of ["/app/app.js", "/app/ledger.mjs", "/app/sound.mjs", "/app/sound-policy.mjs", "/app/app.css", "/app/e2e.mjs", "/app/remote.mjs", "/app/pair.mjs", "/app/pair.css"]) {
      const asset = await apiFetch(handle.url + path);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get("content-type"), /javascript|text\/css/);
    }

    // The pairing page is served by the client origin (the local runtime) —
    // the relay never serves it.
    const pairPage = await apiFetch(handle.url + "/pair");
    assert.equal(pairPage.status, 200);
    assert.match(pairPage.headers.get("content-type"), /text\/html/);
    assert.match(await pairPage.text(), /<script type="module" src="\/app\/pair.mjs">/);

    // The browser imports the SAME projection module the tests import.
    const ledger = await apiFetch(handle.url + "/app/ledger.mjs").then(r => r.text());
    assert.match(ledger, /export function projectLedger/);
    // ... and the SAME sound policy module the tests import.
    const policy = await apiFetch(handle.url + "/app/sound-policy.mjs").then(r => r.text());
    assert.match(policy, /export function createSoundPolicy/);

    // Nothing outside the allowlist is reachable.
    const escape = await apiFetch(handle.url + "/app/../server.mjs");
    assert.equal(escape.status, 404);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the browser client's full module graph is served (no blank-page regressions)", async () => {
  const { base, handle } = await startTestServer();
  try {
    // Walk every module the browser client imports, transitively, and assert
    // each one serves. A single missing module (historically e2e.mjs's
    // /relay/protocol.mjs import) fails the whole ES-module graph and the UI
    // renders blank — individual asset checks never caught that.
    const origin = new URL(handle.url).origin;
    const seen = new Set();
    const queue = ["/app/app.js", "/app/pair.mjs"];
    const specRE = /\bimport\s+(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g;

    while (queue.length) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);

      const res = await apiFetch(handle.url + path);
      assert.equal(res.status, 200, `module must be served: ${path}`);
      const text = await res.text();
      for (const match of text.matchAll(specRE)) {
        const spec = match[1];
        if (!spec || spec.startsWith("http:") || spec.startsWith("https:")) continue;
        const url = new URL(spec, handle.url + path);
        if (url.origin !== origin) continue;
        queue.push(url.pathname);
      }
    }

    // The relay client protocol module the E2E envelope code imports must be
    // part of the graph — the historical blank-page regression.
    assert.ok(
      seen.has("/relay/protocol.mjs"),
      "e2e.mjs's relay protocol import must be served by the local runtime"
    );
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/events/history returns the persisted normalized log per task", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "History" });
    await runtime.store.appendEvent(task.slug, {
      type: "tool.started",
      taskId: task.id,
      at: "2026-01-01T10:00:01.000Z",
      name: "Read",
      input: { file_path: "src/a.ts" }
    });
    await runtime.store.appendEvent(task.slug, "not json\n".trim());

    const history = await apiFetch(handle.url + "/api/events/history").then(r => r.json());
    assert.equal(history.base, base);

    const events = history.events[String(task.id)];
    // task.created (written by the shared action) + the tool step; the
    // unparseable line is skipped exactly as the live tailer skips it.
    assert.deepEqual(events.map(e => e.type), ["task.created", "tool.started"]);
    assert.equal(events[1].name, "Read");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a task with no event log yet is still present in the history", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Quiet" });
    await fs.rm(runtime.store.eventLogPath(task.slug), { force: true });
    const history = await apiFetch(handle.url + "/api/events/history").then(r => r.json());
    assert.deepEqual(history.events[String(task.id)], []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/providers lists the registry (default first) with normalized descriptors", async () => {
  const { base, handle } = await startTestServer();
  try {
    const providers = await apiFetch(handle.url + "/api/providers").then(r => r.json());
    assert.deepEqual(
      providers.map(p => p.id),
      ["claude-code", "deepseek-harness"]
    );
    const dsh = providers.find(p => p.id === "deepseek-harness");
    assert.equal(dsh.displayName, "DeepSeek Harness");
    assert.equal(dsh.integrationType, "native");
    assert.equal(typeof dsh.available, "boolean");
    assert.equal(dsh.capabilities.supportsResume, false);
    assert.equal(dsh.capabilities.supportsStructuredEvents, false);
    const cc = providers.find(p => p.id === "claude-code");
    assert.equal(cc.capabilities.supportsResume, true);
    assert.equal(cc.integrationType, "native");
    // No vendor internals leak through the API.
    for (const p of providers) {
      assert.deepEqual(
        Object.keys(p).sort(),
        ["available", "capabilities", "displayName", "id", "integrationType"]
      );
    }
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks creates through the selected provider", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    // The provider must be available for the selection to be accepted — the
    // action boundary enforces availability, not just the UI.
    const res = await withFakeBin("DSH_BIN", "dsh", () =>
      postJson(handle.url + "/api/tasks", {
        title: "DSH task",
        provider: "deepseek-harness"
      })
    );
    assert.equal(res.status, 201);
    const task = await res.json();
    assert.equal(task.execution.provider, "deepseek-harness");
    assert.equal(task.execution.node, "fake-node");
    assert.deepEqual(node.calls, [["start", task.slug]]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks with an unknown provider -> 400 from the shared action", async () => {
  const { base, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", {
      title: "Nope",
      provider: "codex"
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Unknown execution provider "codex"/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- run history ------------------------------------------------------------

test("POST /api/tasks/:id/rerun starts a second run under the same task through the shared action", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Rerun via API" });
    // Let run 1 finish (as the worker would) so rerun is allowed: apply the
    // outcome and finalize the run record with real timing.
    const { applyOutcome } = await import("../src/core/lifecycle.mjs");
    const { updateRun } = await import("../src/core/runs.mjs");
    let done = applyOutcome(task, { status: "ready", result: "one" });
    const completedAt = new Date().toISOString();
    done = updateRun(done, 1, {
      outcome: "ready",
      completedAt,
      durationMs: 1000,
      attempts: 1,
      error: undefined,
      blockedOn: undefined
    });
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      done
    );

    const res = await withFakeBin("DSH_BIN", "dsh", () =>
      postJson(handle.url + "/api/tasks/" + task.id + "/rerun", {
        provider: "deepseek-harness"
      })
    );
    assert.equal(res.status, 201);
    const rerun = await res.json();
    assert.equal(rerun.id, task.id);
    assert.equal(rerun.title, "Rerun via API"); // the intent is unchanged
    assert.equal(rerun.status, "working");
    assert.equal(rerun.runs.length, 2);
    assert.equal(rerun.runs[0].provider, "claude-code");
    assert.equal(rerun.runs[0].outcome, "ready");
    assert.equal(rerun.runs[1].provider, "deepseek-harness");
    assert.equal(rerun.runs[1].outcome, "working");
    assert.equal(rerun.execution.provider, "deepseek-harness");
    // The node received the second execution request — the API never spawns.
    assert.deepEqual(node.calls, [
      ["start", task.slug],
      ["start", task.slug]
    ]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- the decision continuation flow ----------------------------------------
//
// Dogfooding found the whole path broken: a task blocked on a DECISION could
// be answered, but the task could not then be continued. SEND BACK is a
// body-less POST (no provider override), and the rerun route parsed its body
// with a bare JSON.parse — `JSON.parse("")` threw `Unexpected end of JSON
// input`, which the catch-all turned into a generic 500. The decision was
// recorded and the task was stranded in NEEDS YOU with no way forward.

async function blockOnDecision(runtime, task, question = "Which database?") {
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "decision",
    externalSessionId: "sess-decision",
    blockedOn: { type: "decision", question }
  });
  blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-decision" };
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  return blocked;
}

// A body-less POST — exactly what the Web client's `post()` helper sends for
// SEND BACK, and what used to produce the 500.
function postBodyless(url, headers = {}) {
  return fetch(url, { method: "POST", headers: { ...authHeaders(), ...headers } });
}

test("DECISION FLOW: answer then SEND BACK continues the same task (the dogfooding sequence)", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Decision task" });
    await blockOnDecision(runtime, task);

    // ANSWER records the decision.
    const answerRes = await postJson(handle.url + "/api/tasks/" + task.id + "/answer", {
      answer: "use Postgres"
    });
    assert.equal(answerRes.status, 202);
    const answered = await answerRes.json();
    assert.equal(answered.status, "needs_you");
    assert.deepEqual(
      answered.context.notes.map(n => n.text),
      ["use Postgres"]
    );

    // SEND BACK continues it — a body-less POST, as the browser sends it.
    const res = await postBodyless(handle.url + "/api/tasks/" + task.id + "/rerun");
    assert.equal(res.status, 201, "SEND BACK must succeed after an answer");

    // The response is complete, valid JSON — never an empty/partial body.
    const text = await res.text();
    assert.ok(text.length > 0, "SEND BACK must never answer with an empty body");
    const rerun = JSON.parse(text);

    assert.equal(rerun.status, "working");
    assert.equal(rerun.runs.length, 2, "the answered run stays in history");
    assert.equal(rerun.runs[1].run, 2);
    assert.equal(rerun.blockedOn, undefined, "the decision block is cleared");

    // The recorded answer survives the rerun and is carried into the new run.
    assert.deepEqual(
      rerun.context.notes.map(n => n.text),
      ["use Postgres"]
    );
    const runPrompt = await runtime.store.readRunPrompt(rerun, 2);
    assert.match(
      runPrompt ?? "",
      /use Postgres/,
      "the answer must reach the next run's input"
    );

    assert.deepEqual(node.calls, [
      ["start", task.slug],
      ["start", task.slug]
    ]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DECISION FLOW: a body-less rerun POST is a valid request, not a 500", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Bodyless rerun" });
    await blockOnDecision(runtime, task);

    const res = await postBodyless(handle.url + "/api/tasks/" + task.id + "/rerun");
    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    // The exact historical failure: a generic 500 carrying the parser's message.
    const body = await res.json();
    assert.equal(body.error, undefined);
    assert.notEqual(body.error, "Unexpected end of JSON input");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DECISION FLOW: SEND BACK is idempotent — a retry never starts a duplicate run", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Retry safety" });
    await blockOnDecision(runtime, task);
    await postJson(handle.url + "/api/tasks/" + task.id + "/answer", { answer: "go" });

    // The client mints one key per user gesture; an ambiguous failure makes it
    // retry with the SAME key.
    const key = "req-send-back-once";
    const url = handle.url + "/api/tasks/" + task.id + "/rerun";
    const first = await postBodyless(url, { "x-0x2f-request-id": key });
    const second = await postBodyless(url, { "x-0x2f-request-id": key });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201, "the retry replays the original answer");
    const a = await first.json();
    const b = await second.json();
    assert.deepEqual(b, a, "the retry must return the first attempt's result");

    // Exactly one new run, and exactly one execution on the node.
    assert.equal(a.runs.length, 2);
    const reread = await runtime.actions.getWork(task.id);
    assert.equal(reread.runs.length, 2, "a retry must not append a third run");
    assert.deepEqual(node.calls, [
      ["start", task.slug],
      ["start", task.slug]
    ]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DECISION FLOW: concurrent duplicate SEND BACKs collapse to one run", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Double tap" });
    await blockOnDecision(runtime, task);

    const key = "req-double-tap";
    const url = handle.url + "/api/tasks/" + task.id + "/rerun";
    // Both in flight at once — the second must wait for the first, not race it.
    const [first, second] = await Promise.all([
      postBodyless(url, { "x-0x2f-request-id": key }),
      postBodyless(url, { "x-0x2f-request-id": key })
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(await second.json(), await first.json());

    const reread = await runtime.actions.getWork(task.id);
    assert.equal(reread.runs.length, 2);
    assert.equal(node.calls.length, 2, "one create + one rerun execution");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DECISION FLOW: distinct request ids are distinct gestures", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Fresh keys" });
    await blockOnDecision(runtime, task);
    const url = handle.url + "/api/tasks/" + task.id + "/rerun";

    const first = await postBodyless(url, { "x-0x2f-request-id": "key-one" });
    assert.equal(first.status, 201);

    // A genuinely new gesture is executed, and refused on its own merits —
    // the task is working — rather than silently replaying the first.
    const second = await postBodyless(url, { "x-0x2f-request-id": "key-two" });
    assert.equal(second.status, 400);
    const body = await second.json();
    assert.match(body.error, /working/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("every API failure is explicit, valid JSON (never an empty or partial body)", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Failure shapes" });

    const cases = [
      // Malformed JSON is the client's error — an explicit 400, not a 500.
      [
        "malformed body",
        await fetch(handle.url + "/api/tasks/" + task.id + "/note", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: "{ not json"
        }),
        400
      ],
      // A JSON scalar is not a parameter set.
      [
        "non-object body",
        await fetch(handle.url + "/api/tasks/" + task.id + "/note", {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: '"just a string"'
        }),
        400
      ],
      // An unknown route used to answer with the bare text "Not found".
      ["unknown route", await apiFetch(handle.url + "/api/nope"), 404],
      ["unauthorized", await fetch(handle.url + "/api/tasks"), 401],
      // A refused action from the shared layer.
      [
        "not answerable",
        await postJson(handle.url + "/api/tasks/" + task.id + "/answer", { answer: "x" }),
        400
      ]
    ];

    for (const [label, res, status] of cases) {
      assert.equal(res.status, status, label + ": status");
      assert.match(
        res.headers.get("content-type") ?? "",
        /application\/json/,
        label + ": content-type"
      );
      const text = await res.text();
      assert.ok(text.length > 0, label + ": body must not be empty");
      const body = JSON.parse(text); // must not throw — the historical failure
      assert.equal(typeof body.error, "string", label + ": carries an error string");
      assert.ok(body.error.length > 0, label + ": the error is not blank");
    }
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/tasks/:id/runs/:n returns one run with its own result; unknown run -> 404", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Run detail" });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
      "run one's own result"
    );

    const run = await apiFetch(handle.url + "/api/tasks/" + task.id + "/runs/1").then(r => r.json());
    assert.equal(run.run, 1);
    assert.equal(run.provider, "claude-code");
    assert.equal(run.result, "run one's own result");
    assert.equal(run.outcome, "working");

    const missing = await apiFetch(handle.url + "/api/tasks/" + task.id + "/runs/9");
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /has no run 9/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/tasks/:id includes the projected run history", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "With runs" });
    const detail = await apiFetch(handle.url + "/api/tasks/" + task.id).then(r => r.json());
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].run, 1);
    assert.equal(detail.runs[0].provider, "claude-code");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- decision vs permission over the API ------------------------------------

async function makeDecisionTask(runtime) {
  const task = await withFakeBin("DSH_BIN", "dsh", () =>
    runtime.actions.createWork({
      title: "Decision",
      provider: "deepseek-harness"
    })
  );
  const blocked = applyOutcome(task, {
    status: "needs_you",
    reason: "decision",
    blockedOn: { type: "decision", text: "Keep the CLI plain?" }
  });
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    blocked
  );
  return blocked;
}

test("POST /api/tasks/:id/answer records the human's decision answer", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await makeDecisionTask(runtime);

    const res = await postJson(handle.url + "/api/tasks/" + task.id + "/answer", {
      answer: "TTY-only glyphs"
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, "needs_you"); // answering is not a continuation

    const answer = await runtime.store.readJson(
      path.join(runtime.store.taskDir(task.slug), "answer.json")
    );
    assert.equal(answer.answer, "TTY-only glyphs");
    const events = await runtime.store.readEvents(task.slug);
    assert.ok(events.some(e => e.type === "task.answered" && e.answer === "TTY-only glyphs"));
    // The provider was never invoked: no resume, no second execution.
    assert.deepEqual(node.calls, [["start", task.slug]]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("ALLOW on a decision is refused over the API; ANSWER on a permission is refused", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const decision = await makeDecisionTask(runtime);
    const allowRes = await postJson(handle.url + "/api/tasks/" + decision.id + "/allow");
    assert.equal(allowRes.status, 400);
    assert.match((await allowRes.json()).error, /blocked on a decision, not a permission/);

    // A permission block is answered? No — it is allowed/rejected.
    const permTask = await runtime.actions.createWork({ title: "Perm" });
    const blocked = applyOutcome(permTask, {
      status: "needs_you",
      reason: "permission",
      externalSessionId: "sess-1",
      blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
    });
    blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-1" };
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(permTask.slug), "task.json"),
      blocked
    );
    const answerRes = await postJson(handle.url + "/api/tasks/" + permTask.id + "/answer", {
      answer: "x"
    });
    assert.equal(answerRes.status, 400);
    assert.match((await answerRes.json()).error, /not blocked on a decision/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a non-resumable NEEDS YOU task can be closed over the API without invoking the provider", async () => {
  const { base, node, runtime, handle } = await startTestServer();
  try {
    const task = await makeDecisionTask(runtime);
    const res = await postJson(handle.url + "/api/tasks/" + task.id + "/close");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "done");
    assert.equal((await runtime.store.findTask(task.id)).status, "done");
    // No resume, no new execution attempt — closeWork is not an answer to
    // the agent, it is a statement about the Work.
    assert.deepEqual(node.calls, [["start", task.slug]]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
