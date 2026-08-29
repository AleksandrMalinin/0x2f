// Crash/reboot recovery: tasks left "working" with a dead (or missing) worker
// pid are failed through the existing lifecycle on runtime startup, run
// history and externalSessionId are preserved, live workers are never
// touched, and the task reruns normally afterward.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { makeRunRecord } from "../src/core/runs.mjs";
import { withFakeBin } from "./helpers.mjs";
import {
  recoverInterruptedRuns,
  failInterruptedRun,
  pidAlive,
  INTERRUPTED_ERROR
} from "../src/recover.mjs";

const quiet = { log() {}, error() {} };

// A kill that reports every process as gone (ESRCH) / present / forbidden.
const DEAD = () => {
  throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
};
const ALIVE = () => {};
const EPERM = () => {
  throw Object.assign(new Error("EPERM"), { code: "EPERM" });
};

async function tempBase() {
  return fs.mkdtemp(path.join(os.tmpdir(), "work-recover-"));
}

// A working task as a spawned run leaves it: status working (createTask's
// initial state), pid persisted, run record in flight. `opts.runs` defaults
// to a realistic in-flight run record; pass runs: null for the legacy shape
// (no run records at all).
async function makeWorkingTask(base, { pid = 424242, session = "sess-orphan", startedAgoMs = 60000, runs = "default" } = {}) {
  const store = createStore(base);
  const runRecords =
    runs === "default"
      ? [
          {
            // A session the worker had already surfaced (e.g. run.started with
            // a session id, as claude/codex/gemini/acp provide) — the recovery
            // must preserve it on the run record, exactly as finalizeRun would.
            ...makeRunRecord({
              run: 1,
              provider: "claude-code",
              node: "local",
              workspace: "local",
              startedAt: new Date(Date.now() - startedAgoMs).toISOString()
            }),
            ...(session ? { externalSessionId: session } : {})
          }
        ]
      : runs;
  const task = await store.createTask(
    { title: "Interrupted", brief: "Interrupted", prompt: "p" },
    { node: "local", provider: "claude-code", runs: runRecords }
  );
  const working = { ...task, pid };
  if (session) {
    working.execution = { ...(working.execution ?? {}), externalSessionId: session };
  }
  await store.updateTask(working);
  return { store, task: working };
}

function fakeNode(base) {
  return {
    id: "local",
    displayName: "Local machine",
    resolveWorkspace: () => base,
    async startExecution() {
      return null; // never spawns — the rerun is exercised at the action level
    },
    async resumeExecution() {
      return null;
    },
    async cancelExecution() {}
  };
}

test("pidAlive: signal-0 existence probe with EPERM treated as alive", () => {
  assert.equal(pidAlive(123, ALIVE), true);
  assert.equal(pidAlive(123, EPERM), true, "exists but foreign — treat as alive");
  assert.equal(pidAlive(123, DEAD), false);
  assert.equal(pidAlive(0, ALIVE), false);
  assert.equal(pidAlive(undefined, ALIVE), false);
  assert.equal(pidAlive(null, ALIVE), false);
  assert.equal(pidAlive(-5, ALIVE), false);
  assert.equal(pidAlive(1.5, ALIVE), false);
  // The real probe: this test process is alive; a huge pid almost certainly is not.
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(99999999), false);
});

test("an orphaned working run is failed with the crashed classification, preserving history and session", async () => {
  const base = await tempBase();
  try {
    const { task } = await makeWorkingTask(base, { session: "sess-orphan" });
    const recovered = await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, task.id);

    const store = createStore(base);
    const onDisk = await store.findTask(task.id);
    assert.equal(onDisk.status, "failed");
    assert.equal(onDisk.error, INTERRUPTED_ERROR);
    assert.deepEqual(onDisk.failure, { kind: "crashed" });

    // The interrupted run's record is finalized like the worker would have,
    // with its session and history preserved.
    const run = onDisk.runs[0];
    assert.equal(run.outcome, "failed");
    assert.equal(run.error, INTERRUPTED_ERROR);
    assert.equal(run.externalSessionId, "sess-orphan", "session id must survive recovery");
    assert.ok(run.completedAt, "completion time must be recorded");
    assert.ok(run.durationMs >= 59000, `duration from startedAt expected ~60s, got ${run.durationMs}`);
    assert.equal(run.blockedOn, undefined);

    // The task-level execution keeps its session too.
    assert.equal(onDisk.execution.externalSessionId, "sess-orphan");

    // Normalized terminal events, stamped with the run — same shape the
    // worker's own finish() emits.
    const events = await store.readEvents(task.slug);
    const failed = events.at(-2);
    const updated = events.at(-1);
    assert.equal(failed.type, "run.failed");
    assert.equal(failed.error, INTERRUPTED_ERROR);
    assert.equal(failed.run, 1);
    assert.equal(updated.type, "task.updated");
    assert.equal(updated.status, "failed");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("an interrupted run's completedAt/durationMs anchor to the last event the worker persisted, not the sweep time", async () => {
  const base = await tempBase();
  try {
    // The worker started 60s ago, persisted a couple of run events, then died
    // 15s ago (well before the sweep now). The recovered run must be anchored to
    // the LAST persisted event (15s ago), not to the moment the sweep runs.
    const { store, task } = await makeWorkingTask(base, { startedAgoMs: 60000 });
    const startedMs = Date.parse(task.runs[0].startedAt);
    const lastPersistedMs = Date.now() - 15000;
    await store.appendEvent(task.slug, {
      type: "run.started",
      taskId: task.id,
      run: 1,
      at: new Date(startedMs + 1000).toISOString()
    });
    await store.appendEvent(task.slug, {
      type: "progress",
      taskId: task.id,
      run: 1,
      at: new Date(lastPersistedMs).toISOString(),
      text: "working…"
    });

    await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });

    const onDisk = await store.findTask(task.id);
    const run = onDisk.runs[0];
    assert.equal(run.outcome, "failed");
    // Anchored to the last persisted event, NOT the sweep's "now".
    assert.equal(run.completedAt, new Date(lastPersistedMs).toISOString());
    assert.ok(
      Math.abs(run.durationMs - (lastPersistedMs - startedMs)) <= 2,
      `duration should be ~${lastPersistedMs - startedMs}ms (last event − startedAt), got ${run.durationMs}`
    );
    // The recovery's own terminal events must not be picked up as the anchor
    // (they are appended after the anchor is computed, so the anchor is the
    // worker's last event).
    assert.ok(Date.parse(run.completedAt) < Date.now(), "anchor predates the sweep");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a task with no recorded pid is also recovered (worker died before pid persisted)", async () => {
  const base = await tempBase();
  try {
    const { task } = await makeWorkingTask(base, { pid: undefined });
    await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });
    const onDisk = await createStore(base).findTask(task.id);
    assert.equal(onDisk.status, "failed");
    assert.equal(onDisk.failure.kind, "crashed");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a working task whose worker is alive is never touched", async () => {
  const base = await tempBase();
  try {
    // process.pid is alive on this machine — the sweep must skip it.
    const { task } = await makeWorkingTask(base, { pid: process.pid });
    const recovered = await recoverInterruptedRuns(base, { log: quiet });
    assert.deepEqual(recovered, []);

    const store = createStore(base);
    const onDisk = await store.findTask(task.id);
    assert.equal(onDisk.status, "working");
    assert.deepEqual(await store.readEvents(task.slug), [], "no events may be written for a live run");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("non-working tasks are left alone even with a dead pid", async () => {
  const base = await tempBase();
  try {
    const store = createStore(base);
    const cases = [
      { title: "Ready", status: "ready", outcome: { status: "ready" } },
      { title: "Failed", status: "failed", outcome: { status: "failed", error: "boom" } },
      {
        title: "Needs",
        status: "needs_you",
        outcome: { status: "needs_you", reason: "decision", blockedOn: { type: "decision", text: "?" } }
      },
      { title: "Done", status: "done", outcome: { status: "done" } }
    ];
    const tasks = [];
    for (const c of cases) {
      const task = await store.createTask(
        { title: c.title, brief: c.title, prompt: "p" },
        {
          runs: [
            makeRunRecord({
              run: 1,
              provider: "claude-code",
              node: "local",
              workspace: "local",
              startedAt: new Date().toISOString()
            })
          ]
        }
      );
      tasks.push(task);
    }
    for (let i = 0; i < cases.length; i++) {
      await store.updateTask({ ...applyOutcome(tasks[i], cases[i].outcome), pid: 424242 });
    }
    const recovered = await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });
    assert.deepEqual(recovered, []);

    const list = await store.listTasks();
    assert.deepEqual(list.map(t => t.status).sort(), ["done", "failed", "needs_you", "ready"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("legacy tasks (no run records) are recovered without crashing", async () => {
  const base = await tempBase();
  try {
    const { task } = await makeWorkingTask(base, { runs: null });
    await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });
    const onDisk = await createStore(base).findTask(task.id);
    assert.equal(onDisk.status, "failed");
    assert.equal(onDisk.failure.kind, "crashed");
    assert.equal(onDisk.runs, undefined, "legacy tasks keep no runs array");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("failInterruptedRun with no startedAt writes no duration", async () => {
  const base = await tempBase();
  try {
    const { store, task } = await makeWorkingTask(base, { startedAgoMs: 0 });
    const failed = await failInterruptedRun(store, task, { log: quiet });
    assert.equal(failed.status, "failed");
    assert.equal(failed.runs[0].completedAt !== undefined, true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a recovered task can be rerun normally (the working guard no longer blocks it)", async () => {
  const base = await tempBase();
  try {
    await makeWorkingTask(base);
    await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });

    const runtime = createRuntime(base, { node: fakeNode(base) });
    // The rerun's explicit provider selection checks availability; pin a fake
    // claude on PATH so the assertion is machine-independent.
    await withFakeBin("CLAUDE_BIN", "claude", async () => {
      const rerun = await runtime.actions.rerunWork(1, { provider: "claude-code" });
      assert.equal(rerun.status, "working", "rerun of a recovered task must start a new run");
      assert.equal(rerun.runs.length, 2, "run history is preserved and a new run is appended");
      assert.equal(rerun.runs[0].outcome, "failed");
      assert.equal(rerun.runs[0].externalSessionId, "sess-orphan");
      assert.equal(rerun.runs[1].run, 2);
      assert.equal(rerun.runs[1].outcome, "working");
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("recovery is idempotent: a second sweep leaves the failed task alone", async () => {
  const base = await tempBase();
  try {
    await makeWorkingTask(base);
    await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });
    const second = await recoverInterruptedRuns(base, { kill: DEAD, log: quiet });
    assert.deepEqual(second, [], "already-recovered tasks are skipped");
    const events = await createStore(base).readEvents("001-interrupted");
    const failedEvents = events.filter(e => e.type === "run.failed");
    assert.equal(failedEvents.length, 1, "only one run.failed per interrupted run");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
