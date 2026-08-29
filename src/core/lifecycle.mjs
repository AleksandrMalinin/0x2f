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
//   { status: "failed",   error, failure? }
//
// `blockedOn` is a normalized Work concept:
//
//   { type: "permission", tool, file, plannedChange, raw? }
//   { type: "decision",   text }
//
// `failure` is optional and classifies WHY a failed run stopped, so the UI
// can spend the failure band on Work's own instruction instead of a vendor's
// error prose. A small closed vocabulary Work owns, not a free string —
// providers may only pick from it, never invent a new kind:
//
//   { kind: "auth" | "unavailable" | "crashed" | "blocked" | "resume", remedy? }
//
// `remedy` is optional and adapter-authored: a short, single-line,
// non-interpolated string the UI renders verbatim (e.g. "claude /login").
// Absent `failure` (or an unrecognized `kind`) renders exactly as before —
// only "auth" changes presentation today. `error` is always kept verbatim
// alongside it; `failure` never replaces `error`, it classifies it.
// `blocked` means the agent explicitly reported it could not perform the
// requested work because of an environment/sandbox/access blocker (see
// `classifyResult` below) — the process exited fine, the work did not happen.
// `resume` means a permission grant was recorded but the provider could not
// continue the session (a vendor resume limitation) — the run fails honestly
// rather than pretending the granted work continued.
export const FAILURE_KINDS = ["auth", "unavailable", "crashed", "blocked", "resume"];

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
// The human-readable question is preserved VERBATIM: the `QUESTION:` field
// (everything from it to the end of the block, not just its first line —
// the concrete question is often a paragraph, the question itself plus the
// tradeoff that makes it non-obvious) when present, otherwise the rest of
// the block after the REQUIRED line.
//
// Dogfooding found this parser destroying the question it was meant to
// preserve: `QUESTION:` was captured with a single-line regex (silently
// dropping every line after the first) and the survivor was then collapsed
// to 400 characters with all whitespace flattened to single spaces before
// being stored — the paragraph a human needed to actually answer the
// question was gone before any surface ever got a chance to render it. Only
// a generous, storage-guard cap remains below; it preserves newlines and
// paragraph structure, because this is prose a human must read in full, not
// a one-line label.
const QUESTION_MAX = 4000;

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

  // The question: everything from QUESTION: to the end of the block (the
  // `[\s\S]+` dot-matches-newline pattern), else the block's remaining
  // non-field text with blank lines kept (paragraph breaks survive). A
  // REQUIRED: yes with nothing readable is malformed/incomplete — never
  // manufacture a decision from it.
  let question = block.match(/^\s*QUESTION\s*:\s*([\s\S]+)$/im)?.[1]?.trim() ?? "";
  if (!question) {
    question = block
      .split("\n")
      .filter(line => !/^\s*(REQUIRED|QUESTION)\s*:/i.test(line))
      .join("\n")
      .trim();
  }
  if (!question) return null;
  return capText(question, QUESTION_MAX);
}

// Backward-compatible name (v0 exported this from lib).
export const hasHumanDecision = result => decisionSection(result) !== null;

// ---------------------------------------------------------------------------
// Completed-run classification — the SHARED decision the provider boundary
// makes for any run whose process exited successfully with written text.
//
// `process completion != task completion` (module header): a run can exit 0
// while the task is actually parked on a human (decision) or was never
// performed at all (blocked). Providers normalize the same way:
//
//   classifyResult(text):
//     needs_you  — an explicit `## Needs human decision` block (strict protocol)
//     failed     — the text EXPLICITLY says the requested work could not be
//                  done because of a blocker (kind "blocked")
//     ready      — everything else
//
// The blocked check is deliberately narrow so ordinary warnings and partial
// limitations ("I could not run the integration tests because the sandbox
// blocks network, but the fix is complete") never become failures: the denial
// must be attributed to the agent or the task as a whole, name completion or
// continuation of the work, and be tied to a cause in the same sentence.
export function classifyResult(text) {
  const decision = decisionSection(text);
  if (decision) {
    return {
      status: "needs_you",
      reason: "decision",
      blockedOn: { type: "decision", text: decision }
    };
  }
  const blocked = blockedResultText(text);
  if (blocked) {
    return { status: "failed", error: blocked, failure: { kind: "blocked" } };
  }
  return { status: "ready" };
}

const BLOCKED_DENIAL_RE = [
  // "I could not continue … because …" — continuing the work is task-level.
  /\b(i|we|the agent|this run)\s+(could not|couldn'?t|was unable to|were unable to|am unable to|are unable to|cannot|can'?t)\s+continue\b[^.]*\b(because|due to|blocked by|blocked from|prevented by)\b/i,
  // "I could not complete/finish/perform/do (the) task/work … because …"
  /\b(i|we|the agent)\s+(could not|couldn'?t|was unable to|were unable to|am unable to|are unable to|cannot|can'?t|failed to)\s+(complete|finish|perform|do)\s+(the\s+)?(task|work|request|assignment|job)\b[^.]*\b(because|due to|blocked by|blocked from|prevented by)\b/i,
  // Passive, task-level: "the task could not be completed … because …"
  /\b(the|this)\s+(task|work|request)\s+(could not|couldn'?t|cannot|can'?t)\s+be\s+(completed|finished|performed|done)\b[^.]*\b(because|due to|blocked by|blocked from|prevented by)\b/i,
  // "… was/were blocked by/from …" attributed to the agent or the task.
  /\b(i|we|the agent|the task|this run)\s+(was|were|am|are|got|get|is)\s+blocked\s+(by|from)\b/i
];

// The agent's own explanation of the blocker (first sentence that states the
// denial, capped), or null when the text is not an explicit blocker report.
export function blockedResultText(text) {
  const s = String(text ?? "");
  const denial = BLOCKED_DENIAL_RE.find(re => re.test(s));
  if (!denial) return null;
  const sentence =
    s.split(/(?<=[.!?])\s+/).find(part => denial.test(part)) ?? s.trim();
  return capText(sentence, 2000);
}

// A storage guard, not a display decision: bounds an unbounded/adversarial
// section so the task record can't grow without limit. Trims surrounding
// whitespace but never collapses internal whitespace or newlines.
function capText(value, max) {
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function applyOutcome(task, outcome) {
  const next = { ...task };
  next.status = outcome.status;
  next.updatedAt = new Date().toISOString();

  if (outcome.status === "needs_you") {
    next.blockedOn = outcome.blockedOn ?? { type: outcome.reason ?? "decision" };
    delete next.error;
    delete next.failure;
  } else if (outcome.status === "ready") {
    delete next.blockedOn;
    delete next.error;
    delete next.failure;
  } else if (outcome.status === "failed") {
    next.error = outcome.error ?? "Execution failed";
    delete next.blockedOn;
    // Only a recognized kind is kept — an adapter that returns free-form
    // junk here degrades to "no classification" (today's rendering) rather
    // than the UI trusting an unvetted string.
    if (outcome.failure && FAILURE_KINDS.includes(outcome.failure.kind)) {
      next.failure = {
        kind: outcome.failure.kind,
        ...(typeof outcome.failure.remedy === "string" && outcome.failure.remedy.trim()
          ? { remedy: outcome.failure.remedy.trim() }
          : {})
      };
    } else {
      delete next.failure;
    }
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
