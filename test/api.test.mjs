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
  const handle = await startServer(base, 0, { runtime, interval: 20 });
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
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

    const list = await fetch(handle.url + "/api/tasks").then(r => r.json());
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "List me");

    const detail = await fetch(handle.url + "/api/tasks/" + created.id).then(r => r.json());
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
    const unknown = await fetch(handle.url + "/api/nope");
    assert.equal(unknown.status, 404);
    const missing = await fetch(handle.url + "/api/tasks/999");
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
    const streamRes = await fetch(handle.url + "/api/events", { signal: controller.signal });
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
    const page = await fetch(handle.url + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    // The shell is a shell: it loads the client module, it does not inline
    // a copy of the UI.
    assert.match(html, /<script type="module" src="\/app\/app.js">/);
    assert.match(html, /0x2F/);

    for (const path of ["/app/app.js", "/app/ledger.mjs"]) {
      const asset = await fetch(handle.url + path);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get("content-type"), /javascript/);
    }

    // The browser imports the SAME projection module the tests import.
    const ledger = await fetch(handle.url + "/app/ledger.mjs").then(r => r.text());
    assert.match(ledger, /export function projectLedger/);

    // Nothing outside the allowlist is reachable.
    const escape = await fetch(handle.url + "/app/../server.mjs");
    assert.equal(escape.status, 404);
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

    const history = await fetch(handle.url + "/api/events/history").then(r => r.json());
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
    const history = await fetch(handle.url + "/api/events/history").then(r => r.json());
    assert.deepEqual(history.events[String(task.id)], []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("GET /api/providers lists the registry (default first) with normalized capabilities", async () => {
  const { base, handle } = await startTestServer();
  try {
    const providers = await fetch(handle.url + "/api/providers").then(r => r.json());
    assert.deepEqual(
      providers.map(p => p.id),
      ["claude-code", "deepseek-harness"]
    );
    const dsh = providers.find(p => p.id === "deepseek-harness");
    assert.equal(dsh.displayName, "DeepSeek Harness");
    assert.equal(dsh.capabilities.supportsResume, false);
    assert.equal(dsh.capabilities.supportsStructuredEvents, false);
    const cc = providers.find(p => p.id === "claude-code");
    assert.equal(cc.capabilities.supportsResume, true);
    // No vendor internals leak through the API.
    for (const p of providers) {
      assert.deepEqual(Object.keys(p).sort(), ["capabilities", "displayName", "id"]);
    }
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("POST /api/tasks creates through the selected provider", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", {
      title: "DSH task",
      provider: "deepseek-harness"
    });
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

    const res = await postJson(handle.url + "/api/tasks/" + task.id + "/rerun", {
      provider: "deepseek-harness"
    });
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

test("GET /api/tasks/:id/runs/:n returns one run with its own result; unknown run -> 404", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ title: "Run detail" });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
      "run one's own result"
    );

    const run = await fetch(handle.url + "/api/tasks/" + task.id + "/runs/1").then(r => r.json());
    assert.equal(run.run, 1);
    assert.equal(run.provider, "claude-code");
    assert.equal(run.result, "run one's own result");
    assert.equal(run.outcome, "working");

    const missing = await fetch(handle.url + "/api/tasks/" + task.id + "/runs/9");
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
    const detail = await fetch(handle.url + "/api/tasks/" + task.id).then(r => r.json());
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].run, 1);
    assert.equal(detail.runs[0].provider, "claude-code");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
