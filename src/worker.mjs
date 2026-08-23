// Detached background worker: runs one execution on behalf of a task and
// applies the normalized outcome to the task state.
//
//   node worker.mjs <base> <slug> <run>                -> provider.start
//   node worker.mjs <base> <slug> <run> resume <grant> -> provider.resume
//
// The worker is execution-node infrastructure: the local node spawns it, and
// a future remote node would run the same entrypoint on another machine. It
// consumes normalized provider outcomes (core/lifecycle.mjs) and appends
// normalized Work events (core/events.mjs) to the task's event log so any
// connected client can observe the run. Provider behavior stays inside the
// provider; state meaning stays inside the core; this file only wires them.

import fs from "node:fs/promises";
import path from "node:path";
import { createStore } from "./core/store.mjs";
import { applyOutcome, beginResume } from "./core/lifecycle.mjs";
import { workEvent } from "./core/events.mjs";
import { updateRun } from "./core/runs.mjs";
import { getProvider, defaultProviderId } from "./providers/index.mjs";

// argv: node worker.mjs <base> <slug> <run> [resume <grant>]
// The run number is explicit (the node derives it from the task's run
// records) so this process never has to guess which run it is executing.
const [, , base, slug, runArg, mode, grant] = process.argv;
const runNumber = Number(runArg) || 1;

if (!base || !slug) {
  console.error("worker requires <cwd> <slug> <run> [resume <allow|reject|continue>]");
  process.exit(1);
}

const store = createStore(base);
const dir = store.taskDir(slug);
const metaPath = path.join(dir, "task.json");
const promptPath = path.join(dir, "prompt.md");
const resultPath = path.join(dir, "result.md");

const task = await store.readJson(metaPath);

function log(line) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

// Every event this process records belongs to the run it is executing —
// including its task.updated writes (a resume's grant is part of run N's
// story). Events written before run history existed carry no `run` and belong
// to run 1. Action-level events (task.created / task.closed) are not run
// events and are never stamped.
//
// Records are serialized on one promise chain: appendFile is async and
// concurrent appends could otherwise land out of order in the log, corrupting
// the chronology every surface reads.
let recordChain = Promise.resolve();
function record(type, data = {}) {
  recordChain = recordChain.then(() =>
    store.appendEvent(slug, workEvent(type, task.id, { ...data, run: runNumber }))
  );
  return recordChain;
}

// Finalize the run record for THIS run: outcome, real timing, session,
// attempts, and the failure/block details the outcome produced. The run's
// outcome is the task status produced by the provider contract (ready /
// needs_you / failed) — nothing provider-shaped leaks in. Legacy tasks with
// no run records are left untouched (their history stays interpreted).
function finalizeRun(current) {
  if (!Array.isArray(current.runs)) return current;
  const record = current.runs.find(r => r.run === runNumber);
  if (!record) return current;
  const completedAt = new Date().toISOString();
  const startedMs = Date.parse(record.startedAt);
  return updateRun(current, runNumber, {
    outcome: current.status,
    completedAt,
    ...(Number.isFinite(startedMs)
      ? { durationMs: Date.parse(completedAt) - startedMs }
      : {}),
    externalSessionId: current.execution?.externalSessionId,
    attempts: current.execution?.attempts ?? record.attempts ?? 1,
    error: current.status === "failed" ? current.error : undefined,
    blockedOn: current.status === "needs_you" ? current.blockedOn : undefined
  });
}

const onEvent = event => {
  switch (event.type) {
    case "run.started":
      record("run.started", { sessionId: event.sessionId ?? null });
      log(`session started: ${event.sessionId ?? "unknown"}`);
      break;
    case "tool.started": {
      const input = event.input ?? {};
      const target =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.command === "string"
            ? input.command.slice(0, 80)
            : "";
      record("tool.started", { name: event.name, input: event.input ?? {} });
      if (typeof input.file_path === "string") {
        record("file.changed", { path: input.file_path });
      }
      log(`tool: ${event.name}${target ? ` ${target}` : ""}`);
      break;
    }
    case "progress":
      if (event.text) {
        record("progress", { text: event.text });
        log(event.text.replace(/\s+/g, " ").trim().slice(0, 160));
      }
      break;
    case "needs_user":
      record("needs_user", {
        reason: event.reason,
        detail: event.detail ?? {}
      });
      log(`needs user (${event.reason}): ${event.detail?.message ?? ""}`);
      break;
  }
};

// Record the terminal run events + the resulting task state.
async function finish(current, outcome) {
  current = finalizeRun(current);
  await store.writeJson(metaPath, current);

  if (outcome.status === "failed") {
    await record("run.failed", { error: outcome.error ?? "Execution failed" });
  } else if (outcome.status === "needs_you") {
    await record("needs_user", {
      reason: outcome.reason,
      blockedOn: outcome.blockedOn ?? {}
    });
  } else {
    await record("run.completed", { status: outcome.status });
  }
  await record("task.updated", { status: current.status });
  log(
    `outcome: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`
  );
}

try {
  const provider = getProvider(task.execution?.provider ?? defaultProviderId);
  if (!provider) {
    let failed = applyOutcome(task, {
      status: "failed",
      error: `No execution provider found for "${task.execution?.provider}".`
    });
    failed = finalizeRun(failed);
    await store.writeJson(metaPath, failed);
    await record("run.failed", { error: failed.error });
    await record("task.updated", { status: failed.status });
    log("outcome: failed (no execution provider)");
    process.exit(1);
  }

  let current = task;
  let outcome;

  if (mode === "resume") {
    if (provider.capabilities?.supportsResume === false) {
      // Declared capability difference: the provider cannot continue a
      // session. Fail loudly instead of pretending a new run is a resume.
      let failed = applyOutcome(task, {
        status: "failed",
        error: `Provider "${provider.id}" does not support resuming sessions.`
      });
      failed = finalizeRun(failed);
      await store.writeJson(metaPath, failed);
      await record("run.failed", { error: failed.error });
      await record("task.updated", { status: failed.status });
      log("outcome: failed (provider does not support resume)");
      process.exit(1);
    }
    if (task.status !== "needs_you") {
      log(`outcome: skipped — task is ${task.status}, not needs_you`);
      process.exit(0);
    }
    current = beginResume(task, grant);
    // The run reopens: the same run (same session) continues, so its record
    // goes back to working and its previous completion time is cleared.
    if (Array.isArray(current.runs)) {
      current = updateRun(current, runNumber, {
        outcome: "working",
        attempts: current.execution?.attempts,
        completedAt: undefined,
        durationMs: undefined,
        error: undefined,
        blockedOn: undefined
      });
    }
    await store.writeJson(metaPath, current);
    // Carry the grant on the normalized event: `beginResume` already records
    // it as execution.lastAction, so clients can show who unblocked the task
    // without inferring it from a status change.
    await record("task.updated", { status: current.status, grant });
    log(`resuming session ${current.execution?.externalSessionId ?? "?"} (${grant})`);

    outcome = await provider.resume({
      cwd: base,
      externalSessionId: current.execution?.externalSessionId,
      grant,
      onEvent
    });
  } else {
    if (task.status !== "working") {
      log(`outcome: skipped — task is ${task.status}, not working`);
      process.exit(0);
    }
    const prompt = await fs.readFile(promptPath, "utf8");
    log(`launching ${provider.displayName} (${provider.id})`);
    outcome = await provider.start({ cwd: base, prompt, onEvent });
  }

  current = applyOutcome(current, outcome);

  if (outcome.externalSessionId) {
    current.execution = {
      ...(current.execution ?? {}),
      provider: provider.id,
      externalSessionId: outcome.externalSessionId
    };
  }

  if (outcome.status === "ready" || outcome.status === "needs_you") {
    await fs.writeFile(resultPath, outcome.result ?? "", "utf8");
    // This run's own result, so the previous run's result is preserved when
    // a later run overwrites result.md. Runs with no written result (failed)
    // leave no per-run file — the absence is the honest record.
    if (Array.isArray(current.runs)) {
      const runDir = path.join(dir, "runs", String(runNumber));
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "result.md"),
        outcome.result ?? "",
        "utf8"
      );
    }
  }

  await finish(current, outcome);
} catch (error) {
  let failed = applyOutcome(task, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
  failed = finalizeRun(failed);
  await store.writeJson(metaPath, failed);
  await record("run.failed", { error: failed.error });
  await record("task.updated", { status: failed.status });
  log(`outcome: failed (${failed.error})`);
  process.exitCode = 1;
}
