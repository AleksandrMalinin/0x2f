// Work task lifecycle — the state machine Work owns.
//
// Execution providers produce normalized *outcomes*; Work decides what they
// mean for the task. The key rule this module enforces:
//
//   process completion != task completion
//
// A provider run can exit successfully while the engineering task is actually
// blocked on the human (e.g. a headless agent that stopped because a file edit
// needs permission). That maps to `needs_you`, never to `ready`.

export const STATUSES = ["working", "needs_you", "ready", "failed", "done"];

// `needs_you` reasons. v0.2 implements `permission` and `decision`;
// `question` and others are future reasons the state model already allows.
export const BLOCKED_REASONS = ["permission", "decision", "question"];

// Normalized outcome shapes produced by execution providers:
//
//   { status: "ready",    result }
//   { status: "needs_you", reason, blockedOn, result? }
//   { status: "failed",   error }
//
// `blockedOn` is a normalized Work concept:
//
//   { type: "permission", tool, file, plannedChange, raw? }
//   { type: "decision",   text }

// Work's shared prompt (project.mjs) asks every agent to end with a
// `## Needs human decision` section. This parser is a Work convention — not a
// vendor feature — so every provider that returns text normalizes it the same
// way. A non-trivial section maps to needs_you (decision).
export function decisionSection(result) {
  const marker = "## Needs human decision";
  const index = result.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;

  const tail = result.slice(index + marker.length);
  const nextHeading = tail.search(/\n##\s+/);
  const body = (nextHeading >= 0 ? tail.slice(0, nextHeading) : tail).trim();

  if (!body || /^(none|n\/a|no)[.!]?$/i.test(body)) return null;
  return snippet(body, 400);
}

// Backward-compatible name (v0 exported this from lib).
export const hasHumanDecision = result => decisionSection(result) !== null;

function snippet(value, max = 100) {
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function applyOutcome(task, outcome) {
  const next = { ...task };
  next.status = outcome.status;
  next.updatedAt = new Date().toISOString();

  if (outcome.status === "needs_you") {
    next.blockedOn = outcome.blockedOn ?? { type: outcome.reason ?? "decision" };
    delete next.error;
  } else if (outcome.status === "ready") {
    delete next.blockedOn;
    delete next.error;
  } else if (outcome.status === "failed") {
    next.error = outcome.error ?? "Execution failed";
    delete next.blockedOn;
  }

  return next;
}

// The user acted on a `needs_you` task (allow / reject / continue).
// The task goes back to WORKING with the execution session kept intact.
export function beginResume(task, grant) {
  if (task.status !== "needs_you") {
    throw new Error(
      `Task #${task.id} is ${task.status}, not needs_you — nothing to resume.`
    );
  }

  const next = { ...task };
  next.status = "working";
  next.updatedAt = new Date().toISOString();
  delete next.blockedOn;
  delete next.error;
  next.execution = {
    ...(task.execution ?? {}),
    attempts: (task.execution?.attempts ?? 1) + 1,
    lastAction: grant
  };
  return next;
}

export function closeTask(task) {
  const next = { ...task };
  next.status = "done";
  next.updatedAt = new Date().toISOString();
  delete next.blockedOn;
  return next;
}
