// Work runs — one attempt to execute a task's intent through a provider.
//
//   Task                (the engineering intent — unchanged)
//     └── Runs          (one attempt through provider + node + model)
//           ├── run 01 / claude-code
//           ├── run 02 / deepseek-harness
//           └── …
//
// A run is persisted as a record inside the task's `runs` array in task.json
// (metadata only — result text lives in per-run files under runs/<n>/result.md,
// the same file convention as the legacy result.md). Run record shape:
//
//   {
//     run: 1,                    // stable 1-based id within the task
//     provider: "claude-code",   // execution provider id
//     node: "local",             // execution node id
//     workspace: "local",        // logical workspace id
//     model: "…",                // ONLY when reliably known
//     startedAt: ISO,            // when the run started
//     completedAt: ISO?,         // when the run reached its final outcome
//     durationMs: number?,       // completedAt - startedAt
//     outcome: "working" | "ready" | "needs_you" | "failed",
//     externalSessionId: "…"?,   // only when the provider surfaces one
//     attempts: 1,               // times the run's session was resumed
//     error: "…"?,               // when outcome is "failed"
//     blockedOn: {…}?            // when outcome is "needs_you"
//   }
//
// Nothing here is provider-shaped: provider capability differences surface as
// absent fields (a DeepSeek Harness run has no externalSessionId and no
// structured events; a Claude Code run has both). We never fabricate
// observability to make providers look equivalent.
//
// Backward compatibility: tasks created before run history have no `runs`
// array. They are INTERPRETED as having one historical run (legacyRun below)
// without rewriting their files. A rerun materializes that run before
// appending the new one, because a rerun replaces `task.execution` and the
// legacy run's provider would otherwise be lost.

export const RUN_OUTCOMES = ["working", "ready", "needs_you", "failed"];

// The initial in-flight run record, written by an action when a run starts.
// `requestedProvider` is what the user asked for ("auto" or a provider id);
// `routing` records the AUTO decision (mode/reason/considered) so "why did
// 0x2F run this here?" is answered from the persisted run, never
// reconstructed from current configuration.
export function makeRunRecord({ run, provider, node, workspace, model, startedAt, requestedProvider, routing }) {
  return {
    run,
    provider,
    node,
    workspace,
    ...(model ? { model } : {}),
    startedAt,
    ...(requestedProvider ? { requestedProvider } : {}),
    ...(routing ? { routing } : {}),
    outcome: "working",
    attempts: 1
  };
}

// The run an execution belongs to. Runs are strictly sequential (one task
// never has two executions in flight), so the current run is always the last
// record; a legacy task has no records and its only run is 1.
export function currentRunNumber(task) {
  const runs = Array.isArray(task.runs) ? task.runs : [];
  return runs.at(-1)?.run ?? 1;
}

// Patch one run record (pure). Legacy tasks have no records — no-op.
// Fields patched to `undefined` are dropped by JSON.stringify, so passing
// `completedAt: undefined` removes it (a resumed run reopens).
export function updateRun(task, runNumber, patch) {
  if (!Array.isArray(task.runs)) return task;
  const next = {
    ...task,
    runs: task.runs.map(r => (r.run === runNumber ? { ...r, ...patch } : r))
  };
  return next;
}

// --- legacy interpretation --------------------------------------------------
//
// A task that predates run history -> one historical run, interpreted from
// what IS persisted: task.execution (provider/node/model/session), task
// status (outcome), and — when the event log is available — real start and
// completion times from run.started and the terminal run events. Anything
// that genuinely cannot be known is left absent ("—" in clients) rather than
// guessed.

const TERMINAL_RUN_EVENT = e =>
  e.type === "run.completed" ||
  e.type === "run.failed" ||
  (e.type === "needs_user" && e.blockedOn);

export function terminalRunEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (TERMINAL_RUN_EVENT(events[i])) return events[i];
  }
  return null;
}

// The run's final outcome. Ground truth is the last terminal run event
// (run.completed / run.failed / needs_user-with-block); without events, fall
// back to the task's own status. A `done` task with no event evidence is
// interpreted through the documented lifecycle (done is reached from ready —
// accept — or failed): an error string marks the latter.
export function legacyOutcome(task, events = []) {
  const last = terminalRunEvent(events);
  if (last) {
    if (last.type === "run.completed") return "ready";
    if (last.type === "run.failed") return "failed";
    return "needs_you";
  }
  if (task.status === "needs_you" || task.status === "ready" || task.status === "failed") {
    return task.status;
  }
  if (task.status === "working") return "working";
  return task.error ? "failed" : "ready";
}

export function legacyRun(task, events = []) {
  const started = events.find(e => e.type === "run.started");
  const terminal = terminalRunEvent(events);
  const startedAt = started?.at;
  const completedAt = terminal?.at;
  const outcome = legacyOutcome(task, events);
  return {
    run: 1,
    provider: task.execution?.provider ?? null,
    node: task.execution?.node ?? null,
    workspace: task.execution?.workspace ?? null,
    model: task.execution?.model,
    externalSessionId: task.execution?.externalSessionId,
    attempts: task.execution?.attempts ?? 1,
    startedAt,
    completedAt,
    ...(startedAt && completedAt
      ? { durationMs: Date.parse(completedAt) - Date.parse(startedAt) }
      : {}),
    outcome,
    error: task.error,
    blockedOn: task.blockedOn,
    legacy: true
  };
}

// The task's runs for display/API: persisted records when they exist, else
// the single synthesized legacy run. `events` (the task's normalized event
// log) enriches legacy runs with real timing; persisted runs are self-contained.
export function taskRuns(task, { events = [] } = {}) {
  const runs = Array.isArray(task.runs) ? task.runs : [];
  if (runs.length) return runs;
  return [legacyRun(task, events)];
}
