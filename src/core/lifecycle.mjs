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
// way.
//
// DECISION PROTOCOL (v0.3): the section is a machine-read contract, not prose.
// The ONLY thing that can produce needs_you/decision is an explicit positive
// signal:
//
//   ## Needs human decision
//   REQUIRED: yes
//   QUESTION: <the concrete question a human must answer>
//
// Invariant: NEEDS YOU means execution genuinely requires human input before
// the Work can proceed. A bare heading, a mention of the convention, prose
// such as "None." or "No decision required", or any other model-generated
// text is NOT a decision — absence of the explicit positive signal means no
// decision, no matter what the section contains. A false NEEDS YOU interrupts
// the human for work that did not actually require them, so this parser is
// deliberately strict: REQUIRED must be exactly "yes" (case-insensitive), and
// a `REQUIRED: yes` with no readable question is treated as malformed, not as
// a decision.
//
// The human-readable question is preserved: the `QUESTION:` field when
// present, otherwise the rest of the block after the REQUIRED line.
export function decisionSection(result) {
  const marker = "## Needs human decision";
  const index = result.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;

  const tail = result.slice(index + marker.length);
  const nextHeading = tail.search(/\n##\s+/);
  const block = (nextHeading >= 0 ? tail.slice(0, nextHeading) : tail).trim();

  // The ONLY positive signal: REQUIRED: yes. Missing, "no", "maybe", prose —
  // anything else means no decision is required.
  const required = block.match(/^\s*REQUIRED\s*:\s*(.+)$/im)?.[1]?.trim();
  if (required === null || required === undefined || required.toLowerCase() !== "yes") {
    return null;
  }

  // The question: the QUESTION: field when present, else the block's
  // remaining non-field text. A REQUIRED: yes with nothing readable is
  // malformed/incomplete — never manufacture a decision from it.
  let question = block.match(/^\s*QUESTION\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  if (!question) {
    question = block
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !/^(REQUIRED|QUESTION)\s*:/i.test(line))
      .join(" ")
      .trim();
  }
  if (!question) return null;
  return snippet(question, 400);
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
