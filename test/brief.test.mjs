// The task brief — one field, from the composer to the agent.
//
// DOGFOODING FAILURE: a real ~1,000 character security-audit brief pasted
// into the composer's "What needs doing?" was rejected. The composer's text
// was submitted as the task TITLE, and titles are capped at MAX_TITLE (400)
// — a sane cap for a label and an absurd one for an engineering brief. The
// user was being asked to understand an internal distinction between a task
// title and a task prompt that the interface never showed them.
//
// The model: the user writes ONE thing, the brief. It is persisted verbatim
// as the task's intent and is what the agent receives. The short title a
// ledger row shows is DERIVED from it (core/title.mjs), deterministically,
// with no model call. There is no Title + Description form.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { MAX_BRIEF, MAX_TITLE } from "../src/core/limits.mjs";
import { deriveTitle } from "../src/core/title.mjs";
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
    async resumeExecution() { return 222; },
    async cancelExecution() {},
    calls
  };
}

async function startTestServer() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-brief-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const handle = await startServer(base, 0, { runtime, interval: 20, authToken: TEST_AUTH_TOKEN });
  return { base, node, runtime, handle };
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body ?? {})
  });
}

// The actual shape of the brief that was rejected: a real engineering task,
// well under any sane prose limit and far over a title limit.
const AUDIT_BRIEF = `Audit the authentication boundary for token leakage.

Scope
- every path that reads or writes the per-runtime auth token
- the pairing ceremony and the device secret rotation flow
- the relay projection, which must never carry a session id off the Mac

Constraints
- do not change the wire protocol in this pass
- keep the existing 0600 file modes on anything holding key material
- no new dependencies

Deliverable
A written finding list ordered by severity, each with the concrete file and
line, plus a proposed minimal fix. Where a finding is theoretical rather than
reachable in the current code, say so explicitly and explain what would have
to change for it to become reachable.

Notes
The local API is already gated by four layers (host allowlist, origin check,
per-runtime token, body cap); assume those hold and look for paths that
bypass them rather than re-verifying each one. Pay particular attention to
anything that logs, serializes, or projects a task, since that is where a
secret most plausibly escapes by accident rather than by design.`;

test("REGRESSION: the ~1,000 character brief that dogfooding rejected is accepted", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    assert.ok(AUDIT_BRIEF.length > MAX_TITLE, "the brief must exceed the old title cap to be a regression test");
    assert.ok(AUDIT_BRIEF.length > 700, `expected a realistic brief, got ${AUDIT_BRIEF.length} chars`);

    const res = await postJson(handle.url + "/api/tasks", { brief: AUDIT_BRIEF });
    assert.equal(res.status, 201, "a real engineering brief must not be refused");
    const task = await res.json();

    // The brief is the intent, kept verbatim — every character, every line.
    assert.equal(task.brief, AUDIT_BRIEF);

    // The title is derived and short: the user never wrote one.
    assert.equal(task.title, "Audit the authentication boundary for token leakage.");
    assert.ok(task.title.length <= MAX_TITLE);

    // The AGENT receives the whole brief, never the derived label.
    const prompt = await runtime.store.readText(
      path.join(runtime.store.taskDir(task.slug), "prompt.md"),
      ""
    );
    for (const fragment of [
      "Audit the authentication boundary",
      "the pairing ceremony and the device secret rotation flow",
      "do not change the wire protocol in this pass",
      "ordered by severity"
    ]) {
      assert.ok(prompt.includes(fragment), `the agent's prompt must carry: ${fragment}`);
    }
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("run 1's persisted input carries the full brief, not the title", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const created = await postJson(handle.url + "/api/tasks", { brief: AUDIT_BRIEF }).then(r => r.json());
    const runPrompt = await runtime.store.readRunPrompt(created, 1);
    assert.ok(runPrompt.includes("no new dependencies"), "the per-run input must be the brief, not the label");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a short brief behaves exactly as it did before briefs existed", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { brief: "fix the login redirect" });
    assert.equal(res.status, 201);
    const task = await res.json();
    // Title and brief are the same string — no new concept is visible.
    assert.equal(task.title, "fix the login redirect");
    assert.equal(task.brief, "fix the login redirect");
    assert.deepEqual(node.calls, [["start", task.slug]]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the slug is built from the derived title, so a long brief cannot produce a monstrous directory name", async () => {
  const { base, handle } = await startTestServer();
  try {
    const task = await postJson(handle.url + "/api/tasks", { brief: AUDIT_BRIEF }).then(r => r.json());
    assert.match(task.slug, /^001-audit-the-authentication-boundary/);
    assert.ok(task.slug.length <= 60, `slug should stay short, got ${task.slug.length}`);
    // And it is a real directory on disk.
    const stat = await fs.stat(path.join(base, ".work", "tasks", task.slug));
    assert.ok(stat.isDirectory());
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- the bound is moved to the right tier, not removed ----------------------

test("the brief is bounded: MAX_BRIEF is enforced at the action boundary", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    await assert.rejects(
      () => runtime.actions.createWork({ brief: "x".repeat(MAX_BRIEF + 1) }),
      /Task brief is too long/
    );
    // And exactly at the cap is still accepted — an off-by-one here would
    // reintroduce the same "your real input is rejected" failure.
    const ok = await runtime.actions.createWork({ brief: "x".repeat(MAX_BRIEF) });
    assert.equal(ok.brief.length, MAX_BRIEF);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the brief is bounded at the API boundary too, with the same message", async () => {
  const { base, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { brief: "y".repeat(MAX_BRIEF + 1) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Task brief is too long/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a blank brief is still refused — one required field, clearly named", async () => {
  const { base, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { brief: "   " });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Task brief is required.");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- no model call on the create path ---------------------------------------

test("creating a task derives its title with no provider process at all", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    // Point every provider binary at something that does not exist: if title
    // derivation ever reached for a model, this would fail or hang. Task
    // creation must not depend on a provider being installed OR authenticated
    // — that was the §01 dogfood failure, and it must not come back here.
    const previous = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = "/nonexistent/claude";
    try {
      const task = await runtime.actions.createWork({ brief: AUDIT_BRIEF });
      assert.equal(task.title, "Audit the authentication boundary for token leakage.");
      // Deterministic: the same brief always yields the same title.
      assert.equal(task.title, deriveTitle(AUDIT_BRIEF).title);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = previous;
    }
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- tasks written before `brief` existed -----------------------------------

test("a task created before briefs existed still reads correctly (no migration)", async () => {
  const { base, runtime, handle } = await startTestServer();
  try {
    const task = await runtime.actions.createWork({ brief: "legacy task" });
    // Rewrite it the way the old code did: a title, no brief field at all.
    const legacy = { ...task };
    delete legacy.brief;
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      legacy
    );

    const reread = await runtime.actions.getWork(task.id);
    assert.equal(reread.brief, undefined, "the stored record is genuinely legacy-shaped");
    // Readers fall back to `task.brief ?? task.title`, which is exactly right
    // for a task whose title WAS the full text.
    assert.equal(reread.title, "legacy task");
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
