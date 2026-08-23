// Run history: Task -> Runs.
//
// A task is the engineering intent; a run is one attempt to execute it
// through (provider, node, model). These tests pin:
//   - the compatibility layer (a legacy task reads as one historical run),
//   - the run record lifecycle (first run at creation, rerun appends, the
//     previous run is never overwritten, outcome + timing persist),
//   - provider capability differences (a DeepSeek Harness run carries less
//     than a Claude Code run — honestly),
//   - the dogfooding loop end-to-end: the SAME task run through both real
//     provider adapters (fake CLIs) through the real worker persists as two
//     runs under one task.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";
import { createStore } from "../src/core/store.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import {
  taskRuns,
  legacyRun,
  legacyOutcome,
  makeRunRecord,
  updateRun,
  currentRunNumber
} from "../src/core/runs.mjs";
import { eventsForRun } from "../src/web/ledger.mjs";

// --- fixtures ---------------------------------------------------------------

const legacyTask = (over = {}) => ({
  id: 9,
  slug: "009-legacy",
  title: "Legacy task",
  status: "ready",
  execution: {
    provider: "claude-code",
    node: "local",
    workspace: "local",
    externalSessionId: "sess-legacy",
    attempts: 2
  },
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:05:00.000Z",
  ...over
});

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return null;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return null;
    },
    async cancelExecution() {},
    calls
  };
}

async function makeRuntime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-runs-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  return { ...runtime, node, base };
}

// The worker applies provider outcomes to a task exactly as it would mid-run:
// apply the outcome, mirror the session onto execution, finalize the run
// record with real timing, and write the state back through the store.
async function applyWorkerOutcome(runtime, task, outcome) {
  let next = applyOutcome(task, outcome);
  if (outcome.externalSessionId) {
    next.execution = {
      ...(next.execution ?? {}),
      provider: task.execution?.provider,
      externalSessionId: outcome.externalSessionId
    };
  }
  const runNumber = currentRunNumber(next);
  const record = next.runs?.find(r => r.run === runNumber);
  if (record) {
    const completedAt = new Date().toISOString();
    const startedMs = Date.parse(record.startedAt);
    next = updateRun(next, runNumber, {
      outcome: next.status,
      completedAt,
      ...(Number.isFinite(startedMs)
        ? { durationMs: Date.parse(completedAt) - startedMs }
        : {}),
      externalSessionId: next.execution?.externalSessionId,
      attempts: next.execution?.attempts ?? record.attempts ?? 1,
      error: next.status === "failed" ? next.error : undefined,
      blockedOn: next.status === "needs_you" ? next.blockedOn : undefined
    });
  }
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    next
  );
  return next;
}

// --- legacy interpretation --------------------------------------------------

test("an existing task (no runs) is interpreted as one historical run without rewriting it", () => {
  const runs = taskRuns(legacyTask());
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.run, 1);
  assert.equal(run.provider, "claude-code");
  assert.equal(run.node, "local");
  assert.equal(run.attempts, 2);
  assert.equal(run.externalSessionId, "sess-legacy");
  assert.equal(run.outcome, "ready");
  assert.equal(run.legacy, true);
  // Timing genuinely unknown without an event log — shown as absent, not guessed.
  assert.equal(run.startedAt, undefined);
  assert.equal(run.durationMs, undefined);
});

test("legacy run timing comes from the real event log when it exists", () => {
  const events = [
    { type: "run.started", at: "2026-01-01T10:00:01.000Z" },
    { type: "tool.started", at: "2026-01-01T10:00:02.000Z" },
    { type: "run.completed", at: "2026-01-01T10:04:13.000Z" }
  ];
  const [run] = taskRuns(legacyTask(), { events });
  assert.equal(run.startedAt, "2026-01-01T10:00:01.000Z");
  assert.equal(run.completedAt, "2026-01-01T10:04:13.000Z");
  assert.equal(run.durationMs, 4 * 60 * 1000 + 12 * 1000);
  assert.equal(run.outcome, "ready");
});

test("legacy outcomes: needs_you / failed / working / done are read from state when no event is terminal", () => {
  assert.equal(
    legacyOutcome(legacyTask({ status: "needs_you", blockedOn: { type: "permission" } })),
    "needs_you"
  );
  assert.equal(legacyOutcome(legacyTask({ status: "failed", error: "boom" })), "failed");
  assert.equal(legacyOutcome(legacyTask({ status: "working" })), "working");
  // done without a terminal event: the documented lifecycle reaches done from
  // ready (accept) or failed; an error string marks the latter.
  assert.equal(legacyOutcome(legacyTask({ status: "done" })), "ready");
  assert.equal(legacyOutcome(legacyTask({ status: "done", error: "boom" })), "failed");
  // a terminal needs_user with blockedOn wins over the task's own status
  assert.equal(
    legacyOutcome(legacyTask({ status: "done" }), [
      { type: "needs_user", blockedOn: { type: "decision" } }
    ]),
    "needs_you"
  );
});

// --- run record model (pure) ------------------------------------------------

test("makeRunRecord creates an in-flight run; updateRun persists outcome and timing", () => {
  const record = makeRunRecord({
    run: 1,
    provider: "claude-code",
    node: "local",
    workspace: "local",
    model: "claude-3-5",
    startedAt: "2026-01-01T10:00:00.000Z"
  });
  assert.equal(record.outcome, "working");
  assert.equal(record.attempts, 1);
  assert.equal(record.model, "claude-3-5");

  const task = { id: 1, runs: [record] };
  const finished = updateRun(task, 1, {
    outcome: "ready",
    completedAt: "2026-01-01T10:04:12.000Z",
    durationMs: 252000,
    externalSessionId: "sess-1",
    error: undefined,
    blockedOn: undefined
  });
  assert.equal(finished.runs[0].outcome, "ready");
  assert.equal(finished.runs[0].durationMs, 252000);
  assert.equal(finished.runs[0].blockedOn, undefined);

  // A resumed run reopens: outcome working, completion cleared.
  const reopened = updateRun(finished, 1, {
    outcome: "working",
    completedAt: undefined,
    durationMs: undefined
  });
  assert.equal(reopened.runs[0].outcome, "working");
  assert.equal(reopened.runs[0].completedAt, undefined);
  assert.equal(reopened.runs[0].externalSessionId, "sess-1");
});

test("updateRun is a no-op for legacy tasks (their history stays interpreted)", () => {
  const task = legacyTask();
  assert.equal(updateRun(task, 1, { outcome: "ready" }), task);
});

test("currentRunNumber is the last record for sequential runs; 1 for legacy", () => {
  assert.equal(currentRunNumber(legacyTask()), 1);
  assert.equal(
    currentRunNumber({ runs: [{ run: 1, outcome: "ready" }, { run: 2, outcome: "working" }] }),
    2
  );
});

// --- actions: the run lifecycle ---------------------------------------------

test("createWork persists the first run with the task", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "First run" });
    assert.equal(task.runs.length, 1);
    assert.equal(task.runs[0].run, 1);
    assert.equal(task.runs[0].provider, "claude-code");
    assert.equal(task.runs[0].node, "fake-node");
    assert.equal(task.runs[0].outcome, "working");
    assert.equal(task.runs[0].attempts, 1);
    assert.ok(Date.parse(task.runs[0].startedAt));

    const onDisk = await runtime.store.findTask(task.id);
    assert.equal(onDisk.runs.length, 1);
    assert.deepEqual(runtime.node.calls, [["start", task.slug]]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("rerunWork appends a second run under the SAME task without overwriting the first", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "Rerun me" });
    const done = await applyWorkerOutcome(runtime, task, {
      status: "ready",
      result: "first result"
    });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
      "first result"
    );
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "result.md"),
      "first result"
    );

    const rerun = await runtime.actions.rerunWork(task.id, {
      provider: "deepseek-harness"
    });

    assert.equal(rerun.runs.length, 2);
    // The first run is untouched: its provider, outcome and result survive.
    assert.equal(rerun.runs[0].run, 1);
    assert.equal(rerun.runs[0].provider, "claude-code");
    assert.equal(rerun.runs[0].outcome, "ready");
    assert.equal(rerun.runs[1].run, 2);
    assert.equal(rerun.runs[1].provider, "deepseek-harness");
    assert.equal(rerun.runs[1].outcome, "working");
    assert.equal(rerun.status, "working");
    // The CURRENT execution now describes run 2; run 1 kept its own metadata.
    assert.equal(rerun.execution.provider, "deepseek-harness");
    assert.equal(rerun.execution.externalSessionId, undefined);

    const firstResult = await runtime.actions.getRun(task.id, 1);
    assert.equal(firstResult.result, "first result");
    assert.equal(firstResult.provider, "claude-code");

    const persisted = await runtime.store.findTask(task.id);
    assert.equal(persisted.runs.length, 2);
    assert.deepEqual(runtime.node.calls, [
      ["start", task.slug],
      ["start", task.slug]
    ]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("rerunWork without a provider retries through the task's current provider", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({
      title: "Retry",
      provider: "deepseek-harness"
    });
    await applyWorkerOutcome(runtime, task, { status: "failed", error: "boom" });

    const rerun = await runtime.actions.rerunWork(task.id);
    assert.equal(rerun.runs[1].provider, "deepseek-harness");
    assert.equal(rerun.execution.provider, "deepseek-harness");
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("rerunWork refuses while the task is working (sequential runs only)", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "In flight" });
    await assert.rejects(
      () => runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" }),
      /still executing\. Runs of one task are sequential/
    );
    assert.deepEqual(runtime.node.calls, [["start", task.slug]]); // no second spawn
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("rerunWork rejects an unknown provider with the shared error", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "Nope" });
    await applyWorkerOutcome(runtime, task, { status: "ready", result: "done" });
    await assert.rejects(
      () => runtime.actions.rerunWork(task.id, { provider: "codex" }),
      /Unknown execution provider "codex"\. Available: claude-code, deepseek-harness\./
    );
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("rerunWork materializes a legacy task's history before appending the new run", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-runs-"));
  try {
    // A task as it existed before run history: no `runs` array at all.
    const store = createStore(base);
    const legacy = {
      id: 1,
      slug: "001-legacy",
      title: "Legacy",
      status: "ready",
      execution: { provider: "claude-code", node: "local", workspace: "local" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await store.writeJson(path.join(store.taskDir(legacy.slug), "task.json"), legacy);
    await store.writeText(path.join(store.taskDir(legacy.slug), "result.md"), "old result");
    const node = fakeNode();
    const runtime = createRuntime(base, { node });

    const task = await runtime.actions.rerunWork(1, { provider: "deepseek-harness" });

    assert.equal(task.runs.length, 2);
    assert.equal(task.runs[0].run, 1);
    assert.equal(task.runs[0].provider, "claude-code");
    assert.equal(task.runs[0].legacy, true);
    assert.equal(task.runs[1].run, 2);
    assert.equal(task.runs[1].provider, "deepseek-harness");
    // The legacy run's result still reads from the legacy result.md.
    const legacyRunDetail = await runtime.actions.getRun(1, 1);
    assert.equal(legacyRunDetail.result, "old result");
    assert.equal(legacyRunDetail.provider, "claude-code");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("getRun returns one run's own result; an unknown run is a 404", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "Results" });
    await runtime.store.writeText(
      path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
      "run one result"
    );
    const run = await runtime.actions.getRun(task.id, 1);
    assert.equal(run.run, 1);
    assert.equal(run.result, "run one result");
    assert.equal(run.outcome, "working");
    await assert.rejects(() => runtime.actions.getRun(task.id, 99), /has no run 99/);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("getWork includes the projected run history", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ title: "With runs" });
    const detail = await runtime.actions.getWork(task.id);
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].run, 1);
    assert.equal(detail.runs[0].provider, "claude-code");
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

// --- events: run attribution ------------------------------------------------

test("eventsForRun attributes run-tagged events to their run and legacy events to run 1", () => {
  const events = [
    { type: "run.started", run: 1 },
    { type: "run.completed", run: 1 },
    { type: "run.started", run: 2 },
    { type: "run.completed", run: 2 },
    // written before run history existed — they belong to the only run there was
    { type: "progress", text: "legacy" },
    { type: "task.closed" } // task-level — never part of a run
  ];
  assert.deepEqual(eventsForRun(events, 1).map(e => e.type), [
    "run.started",
    "run.completed",
    "progress"
  ]);
  assert.deepEqual(eventsForRun(events, 2).map(e => e.type), [
    "run.started",
    "run.completed"
  ]);
});

// --- dogfooding: same task, both providers, real worker ---------------------

async function fakeClaudeBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-claude-"));
  const bin = path.join(dir, "claude");
  const events = [
    { type: "system", subtype: "init", session_id: "sess-e2e-claude" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] }
    },
    {
      type: "result",
      is_error: false,
      session_id: "sess-e2e-claude",
      result:
        "## Result\nfixed by claude\n## Changes\nEdited src/a.ts\n## Verification\nnpm test\n## Needs human decision\nNone"
    }
  ];
  const body =
    "#!/usr/bin/env node\n" +
    "const events = " + JSON.stringify(events) + ";\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + \"\\n\");\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return bin;
}

// A fake claude that blocks on permission on the first invocation and
// completes on a resumed (--resume) invocation — the permission-regression
// flow, through the real worker, with run records.
async function fakeClaudeResumableBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-claude-"));
  const bin = path.join(dir, "claude");
  const blocked = [
    { type: "system", subtype: "init", session_id: "sess-resume" },
    {
      type: "result",
      is_error: false,
      session_id: "sess-resume",
      permission_denials: [
        { tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }
      ],
      result: "## Result\nblocked on permission"
    }
  ];
  const resumed = [
    { type: "system", subtype: "init", session_id: "sess-resume" },
    {
      type: "result",
      is_error: false,
      session_id: "sess-resume",
      result: "## Result\ncompleted after allow\n## Needs human decision\nNone"
    }
  ];
  const body =
    "#!/usr/bin/env node\n" +
    "const events = process.argv.includes(\"--resume\") ? " +
    JSON.stringify(resumed) + " : " + JSON.stringify(blocked) + ";\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + \"\\n\");\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return bin;
}

async function fakeDshBin({ stdout = "## Result\nfixed by dsh\n## Needs human decision\nNone", code = 0, stderr = "" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-dsh-"));
  const bin = path.join(dir, "dsh");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "process.stdout.write(" + JSON.stringify(stdout) + ");\n" +
      (stderr ? "process.stderr.write(" + JSON.stringify(stderr) + ");\n" : "") +
      "process.exit(" + code + ");\n"
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function waitForStatus(runtime, id, expected, opts = {}) {
  const { timeout = 10000, tolerate = [] } = opts;
  // "working" is always in flight; `tolerate` covers stale-but-legitimate
  // intermediate states (e.g. needs_you before the resume worker reopens).
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    const task = await runtime.store.findTask(id);
    if (task.status === expected) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 50));
  }
}

test("DOGFOODING: the same task through claude-code then deepseek-harness persists as two runs", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-e2e-"));
  try {
    const claudeBin = await fakeClaudeBin();
    const dshBin = await fakeDshBin();

    await withEnv("CLAUDE_BIN", claudeBin, async () => {
      await withEnv("DSH_BIN", dshBin, async () => {
        const runtime = createRuntime(base);

        // Run 01 — claude-code, through the real worker + provider adapter.
        const task = await runtime.actions.createWork({
          title: "Investigate why retry state is lost"
        });
        await waitForStatus(runtime, task.id, "ready");

        const afterRun1 = await runtime.store.findTask(task.id);
        assert.equal(afterRun1.runs.length, 1);
        assert.equal(afterRun1.runs[0].provider, "claude-code");
        assert.equal(afterRun1.runs[0].outcome, "ready");
        assert.equal(afterRun1.runs[0].externalSessionId, "sess-e2e-claude");
        assert.equal(afterRun1.runs[0].attempts, 1);
        assert.ok(afterRun1.runs[0].completedAt);
        assert.ok(afterRun1.runs[0].durationMs >= 0);
        assert.equal(afterRun1.execution.externalSessionId, "sess-e2e-claude");

        // Run 02 — deepseek-harness, same task, same intent.
        const rerun = await runtime.actions.rerunWork(task.id, {
          provider: "deepseek-harness"
        });
        assert.equal(rerun.runs.length, 2);
        await waitForStatus(runtime, task.id, "ready");

        const persisted = await runtime.store.findTask(task.id);
        // The task's intent and identity are unchanged; both runs are kept.
        assert.equal(persisted.title, "Investigate why retry state is lost");
        assert.equal(persisted.runs.length, 2);
        assert.equal(persisted.runs[0].provider, "claude-code");
        assert.equal(persisted.runs[0].outcome, "ready");
        assert.equal(persisted.runs[1].provider, "deepseek-harness");
        assert.equal(persisted.runs[1].outcome, "ready");
        assert.equal(persisted.runs[1].attempts, 1);
        assert.ok(persisted.runs[1].completedAt);
        assert.ok(persisted.runs[1].durationMs >= 0);

        // Provider capability difference, persisted honestly: DSH never
        // surfaces a session id — the run record simply has none.
        assert.equal(persisted.runs[0].externalSessionId, "sess-e2e-claude");
        assert.equal(persisted.runs[1].externalSessionId, undefined);
        // The CURRENT execution describes the latest run.
        assert.equal(persisted.execution.provider, "deepseek-harness");

        // Events are attributed per run: Claude has structured steps, DSH
        // only start + end — nothing invented for either.
        const events = await runtime.store.readEvents(persisted.slug);
        const run1Events = eventsForRun(events, 1);
        const run2Events = eventsForRun(events, 2);
        assert.deepEqual(run1Events.map(e => e.type), [
          "run.started",
          "tool.started",
          "file.changed",
          "run.completed"
        ]);
        assert.ok(run1Events.every(e => e.run === 1));
        assert.deepEqual(run2Events.map(e => e.type), ["run.started", "run.completed"]);
        assert.ok(run2Events.every(e => e.run === 2));
        assert.equal(run2Events[0].sessionId, null); // DSH has no session id

        // Each run keeps its own written result; the task-level result.md is
        // the latest run's (the existing getWork contract).
        const dir = runtime.store.taskDir(persisted.slug);
        assert.match(await fs.readFile(path.join(dir, "runs", "1", "result.md"), "utf8"), /claude/);
        assert.match(await fs.readFile(path.join(dir, "runs", "2", "result.md"), "utf8"), /dsh/);
        assert.match(await fs.readFile(path.join(dir, "result.md"), "utf8"), /dsh/);
      });
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DOGFOODING: a needs_you run reopens on resume and finalizes with attempts=2", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-e2e-"));
  try {
    const claudeBin = await fakeClaudeResumableBin();
    await withEnv("CLAUDE_BIN", claudeBin, async () => {
      const runtime = createRuntime(base);
      const task = await runtime.actions.createWork({ title: "Resume flow" });
      await waitForStatus(runtime, task.id, "needs_you");

      let blocked = await runtime.store.findTask(task.id);
      assert.equal(blocked.runs.length, 1);
      assert.equal(blocked.runs[0].outcome, "needs_you");
      assert.equal(blocked.runs[0].blockedOn.type, "permission");
      assert.equal(blocked.runs[0].externalSessionId, "sess-resume");
      assert.ok(blocked.runs[0].completedAt);
      assert.ok(blocked.runs[0].durationMs >= 0);

      // The human grants; the SAME run (same session) resumes. The task stays
      // needs_you on disk until the resume worker reopens it — tolerate that.
      await runtime.actions.allowWork(task.id);
      await waitForStatus(runtime, task.id, "ready", { tolerate: ["needs_you"] });

      const done = await runtime.store.findTask(task.id);
      assert.equal(done.runs.length, 1);
      assert.equal(done.runs[0].run, 1);
      assert.equal(done.runs[0].outcome, "ready");
      assert.equal(done.runs[0].attempts, 2); // resumed once within the run
      assert.equal(done.runs[0].blockedOn, undefined);
      assert.equal(done.runs[0].externalSessionId, "sess-resume");
      assert.equal(done.execution.attempts, 2);
      assert.ok(done.runs[0].completedAt);
      const result = await fs.readFile(
        path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
        "utf8"
      );
      assert.match(result, /completed after allow/);
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DOGFOODING: a needs_you run is preserved in history with its block", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-e2e-"));
  try {
    const dshDecision = await fakeDshBin({
      stdout: "## Result\ninvestigated\n## Needs human decision\nWhich backend?"
    });
    await withEnv("DSH_BIN", dshDecision, async () => {
      const runtime = createRuntime(base);
      const task = await runtime.actions.createWork({
        title: "Decision",
        provider: "deepseek-harness"
      });
      await waitForStatus(runtime, task.id, "needs_you");

      const blocked = await runtime.store.findTask(task.id);
      assert.equal(blocked.status, "needs_you");
      assert.equal(blocked.runs.length, 1);
      assert.equal(blocked.runs[0].outcome, "needs_you");
      assert.equal(blocked.runs[0].blockedOn.type, "decision");
      assert.ok(blocked.runs[0].completedAt);
      assert.ok(blocked.runs[0].durationMs >= 0);
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("DOGFOODING: a failed rerun is preserved in history; the previous ready run is untouched", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-e2e-"));
  try {
    const claudeBin = await fakeClaudeBin();
    const dshFail = await fakeDshBin({
      stdout: "",
      code: 1,
      stderr: "dsh: E_TIMEOUT: timed out"
    });

    await withEnv("CLAUDE_BIN", claudeBin, async () => {
      const runtime = createRuntime(base);
      const task = await runtime.actions.createWork({ title: "Failure" });
      await waitForStatus(runtime, task.id, "ready");
      assert.equal((await runtime.store.findTask(task.id)).runs[0].outcome, "ready");

      await withEnv("DSH_BIN", dshFail, async () => {
        await runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" });
        await waitForStatus(runtime, task.id, "failed");
      });

      const failed = await runtime.store.findTask(task.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.runs.length, 2);
      // Run 1 survives exactly as it was; run 2 records the failure.
      assert.equal(failed.runs[0].outcome, "ready");
      assert.equal(failed.runs[0].provider, "claude-code");
      assert.equal(failed.runs[0].externalSessionId, "sess-e2e-claude");
      assert.equal(failed.runs[1].outcome, "failed");
      assert.equal(failed.runs[1].provider, "deepseek-harness");
      assert.match(failed.runs[1].error, /E_TIMEOUT/);
      assert.equal(failed.runs[1].blockedOn, undefined);
      assert.ok(failed.runs[1].completedAt);
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
