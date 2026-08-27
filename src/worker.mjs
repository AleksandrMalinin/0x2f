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
import { createProviderRegistry } from "./providers/index.mjs";

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
// THIS run's generated input, persisted by the actions when the run starts
// (runs/<n>/prompt.md). A run that predates per-run prompts falls back to the
// task-level original prompt.md. Resume never reads either: it continues the
// existing provider session with the canned grant prompt.
const runPromptPath = path.join(dir, "runs", String(runNumber), "prompt.md");
const resultPath = path.join(dir, "result.md");

// The provider registry for THIS workspace: native providers plus any
// manifests under .work/providers/. A malformed manifest fails loudly here,
// exactly as it does for the CLI/API — never silently.
const providers = createProviderRegistry({ base });

// The interactive-permission channel: the actions write the human's
// ALLOW/REJECT here; a provider that holds an outstanding ACP permission
// request polls this file and answers the ORIGINAL request in place, so the
// same session/execution continues. A stale file from an interrupted run is
// cleared before we start.
const permissionDecisionFile = path.join(dir, "permission.json");
await fs.rm(permissionDecisionFile, { force: true }).catch(() => {});

const task = await store.readJson(metaPath);

// Best-effort cancellation seam: the node's cancelExecution kills this
// process; give the provider a chance to cancel its own run first (ACP sends
// session/cancel, command providers just die with us).
let currentProvider = null;
let runSessionId = null; // the provider-surfaced session id, persisted on pause
process.on("SIGTERM", () => {
  try {
    currentProvider?.cancel?.();
  } catch {
    /* best-effort */
  }
  process.exit(0);
});

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

// Serialize task.json read-modify-write operations. The interactive
// permission handlers run fire-and-forget from the event stream, so their
// writes must not interleave with finish()'s final write — a lost update
// would leave the task stuck in an intermediate state.
let stateChain = Promise.resolve();
const withState = fn => {
  stateChain = stateChain.then(fn);
  return stateChain;
};

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

const onEvent = async event => {
  switch (event.type) {
    case "run.started":
      record("run.started", { sessionId: event.sessionId ?? null });
      if (event.sessionId) runSessionId = event.sessionId;
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
      log(`tool: ${event.name}${target ? ` ${target}` : ""}`);
      break;
    }
    case "file.changed":
      // The provider adapter decides what counts as a change (vendor tool
      // vocabulary is its concern, not ours) — this just records what it says.
      record("file.changed", { path: event.path });
      log(`file changed: ${event.path}`);
      break;
    case "progress":
      if (event.text) {
        record("progress", { text: event.text });
        log(event.text.replace(/\s+/g, " ").trim().slice(0, 160));
      }
      break;
    case "needs_user": {
      await record("needs_user", {
        reason: event.reason,
        detail: event.detail ?? {},
        ...(event.blockedOn ? { blockedOn: event.blockedOn } : {})
      });
      // An INTERACTIVE ACP permission request pauses the run for the human
      // while the provider keeps the agent session alive. Persist the
      // needs_you state so every surface sees the halt; the provider is
      // waiting on the decision file and will continue the SAME run when the
      // human decides.
      if (event.blockedOn?.live) {
        await withState(async () => {
          const fresh = await store.readJson(metaPath);
          const now = new Date().toISOString();
          let paused = {
            ...fresh,
            status: "needs_you",
            blockedOn: event.blockedOn,
            updatedAt: now,
            // The session id is real (surfaced at run.started); persist it so
            // the paused run is inspectable while the human decides.
            ...(runSessionId
              ? { execution: { ...(fresh.execution ?? {}), externalSessionId: runSessionId } }
              : {})
          };
          delete paused.error;
          if (Array.isArray(paused.runs)) {
            const record = paused.runs.find(r => r.run === runNumber);
            const startedMs = record ? Date.parse(record.startedAt) : NaN;
            paused = updateRun(paused, runNumber, {
              outcome: "needs_you",
              completedAt: now,
              ...(Number.isFinite(startedMs)
                ? { durationMs: Date.parse(now) - startedMs }
                : {}),
              externalSessionId: runSessionId ?? record?.externalSessionId,
              blockedOn: event.blockedOn
            });
          }
          await store.writeJson(metaPath, paused);
        });
        log(`needs user (permission): awaiting your decision`);
      } else {
        log(`needs user (${event.reason}): ${event.detail?.message ?? ""}`);
      }
      break;
    }
    case "permission.resolved": {
      // The human answered the outstanding permission request; the provider
      // responded and the SAME run continues (no new session, no restart).
      await record("permission.resolved", { grant: event.grant });
      await withState(async () => {
        const fresh = await store.readJson(metaPath);
        // Reflect the resumed run only while the task is still parked on it.
        // If the run already settled to a terminal state (the completion
        // raced this fire-and-forget handler), the terminal state stands —
        // a late "working" write must never clobber ready/failed.
        if (fresh.status !== "needs_you") return;
        const now = new Date().toISOString();
        let resumed = { ...fresh, status: "working", updatedAt: now };
        delete resumed.blockedOn;
        if (Array.isArray(resumed.runs)) {
          resumed = updateRun(resumed, runNumber, {
            outcome: "working",
            completedAt: undefined,
            durationMs: undefined,
            blockedOn: undefined
          });
        }
        await store.writeJson(metaPath, resumed);
      });
      log(`permission ${event.grant} — continuing the same run`);
      break;
    }
  }
};

// Record the terminal run events + the resulting task state.
async function finish(current, outcome) {
  current = finalizeRun(current);
  // Write through the state chain: any interactive permission handler write
  // (fire-and-forget from the event stream) must land BEFORE the terminal
  // state, or a lost update could leave the task stuck mid-transition.
  await withState(async () => {
    await store.writeJson(metaPath, current);
  });

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
  const provider = providers.getProvider(
    task.execution?.provider ?? providers.defaultProviderId
  );
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
  currentProvider = provider;

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
      onEvent,
      permission: { decisionFile: permissionDecisionFile },
      model: current.execution?.model
    });
  } else {
    if (task.status !== "working") {
      log(`outcome: skipped — task is ${task.status}, not working`);
      process.exit(0);
    }
    const prompt = (await store.exists(runPromptPath))
      ? await fs.readFile(runPromptPath, "utf8")
      : await fs.readFile(promptPath, "utf8");
    log(`launching ${provider.displayName} (${provider.id})`);
    outcome = await provider.start({
      cwd: base,
      prompt,
      onEvent,
      permission: { decisionFile: permissionDecisionFile },
      model: task.execution?.model
    });
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
    await fs.writeFile(resultPath, outcome.result ?? "", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(resultPath, 0o600).catch(() => {});
    // This run's own result, so the previous run's result is preserved when
    // a later run overwrites result.md. Runs with no written result (failed)
    // leave no per-run file — the absence is the honest record.
    if (Array.isArray(current.runs)) {
      const runDir = path.join(dir, "runs", String(runNumber));
      await fs.mkdir(runDir, { recursive: true });
      const runResultPath = path.join(runDir, "result.md");
      await fs.writeFile(runResultPath, outcome.result ?? "", {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.chmod(runResultPath, 0o600).catch(() => {});
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
