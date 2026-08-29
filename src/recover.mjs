// Crash/reboot recovery — the startup sweep that turns interrupted runs into
// honest failures.
//
// A run's execution is owned by a detached worker process (src/worker.mjs)
// whose pid is persisted on the task (task.pid). When the host restarts, or
// the worker dies without writing a terminal outcome, the task is left in
// status "working" with no live worker: rerun refuses (the "still executing"
// guard in core/actions.mjs), resume requires needs_you, and no surface can
// tell "running" from "orphaned".
//
// This sweep runs once, on runtime startup (src/serve.mjs), BEFORE the API
// accepts requests, so a client never observes a "working" task whose worker
// is gone. It marks such tasks failed through the EXISTING lifecycle
// (applyOutcome + the already-defined failure kind "crashed"), finalizing the
// interrupted run's record the way the worker would have, while preserving
// run history and any persisted externalSessionId. A task whose worker is
// alive is never touched — the sweep must not race a genuinely running run.
//
// PID liveness is a cheap existence probe (signal 0). A task whose worker
// died is unrecoverable in place, so the honest state is failed; the
// persisted session id remains on the run record for inspection, and the
// task reruns normally (rerunWork only refuses while a task is "working").

import path from "node:path";
import { createStore } from "./core/store.mjs";
import { applyOutcome } from "./core/lifecycle.mjs";
import { workEvent } from "./core/events.mjs";
import { currentRunNumber, updateRun } from "./core/runs.mjs";

export const INTERRUPTED_ERROR =
  "Run was interrupted — the worker process is no longer alive (host restart or crash). Rerun the task to continue.";

// Is a pid a live process? Signal 0 tests existence without delivering a
// real signal. EPERM means the process exists but is owned by another user —
// treated as alive (defensive; the worker is ours). A zombie that has not yet
// been reaped still "exists"; the parent (the runtime) reaps its workers, and
// an orphaned zombie is reaped by init, so a dead worker stops answering this
// probe almost immediately after the machine or worker is gone.
export function pidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function info(log, ...args) {
  if (typeof log?.log === "function") log.log(...args);
  else if (typeof log === "function") log(...args);
}

// Mark one interrupted task failed through the shared lifecycle. The current
// run's record is finalized like the worker would have finalized it (outcome
// failed, real completion time, duration from startedAt), but externalSessionId
// and every other historical field are preserved. Returns the failed task.
export async function failInterruptedRun(store, task, { log = console } = {}) {
  const now = new Date().toISOString();
  const runNumber = currentRunNumber(task);
  let failed = applyOutcome(task, {
    status: "failed",
    error: INTERRUPTED_ERROR,
    failure: { kind: "crashed" }
  });
  if (Array.isArray(failed.runs)) {
    const record = failed.runs.find(r => r.run === runNumber);
    const startedMs = record ? Date.parse(record.startedAt) : NaN;
    failed = updateRun(failed, runNumber, {
      outcome: "failed",
      completedAt: now,
      ...(Number.isFinite(startedMs)
        ? { durationMs: Date.parse(now) - startedMs }
        : {}),
      error: INTERRUPTED_ERROR,
      blockedOn: undefined
    });
  }
  await store.writeJson(path.join(store.taskDir(task.slug), "task.json"), failed);
  // Normalized events, stamped with the run — the same shape the worker's own
  // terminal events carry, so every surface renders the recovery identically.
  await store.appendEvent(
    task.slug,
    workEvent("run.failed", task.id, { error: INTERRUPTED_ERROR, run: runNumber })
  );
  await store.appendEvent(
    task.slug,
    workEvent("task.updated", task.id, { status: "failed", run: runNumber })
  );
  info(
    log,
    `recovered task #${task.id} (${task.slug}): run ${runNumber} interrupted — ` +
      `marked failed (worker pid ${task.pid ?? "?"} not alive)`
  );
  return failed;
}

// The startup sweep: for every task still marked "working" whose worker pid
// is gone (or was never recorded), mark the interrupted run failed. Returns
// the recovered tasks. `kill` is injectable for tests.
export async function recoverInterruptedRuns(
  base,
  { kill = process.kill, log = console } = {}
) {
  const store = createStore(base);
  const tasks = await store.listTasks();
  const recovered = [];
  for (const task of tasks) {
    if (task.status !== "working") continue;
    if (pidAlive(task.pid, kill)) continue;
    recovered.push(await failInterruptedRun(store, task, { log }));
  }
  return recovered;
}
