// The Web ledger projection: normalized Work events -> what the browser draws.
//
// This is the same module the browser imports (served at /app/ledger.mjs), so
// these tests cover the production rendering path, not a copy of it. They
// assert the projection's behaviour — one mark per real event, the declared
// ∩ observed section rule, Needs You, the Ready result, compressed done
// rows, progressive fidelity — against REAL normalized events.

import test from "node:test";
import assert from "node:assert/strict";
import {
  markClass,
  MARK_CLASS,
  stepArgument,
  toSteps,
  tail,
  TAIL,
  trace,
  brackets,
  sections,
  capabilityNote,
  fidelity,
  projectRow,
  projectLedger,
  sortTasks,
  counts,
  fmtDuration,
  relativePath,
  blockedTitle,
  eventsForRun,
  projectRuns,
  firstSentence,
  restAfterFirstSentence,
  inferFailureKind,
  authFailureCopy,
  authFailureLine,
  parseRich
} from "../src/web/ledger.mjs";
import { workEvent } from "../src/core/events.mjs";

// Build an event log with controlled timestamps, the way the worker writes it.
function log(entries, startMs = Date.parse("2026-01-01T10:00:00.000Z")) {
  return entries.map(([type, seconds, data]) => ({
    ...workEvent(type, 1, data ?? {}),
    at: new Date(startMs + seconds * 1000).toISOString()
  }));
}

const task = (over = {}) => ({
  id: 1,
  slug: "001-t",
  title: "investigate the correction lifecycle",
  status: "working",
  execution: { provider: "claude-code", node: "local", workspace: "local" },
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
  ...over
});

// A provider that declares everything (the honest post-boundary-fix
// claude-code shape) and one that declares nothing but a live stream (the
// pre-kind-plumbing ACP shape) and one fully coarse provider (DSH/command).
const RICH = {
  "claude-code": {
    capabilities: {
      supportsStructuredEvents: true,
      supportsFileChanges: true,
      supportsCommands: true,
      resultOnCompletion: false
    }
  }
};
const PARTIAL = {
  "some-acp-agent": {
    capabilities: {
      supportsStructuredEvents: true,
      supportsFileChanges: false,
      supportsCommands: false,
      resultOnCompletion: false
    }
  }
};
const COARSE = {
  "deepseek-harness": {
    capabilities: {
      supportsStructuredEvents: false,
      supportsFileChanges: false,
      supportsCommands: false,
      resultOnCompletion: true
    }
  }
};
const coarseTask = over =>
  task({ execution: { provider: "deepseek-harness", node: "local", workspace: "local" }, ...over });

// --- step extraction ---------------------------------------------------------

test("stepArgument reads whatever the tool input names as its target", () => {
  assert.equal(stepArgument({ file_path: "/w/src/a.ts" }), "/w/src/a.ts");
  assert.equal(stepArgument({ command: "pnpm test" }), "pnpm test");
  assert.equal(stepArgument({ pattern: "heldCaptures" }), "heldCaptures");
  assert.equal(stepArgument({}), "");
});

test("toSteps turns tool.started, file.changed and commands into distinct units", () => {
  const events = log([
    ["run.started", 0, { sessionId: "sess-1" }],
    ["tool.started", 2, { name: "Read", input: { file_path: "/w/src/a.ts" } }],
    ["progress", 3, { text: "looking at   the retry window" }],
    ["tool.started", 6, { name: "Edit", input: { file_path: "/w/src/a.ts" } }],
    ["file.changed", 6, { path: "/w/src/a.ts" }],
    ["tool.started", 9, { name: "Bash", input: { command: "npm test" } }]
  ]);

  const { steps, files, commands, activity, sessionId } = toSteps(task(), events);

  assert.deepEqual(steps.map(s => s.kind), ["tool", "tool", "change", "command"]);
  assert.deepEqual(steps.map(s => s.verb), ["READ", "EDIT", "CHANGED", "BASH"]);
  assert.deepEqual(steps.map(s => Math.round(s.t)), [2, 6, 6, 9]);
  assert.deepEqual(files, ["/w/src/a.ts"]);
  assert.deepEqual(commands, ["npm test"]);
  assert.equal(sessionId, "sess-1");
  // The progress line is narration, not a step — it becomes the activity
  // line and is cleared by the next real step.
  assert.equal(activity, "");
});

test("markClass reads the event shape the step was built from, not a tool name", () => {
  const events = log([
    ["tool.started", 0, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 1, { name: "Bash", input: { command: "npm test" } }],
    ["file.changed", 2, { path: "a.ts" }],
    ["task.updated", 3, { status: "working", grant: "allow" }]
  ]);
  const { steps } = toSteps(task(), events);
  assert.deepEqual(steps.map(markClass), ["tool", "command", "change", "human"]);
  assert.deepEqual(MARK_CLASS, [
    "quiet", "read", "search", "plan", "change", "command", "tool", "human", "halt", "fail"
  ]);
});

test("the last progress line survives as the live activity when no step follows", () => {
  const events = log([
    ["run.started", 0, {}],
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["progress", 4, { text: "reconciling the retry window" }]
  ]);
  assert.equal(toSteps(task(), events).activity, "reconciling the retry window");
});

test("the worker's duplicated needs_user events collapse into one halt", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", detail: {} }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission" } }]
  ]);
  const halts = toSteps(task(), events).steps.filter(s => s.kind === "halt");
  assert.equal(halts.length, 1);
  assert.equal(halts[0].reason, "permission");
});

test("a resume the human authorised becomes a YOU step", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission" } }],
    ["task.updated", 5, { status: "working", grant: "allow" }],
    ["tool.started", 7, { name: "Edit", input: { file_path: "a.ts" } }]
  ]);
  const steps = toSteps(task(), events).steps;
  const human = steps.filter(s => s.human);
  assert.equal(human.length, 1);
  assert.equal(human[0].verb, "YOU");
  assert.match(human[0].arg, /granted the request/);

  // A plain status update is not a human action.
  const quiet = toSteps(task(), log([["task.updated", 1, { status: "ready" }]])).steps;
  assert.equal(quiet.length, 0);
});

test("an answered decision becomes a YOU step in the ledger", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "decision", blockedOn: { type: "decision", text: "X or Y?" } }],
    ["task.answered", 5, { answer: "Choose X, because it is the narrower change." }]
  ]);
  const steps = toSteps(task({ status: "needs_you" }), events).steps;
  const humans = steps.filter(s => s.human);
  assert.equal(humans.length, 1);
  assert.equal(humans[0].verb, "YOU");
  assert.match(humans[0].arg, /answered the decision/);
  assert.match(humans[0].arg, /Choose X, because it is the narrower change/);
  // A long answer is shown short in the step line, never dropped entirely.
  const longAnswer = "x".repeat(300);
  const longSteps = toSteps(task({ status: "needs_you" }), log([
    ["task.answered", 1, { answer: longAnswer }]
  ])).steps;
  assert.ok(longSteps[0].arg.length < longAnswer.length);
});

test("an interactive ACP permission becomes a YOU step when resolved in place", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission", live: true, tool: "Edit a.ts" } }],
    ["permission.resolved", 5, { grant: "allow" }],
    ["run.completed", 7, { status: "ready" }]
  ]);
  const steps = toSteps(task({ status: "ready" }), events).steps;
  const humans = steps.filter(s => s.human);
  assert.equal(humans.length, 1);
  assert.equal(humans[0].verb, "YOU");
  assert.match(humans[0].arg, /continuing the same run/);
});

test("step arguments and changed files are shown as project paths, not machine paths", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "/w/services/capture/ingest.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "/w/services/capture/ingest.ts" } }],
    ["file.changed", 2, { path: "/w/services/capture/ingest.ts" }]
  ]);
  const { steps, files } = toSteps(task(), events, { base: "/w" });
  assert.deepEqual(steps.filter(s => s.kind !== "change").map(s => s.arg), [
    "services/capture/ingest.ts",
    "services/capture/ingest.ts"
  ]);
  assert.deepEqual(files, ["services/capture/ingest.ts"]);

  // A file outside the workspace keeps its absolute path — it is genuinely
  // not a project path and pretending otherwise would mislead.
  const outside = toSteps(task(), log([
    ["tool.started", 1, { name: "Read", input: { file_path: "/etc/hosts" } }]
  ]), { base: "/w" });
  assert.equal(outside.steps[0].arg, "/etc/hosts");
});

test("a file changed twice produces two marks — one per real event, never deduped in the trace", () => {
  const events = log([
    ["file.changed", 1, { path: "a.ts" }],
    ["file.changed", 5, { path: "a.ts" }]
  ]);
  const { steps, files } = toSteps(task(), events);
  assert.equal(steps.filter(s => s.kind === "change").length, 2);
  // ...but the FILES list (what changed) reports the unique path once.
  assert.deepEqual(files, ["a.ts"]);
});

// --- tail ---------------------------------------------------------------------

test("tail keeps the most recent N units and drops halt/fail (positions, not units)", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission" } }],
    ["task.updated", 3, { status: "working", grant: "allow" }],
    ["tool.started", 4, { name: "Edit", input: { file_path: "a.ts" } }],
    ["run.failed", 5, { error: "boom" }]
  ]);
  const { steps } = toSteps(task(), events);
  const { marks, truncated, total } = tail(steps, 2);
  // 3 non-halt/fail units exist (tool, human, tool); the budget of 2 keeps
  // only the most recent.
  assert.deepEqual(marks.map(s => s.kind), ["human", "tool"]);
  assert.equal(truncated, true);
  assert.equal(total, 3);
});

test("tail drops the oldest units silently once the budget is exceeded", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(["tool.started", i, { name: "Read", input: { file_path: "a" + i } }]);
  const { steps } = toSteps(task(), log(many));
  const { marks, truncated, total } = tail(steps, TAIL.collapsed);
  assert.equal(marks.length, TAIL.collapsed);
  assert.equal(marks[marks.length - 1].arg, "a39");
  assert.equal(truncated, true);
  assert.equal(total, 40);
});

// --- the travel rule ------------------------------------------------------------

test("the trace draws one fixed-width cell per unit, never scaled by how long it took", () => {
  const events = log([
    ["tool.started", 0, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 40, { name: "Edit", input: { file_path: "a.ts" } }],
    ["run.completed", 44, { status: "ready" }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: true, halted: false, finished: false });
  const marks = laid.cells.filter(c => !c.isHead && !c.isHalt);
  assert.equal(marks.length, 2);
  // A 40s gap and a 4s gap draw the SAME width — width is not a duration.
  assert.equal(marks[0].w, marks[1].w);
});

test("the point of execution is the luminous head, and it is drawn last", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 3, { name: "Edit", input: { file_path: "a.ts" } }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: true, halted: false, finished: false });
  assert.equal(laid.cells.filter(c => c.isHead).length, 1);
  assert.equal(laid.cells[laid.cells.length - 1].isHead, true);
});

test("an interruption tears the track open instead of capping it", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission" } }]
  ]);
  const { steps } = toSteps(task({ status: "needs_you" }), events);
  const laid = trace(steps, { live: false, halted: true, finished: false });
  assert.equal(laid.cells.filter(c => c.isHalt).length, 1);
  assert.equal(laid.cells.filter(c => c.isHead).length, 0);
});

test("a finished run's track is struck in graphite, with no head", () => {
  const events = log([["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }]]);
  const { steps } = toSteps(task({ status: "ready" }), events);
  const laid = trace(steps, { live: false, halted: false, finished: true });
  assert.ok(laid.cells.length > 0);
  assert.ok(laid.cells.every(c => c.c === "#2f2f2f"));
});

test("a long run is bounded by the tail budget, not strided", () => {
  const many = [];
  for (let i = 0; i < 400; i++) many.push(["tool.started", i, { name: "Read", input: { file_path: "a" + i } }]);
  const { steps } = toSteps(task(), log(many));
  const laid = trace(steps, { n: TAIL.expanded, live: true });
  const marks = laid.cells.filter(c => !c.isHead);
  assert.equal(marks.length, TAIL.expanded);
  assert.equal(laid.truncated, true);
});

test("a change mark is drawn in the accent, distinct from an ordinary tool mark", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 2, { path: "a.ts" }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: false, halted: false, finished: true, accent: "#2f5fa8" });
  const [read, edit, change] = laid.cells;
  assert.equal(read.cls, "tool");
  assert.equal(edit.cls, "tool");
  assert.equal(change.cls, "change");
  assert.equal(change.c, "#2f5fa8");
  assert.notEqual(read.c, change.c);
});

test("a coarse provider draws a single ambient bar — never a per-interval dot", () => {
  const laid = trace([], { coarse: true, live: true, elapsedSeconds: 90 });
  // Exactly one ambient shape plus the head: nothing here could be mistaken
  // for a reported event.
  assert.equal(laid.cells.filter(c => c.ambient).length, 1);
  assert.equal(laid.cells.filter(c => c.isHead).length, 1);
  assert.equal(laid.cells.length, 2);
});

test("the coarse ambient bar's width is capped, so elapsed time never reads as a step count", () => {
  const short = trace([], { coarse: true, elapsedSeconds: 5 });
  const long = trace([], { coarse: true, elapsedSeconds: 100000 });
  const capped = trace([], { coarse: true, elapsedSeconds: 100000 * 2 });
  assert.equal(long.cells[0].w, capped.cells[0].w);
  assert.ok(parseFloat(long.cells[0].w) > parseFloat(short.cells[0].w));
});

test("a coarse frame carries the halt tear exactly once and draws no phase frame", () => {
  const laid = trace([], { coarse: true, halted: true, elapsedSeconds: 30 });
  assert.equal(laid.cells.filter(c => c.isHalt).length, 1);
  assert.equal(laid.cells.filter(c => c.unobserved).length, 0);
});

// --- brackets -------------------------------------------------------------------

test("brackets: CHANGES spans the first to the last change mark, only when declared", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 2, { path: "a.ts" }],
    ["file.changed", 3, { path: "b.ts" }],
    ["tool.started", 4, { name: "Bash", input: { command: "npm test" } }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: false, finished: true });
  const withCap = brackets(laid.units, { supportsFileChanges: true }, laid.cells);
  assert.equal(withCap.length, 1);
  assert.equal(withCap[0].label, "CHANGES");

  // Not declared -> no bracket, even though the same evidence is present.
  const withoutCap = brackets(laid.units, { supportsFileChanges: false }, laid.cells);
  assert.deepEqual(withoutCap, []);
});

test("brackets: two separated runs of edits give two brackets", () => {
  const events = log([
    ["file.changed", 1, { path: "a.ts" }],
    ["tool.started", 2, { name: "Bash", input: { command: "npm test" } }],
    ["file.changed", 3, { path: "b.ts" }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: false, finished: true });
  const out = brackets(laid.units, { supportsFileChanges: true }, laid.cells);
  assert.equal(out.length, 2);
});

test("brackets: labels that would print on top of each other are dropped, not stacked", () => {
  // Three edit runs a couple of marks apart: every bracket still draws, but
  // only the ones far enough apart to fit the word carry it. Two labels at
  // the same few pixels used to render one on top of the other.
  const events = log([
    ["file.changed", 1, { path: "a.ts" }],
    ["tool.started", 2, { name: "Bash", input: { command: "npm test" } }],
    ["file.changed", 3, { path: "b.ts" }],
    ["tool.started", 4, { name: "Bash", input: { command: "npm test" } }],
    ["file.changed", 5, { path: "c.ts" }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: false, finished: true });
  const out = brackets(laid.units, { supportsFileChanges: true }, laid.cells);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(b => b.label), ["CHANGES", null, null]);

  // Far apart, both spans are labelled: the rule is distance, not "first only".
  const spread = log([
    ["file.changed", 1, { path: "a.ts" }],
    ...Array.from({ length: 12 }, (_, i) => [
      "tool.started",
      i + 2,
      { name: "Bash", input: { command: "npm test" } }
    ]),
    ["file.changed", 20, { path: "b.ts" }]
  ]);
  const spreadSteps = toSteps(task(), spread).steps;
  const spreadLaid = trace(spreadSteps, { live: false, finished: true });
  const spreadOut = brackets(spreadLaid.units, { supportsFileChanges: true }, spreadLaid.cells);
  assert.deepEqual(spreadOut.map(b => b.label), ["CHANGES", "CHANGES"]);
});

test("brackets: zero evidence in the tail is a valid, complete reading", () => {
  const events = log([["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }]]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: false, finished: true });
  assert.deepEqual(brackets(laid.units, { supportsFileChanges: true }, laid.cells), []);
});

// --- section composition ---------------------------------------------------------

test("sections: a dimension shows only when actually present, and CHECKS never exists", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 2, { path: "a.ts" }],
    ["tool.started", 3, { name: "Bash", input: { command: "npm test" } }]
  ]);
  const { steps } = toSteps(task(), events);
  const caps = RICH["claude-code"].capabilities;
  const sec = sections(task(), steps, caps, null);

  assert.ok(sec.activity);
  assert.deepEqual(sec.files.paths, ["a.ts"]);
  assert.deepEqual(sec.commands.commands, ["npm test"]);
  assert.equal(sec.failure, null);
  assert.equal(sec.result, null); // no result text given
  assert.equal("checks" in sec, false);
});

test("sections: declared true with nothing observed yet is not a section — and not a lie", () => {
  const sec = sections(task({ status: "working" }), [], RICH["claude-code"].capabilities, null);
  assert.equal(sec.activity, null);
  assert.equal(sec.files, null);
  assert.equal(sec.commands, null);
  assert.deepEqual(sec.capabilityDrift, []);
});

test("sections: observed facts render even against a false declaration, and flag the drift", () => {
  const events = log([
    ["file.changed", 1, { path: "a.ts" }]
  ]);
  const { steps } = toSteps(task(), events);
  const sec = sections(task(), steps, { supportsFileChanges: false }, null);
  // The fact still renders...
  assert.deepEqual(sec.files.paths, ["a.ts"]);
  // ...and the contradiction is flagged for the console, never suppressed.
  assert.deepEqual(sec.capabilityDrift, ["fileChanges"]);
});

test("sections: RESULT is gated on status and real result text, FAILURE takes precedence", () => {
  const ready = sections(task({ status: "ready" }), [], {}, "## Result\nfixed it");
  assert.deepEqual(ready.result, { text: "## Result\nfixed it" });

  const failed = sections(task({ status: "failed", error: "boom" }), [], {}, "");
  assert.deepEqual(failed.failure, { error: "boom" });
  assert.equal(failed.result, null);

  const doneWithError = sections(task({ status: "done", error: "boom" }), [], {}, "text");
  assert.deepEqual(doneWithError.failure, { error: "boom" });
  assert.equal(doneWithError.result, null);

  const workingNoText = sections(task({ status: "working" }), [], {}, null);
  assert.equal(workingNoText.result, null);
});

// --- the quiet note ---------------------------------------------------------------

test("capabilityNote: result-on-completion fires only while a coarse provider is working", () => {
  const dsh = COARSE["deepseek-harness"].capabilities;
  assert.equal(capabilityNote(task({ status: "working" }), dsh), "result reported on completion");
  assert.equal(capabilityNote(task({ status: "ready" }), dsh), null);
  assert.equal(capabilityNote(task({ status: "working" }), RICH["claude-code"].capabilities), null);
});

test("capabilityNote: never fires a capability-gap note merely from a declaration", () => {
  // A provider with structured events but no declared file dimension —
  // exactly the "activity visible, files unsupported" shape the spec
  // considered and this implementation deliberately keeps silent about.
  const note = capabilityNote(task({ status: "working" }), PARTIAL["some-acp-agent"].capabilities);
  assert.equal(note, null);
});

// --- progressive fidelity ----------------------------------------------------------

test("fidelity is a declaration, never an inference from the event log", () => {
  assert.equal(fidelity("claude-code", RICH), "rich");
  assert.equal(fidelity("some-acp-agent", PARTIAL), "partial");
  assert.equal(fidelity("deepseek-harness", COARSE), "coarse");
  // Unknown or unregistered provider -> coarse, never claim more than declared.
  assert.equal(fidelity("some-future-harness", RICH), "coarse");
  assert.equal(fidelity(undefined, RICH), "coarse");
});

test("a rich provider with no steps yet reads as rich, not coarse, with nothing to show", () => {
  const row = projectRow(task({ status: "working" }), log([["run.started", 0, {}]]), {
    open: true,
    providers: RICH
  });
  assert.equal(row.coarse, false);
  assert.equal(row.fidelity, "rich");
  assert.equal(row.activitySection, null);
  assert.equal(row.filesSection, null);
});

test("a coarse provider draws the single ambient trace, never the old three-phase frame", () => {
  const events = log([
    ["run.started", 0, {}],
    ["run.completed", 40, { status: "ready" }]
  ]);
  const row = projectRow(coarseTask({ status: "working" }), events, {
    open: true,
    providers: COARSE
  });
  assert.equal(row.coarse, true);
  assert.equal(row.trace.cells.filter(c => c.ambient).length, 1);
  assert.equal(row.trace.cells.length <= 2, true);
});

test("a coarse working row carries the result-on-completion note and no data sections", () => {
  const row = projectRow(coarseTask({ status: "working" }), [], { open: true, providers: COARSE });
  assert.equal(row.note, "result reported on completion");
  assert.equal(row.activitySection, null);
  assert.equal(row.filesSection, null);
});

// --- section visibility by lifecycle status (§10) -----------------------------

test("working shows ACTIVITY/FILES/COMMANDS when present; needs_you drops COMMANDS", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 2, { path: "a.ts" }],
    ["tool.started", 3, { name: "Bash", input: { command: "npm test" } }]
  ]);
  const working = projectRow(task({ status: "working" }), events, { open: true, providers: RICH });
  assert.ok(working.activitySection);
  assert.ok(working.filesSection);
  assert.ok(working.commandsSection);
  assert.equal(working.layout, "trace-primary");

  const needsYou = projectRow(
    task({ status: "needs_you", blockedOn: { type: "permission" } }),
    events,
    { open: true, providers: RICH }
  );
  assert.ok(needsYou.activitySection);
  assert.ok(needsYou.filesSection);
  assert.equal(needsYou.commandsSection, null);
});

test("ready shows RESULT-eligible FILES/COMMANDS and a provenance trace, never ACTIVITY", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 1, { path: "a.ts" }],
    ["tool.started", 4, { name: "Bash", input: { command: "npm test" } }],
    ["run.completed", 5, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "ready" }), events, { open: true, providers: RICH });
  assert.equal(row.layout, "answer-primary");
  assert.equal(row.activitySection, null);
  assert.ok(row.filesSection);
  assert.ok(row.commandsSection);
  assert.ok(row.provenance);
  assert.equal(row.provenance.heading, "PROVENANCE");
  assert.equal(row.trace, null);
});

test("failed shows FAILURE and FILES but never COMMANDS; provenance is labelled before the stop", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 1, { path: "a.ts" }],
    ["tool.started", 2, { name: "Bash", input: { command: "npm test" } }],
    ["run.failed", 3, { error: "boom" }]
  ]);
  const row = projectRow(task({ status: "failed", error: "boom" }), events, { open: true, providers: RICH });
  assert.ok(row.filesSection);
  assert.equal(row.commandsSection, null);
  assert.equal(row.provenance.heading, "BEFORE THE STOP");
});

test("done carries no trace at all — the whole fix for the old three-empty-band screen", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 9, { name: "Edit", input: { file_path: "a.ts" } }],
    ["file.changed", 9, { path: "a.ts" }],
    ["run.completed", 14, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "done" }), events, { open: true, providers: RICH });
  assert.equal(row.layout, "answer-primary");
  assert.equal(row.trace, null);
  assert.equal(row.provenance, null);
  assert.equal(row.activitySection, null);
  assert.equal(row.filesSection, null);
  assert.deepEqual(row.mini, []);

  // A task still in flight keeps its mini trace.
  const live = projectRow(task({ status: "working" }), events, { providers: RICH });
  assert.ok(live.mini.length > 0);
});

test("a coarse ready row reports files as absent (no section), not as zero", () => {
  const coarseRow = projectRow(coarseTask({ status: "ready" }), [], { open: true, providers: COARSE });
  assert.equal(coarseRow.filesSection, null);
  assert.deepEqual(coarseRow.files, []);
  assert.equal(coarseRow.arg, "");

  // A rich provider that genuinely changed nothing also shows no section —
  // the RESULT text carries the answer, never a confident zero.
  const richRow = projectRow(task({ status: "ready" }), [], { open: true, providers: RICH });
  assert.equal(richRow.filesSection, null);
});

// --- everything else projectRow already covered ------------------------------

test("projectRow renders the Needs You state from the normalized blockedOn", () => {
  const blocked = task({
    status: "needs_you",
    blockedOn: {
      type: "permission",
      tool: "Edit",
      file: "/w/services/capture/submit-capture.ts",
      plannedChange: "reconcile the retry window",
      raw: { tool_name: "Edit" }
    }
  });
  const events = log([["tool.started", 1, { name: "Edit", input: { file_path: "/w/services/capture/submit-capture.ts" } }]]);
  const row = projectRow(blocked, events, { base: "/w", open: true });

  assert.equal(row.stateLabel, "NEEDS YOU");
  assert.equal(row.stateColor, "#2f5fa8");
  assert.equal(row.permTitle, "PERMISSION REQUIRED");
  assert.equal(row.permPath, "services/capture/submit-capture.ts");
  assert.equal(row.permWhy, "reconcile the retry window");
  assert.ok(row.permDetail.includes("Edit"));
  assert.equal(row.phaseLabel, "HALTED AT");
  assert.equal(row.halted, true);
  assert.equal(row.num, "/01");
});

test("projectRow renders a decision block, not just permissions", () => {
  const blocked = task({
    status: "needs_you",
    blockedOn: { type: "decision", text: "two viable approaches" }
  });
  const row = projectRow(blocked, [], { open: true });
  assert.equal(row.permTitle, "DECISION REQUIRED");
  assert.equal(row.permWhy, "two viable approaches");
  assert.equal(row.permPath, "");
  // The interaction surface must keep the two kinds of halt apart: a
  // decision is answered, never allowed/rejected.
  assert.equal(row.permType, "decision");
  assert.equal(row.providerId, "claude-code");
});

test("projectRow distinguishes permission from decision for the interaction surface", () => {
  const permission = task({
    status: "needs_you",
    blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
  });
  const decision = task({
    status: "needs_you",
    blockedOn: { type: "decision", text: "which backend?" }
  });
  assert.equal(projectRow(permission, [], { open: true }).permType, "permission");
  assert.equal(projectRow(decision, [], { open: true }).permType, "decision");
  assert.equal(projectRow(task({ status: "ready" }), [], { open: true }).permType, null);
  assert.equal(projectRow(decision, [], { open: true }).providerId, "claude-code");
});

test("projectRow renders the ready result from the files the run actually changed", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "/w/src/a.ts" } }],
    ["file.changed", 1, { path: "/w/src/a.ts" }],
    ["tool.started", 4, { name: "Bash", input: { command: "npm test" } }],
    ["run.completed", 5, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "ready" }), events, { base: "/w", open: true, providers: RICH });
  assert.equal(row.ready, true);
  assert.equal(row.stateLabel, "READY");
  assert.deepEqual(row.files, ["src/a.ts"]);
  assert.equal(row.phaseLabel, "COMPLETE");
  assert.equal(row.arg, "1 file changed");
  assert.equal(row.sub, "1 file · ready for you");
  // The clock measures the run (first event -> last event), not the wall
  // time since the task was filed.
  assert.equal(row.elapsed, "0:04");
});

test("projectRow compresses a done task and drops its trace, as the design does", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 9, { name: "Edit", input: { file_path: "a.ts" } }],
    ["run.completed", 14, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "done" }), events, { providers: RICH });

  assert.equal(row.compact, true);
  assert.equal(row.titleSize, "15px");
  assert.equal(row.titleWeight, 400);
  assert.equal(row.titleColor, "#5c6771");
  assert.match(row.sub, /^closed · /);
  assert.deepEqual(row.mini, []);
});

test("a closed row's sub keeps a fixed width so EXECUTION reads as a grid", () => {
  const NBSP = " ";
  const closed = seconds => projectRow(task({ status: "done" }), log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["run.completed", seconds + 1, { status: "ready" }]
  ]), { providers: RICH }).sub;

  assert.equal(closed(127), "closed · " + NBSP.repeat(3) + "2:07");
  assert.equal(closed(601), "closed · " + NBSP.repeat(2) + "10:01");
  assert.equal(closed(33), "closed · " + NBSP.repeat(3) + "0:33");
  assert.equal(closed(903), "closed · " + NBSP.repeat(2) + "15:03");
  assert.equal(closed(3847), "closed · 1:04:07");
  assert.equal(closed(0), "closed · " + NBSP.repeat(3) + "0:00");
  const widths = new Set([closed(127), closed(601), closed(33), closed(903), closed(3847), closed(0)].map(s => s.length));
  assert.equal(widths.size, 1);
  assert.equal([...widths][0], 16);
});

test("projectRow surfaces failure, a state the design does not draw", () => {
  const row = projectRow(task({ status: "failed", error: "claude exited 1" }), [], { open: true });
  assert.equal(row.stateLabel, "FAILED");
  assert.equal(row.stateColor, "#b8532a");
  assert.equal(row.phaseLabel, "FAILED AT");
  assert.equal(row.arg, "claude exited 1");
});

test("execution metadata is secondary: node and provider, never the headline", () => {
  const row = projectRow(task(), [], { open: true });
  assert.equal(row.node, "local / claude-code");
  assert.equal(row.title, "investigate the correction lifecycle");
  const other = projectRow(
    task({ execution: { provider: "codex", node: "mini", workspace: "local" } }),
    [],
    { open: true }
  );
  assert.equal(other.node, "mini / codex");
  assert.equal(other.stateLabel, "WORKING");
});

test("the ledger orders by what wants you first and opens a halted task", () => {
  const tasks = [
    task({ id: 1, status: "done" }),
    task({ id: 2, status: "ready" }),
    task({ id: 3, status: "working" }),
    task({ id: 4, status: "needs_you", blockedOn: { type: "permission" } }),
    task({ id: 5, status: "working" })
  ];
  const ledger = projectLedger(tasks, {}, { selectedId: 3 });

  assert.deepEqual(ledger.rows.map(r => r.id), [4, 5, 3, 2, 1]);
  assert.equal(ledger.rows.find(r => r.id === 4).open, true);
  assert.equal(ledger.rows.find(r => r.id === 3).selected, true);
  assert.equal(ledger.countNeeds, "01");
  assert.equal(ledger.countWorking, "02");
  assert.equal(ledger.countReady, "01");
});

test("ledger helpers", () => {
  assert.equal(fmtDuration(0), "0:00");
  assert.equal(fmtDuration(95), "1:35");
  assert.equal(relativePath("/w", "/w/src/a.ts"), "src/a.ts");
  assert.equal(relativePath("/w", "/other/a.ts"), "/other/a.ts");
  assert.equal(blockedTitle(null), "");
  assert.deepEqual(counts([task({ status: "ready" }), task({ status: "ready" })]).ready, 2);
  assert.deepEqual(
    sortTasks([task({ id: 1, status: "working" }), task({ id: 2, status: "working" })]).map(t => t.id),
    [2, 1]
  );
});

test("a run measured in hours reads as hours, not as 479 minutes", () => {
  assert.equal(fmtDuration(59 * 60 + 59), "59:59");
  assert.equal(fmtDuration(60 * 60), "1:00:00");
  assert.equal(fmtDuration(8 * 3600 + 23 * 60 + 4), "8:23:04");
});

// --- run history ------------------------------------------------------------

test("projectRuns formats run records into ledger rows without inventing fields", () => {
  const providers = {
    "claude-code": "Claude Code",
    "deepseek-harness": "DeepSeek Harness"
  };
  const runs = projectRuns(
    [
      {
        run: 1,
        provider: "claude-code",
        node: "local",
        model: "claude-3-5",
        startedAt: "2026-01-01T10:00:00.000Z",
        completedAt: "2026-01-01T10:04:12.000Z",
        durationMs: 252000,
        outcome: "ready",
        externalSessionId: "sess-1",
        attempts: 2
      },
      {
        run: 2,
        provider: "deepseek-harness",
        node: "local",
        startedAt: "2026-01-01T11:00:00.000Z",
        completedAt: "2026-01-01T11:02:48.000Z",
        durationMs: 168000,
        outcome: "ready",
        attempts: 1
      },
      { run: 3, provider: "codex", node: "mini", outcome: "failed", error: "boom", legacy: true }
    ],
    { providers }
  );

  assert.equal(runs[0].num, "01");
  assert.equal(runs[0].provider, "CLAUDE CODE");
  assert.equal(runs[0].duration, "4:12");
  assert.equal(runs[0].state, "READY");
  assert.equal(runs[0].model, "claude-3-5");
  assert.equal(runs[0].attempts, 2);
  assert.equal(runs[1].provider, "DEEPSEEK HARNESS");
  assert.equal(runs[1].duration, "2:48");
  assert.equal(runs[1].model, null);
  assert.equal(runs[2].provider, "CODEX");
  assert.equal(runs[2].duration, null);
  assert.equal(runs[2].state, "FAILED");
  assert.equal(runs[2].stateColor, "#b8532a");
  assert.equal(runs[2].legacy, true);
});

test("projectRuns maps needs_you/working states into the ledger vocabulary", () => {
  const runs = projectRuns([
    { run: 1, provider: "claude-code", outcome: "needs_you", blockedOn: { type: "permission" } },
    { run: 2, provider: "deepseek-harness", outcome: "working" }
  ]);
  assert.equal(runs[0].state, "NEEDS YOU");
  assert.equal(runs[0].stateColor, "#2f5fa8");
  assert.equal(runs[1].state, "WORKING");
});

test("projectRow exposes interactive permission options without inventing them", () => {
  const blocked = task({
    status: "needs_you",
    blockedOn: {
      type: "permission",
      live: true,
      tool: "Edit submit-capture.ts",
      file: "/w/src/submit-capture.ts",
      description: "Edit submit-capture.ts",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      canAllow: true,
      canReject: false
    }
  });
  const row = projectRow(blocked, [], { base: "/w", open: true });
  assert.equal(row.permLive, true);
  assert.equal(row.permAllowable, true);
  assert.equal(row.permRejectable, false);
  assert.equal(row.permOptions.length, 1);
  assert.equal(row.permOptions[0].kind, "allow_once");
  assert.equal(row.permPath, "src/submit-capture.ts");
  assert.equal(row.permWhy, "Edit submit-capture.ts");
});

test("a long intent keeps the expanded heading proportionate (smallest typography adjustment)", () => {
  const long =
    "Inspect the current CLI output for '2f providers'. Find one small usability improvement that would make provider availability or integration type easier to scan. Do not modify code yet.";
  const short = task().title;
  assert.ok(long.length > 90, "the fixture should exceed the long-title threshold");
  assert.ok(short.length <= 90, "the default fixture should stay a short title");

  assert.equal(projectRow(task({ title: long }), [], { open: true, mid: true }).titleSize, "24px");
  assert.equal(projectRow(task({ title: long }), [], { open: true, mid: false }).titleSize, "24px");
  assert.equal(projectRow(task(), [], { open: true, mid: true }).titleSize, "31px");
  assert.equal(projectRow(task(), [], { open: true, mid: false }).titleSize, "24px");
  const halted = task({ title: long, status: "needs_you", blockedOn: { type: "permission" } });
  assert.equal(projectRow(halted, [], { open: true, mid: true }).titleSize, "26px");
  assert.equal(projectRow(task({ status: "needs_you", blockedOn: { type: "permission" } }), [], { open: true, mid: true }).titleSize, "34px");

  assert.equal(projectRow(task({ title: long }), [], { open: false }).titleSize, "17.5px");
  assert.equal(projectRow(task({ title: long }), [], { open: true }).title, long);
});

test("projectRow exposes the AUTO routing decision of the current run", () => {
  const routed = task({
    runs: [
      { run: 1, provider: "alpha", outcome: "ready", routing: { mode: "auto", reason: "preferred compatible provider", considered: ["alpha", "beta"] } }
    ]
  });
  const row = projectRow(routed, [], {});
  assert.deepEqual(row.routed, { provider: "alpha", reason: "preferred compatible provider" });

  const manual = projectRow(task({ runs: [{ run: 1, provider: "alpha", outcome: "ready" }] }), [], {});
  assert.equal(manual.routed, null);
  assert.equal(projectRow(task(), [], {}).routed, null);
});

test("time parked on a human is not counted in the trace's tail selection", () => {
  const events = log([
    ["tool.started", 0, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 10, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 12, { reason: "permission", blockedOn: { type: "permission" } }]
  ]);
  const blocked = task({ status: "needs_you", blockedOn: { type: "permission", file: "a.ts" } });
  // "now" is an hour after the halt: the HALTED-AT clock grows, the trace
  // still shows exactly the two real units, never a synthesized gap.
  const row = projectRow(blocked, events, {
    open: true,
    providers: RICH,
    now: Date.parse("2026-01-01T11:00:00.000Z")
  });
  const marks = row.trace.cells.filter(c => !c.isHalt);
  assert.equal(marks.length, 2);
});

// --- §03: the decision question is prose, not a label -----------------------

test("firstSentence: a one-line question is the whole heading, nothing left over", () => {
  const q = "Should the retry budget be per-run or per-task?";
  assert.equal(firstSentence(q), q);
  assert.equal(restAfterFirstSentence(q), "");
});

test("firstSentence: splits a multi-paragraph question at its first sentence", () => {
  const q =
    "Should the retry budget be per-run or per-task?\n\n" +
    "Run 2 restarted the whole pipeline because the budget is attached to the run record.";
  assert.equal(firstSentence(q), "Should the retry budget be per-run or per-task?");
  assert.equal(
    restAfterFirstSentence(q),
    "Run 2 restarted the whole pipeline because the budget is attached to the run record."
  );
});

test("firstSentence: a question with no terminal punctuation is still a valid heading", () => {
  assert.equal(firstSentence("pick a database"), "pick a database");
  assert.equal(restAfterFirstSentence("pick a database"), "");
});

test("projectRow splits a decision's question into heading + body for the card to render", () => {
  const blocked = task({
    status: "needs_you",
    blockedOn: {
      type: "decision",
      text:
        "Which backend should we standardize on? Postgres is already used elsewhere; " +
        "SQLite would need no new infra."
    }
  });
  const row = projectRow(blocked, [], { open: true });
  assert.equal(row.permQuestionHeading, "Which backend should we standardize on?");
  assert.equal(
    row.permQuestionBody,
    "Postgres is already used elsewhere; SQLite would need no new infra."
  );
  // permWhy is kept verbatim too — existing consumers (the mobile queue
  // preview) are unaffected by the new split fields.
  assert.equal(row.permWhy, blocked.blockedOn.text);
});

test("a permission halt (not a decision) has no question split — permWhy is used as-is", () => {
  const blocked = task({
    status: "needs_you",
    blockedOn: { type: "permission", file: "a.ts", plannedChange: "old  →  new" }
  });
  const row = projectRow(blocked, [], { open: true });
  assert.equal(row.permQuestionHeading, "");
  assert.equal(row.permQuestionBody, "");
});

// --- §01: provider-not-authenticated is not a task breakage ------------------

const WITH_NAMES = {
  "claude-code": { displayName: "Claude Code", capabilities: RICH["claude-code"].capabilities }
};

test("inferFailureKind: an explicit task.failure.kind is trusted as-is", () => {
  assert.equal(inferFailureKind({ failure: { kind: "auth" }, error: "irrelevant" }), "auth");
  assert.equal(inferFailureKind({ failure: { kind: "crashed" }, error: "" }), "crashed");
});

test("inferFailureKind: legacy tasks with no failure field are inferred from the stored error", () => {
  assert.equal(
    inferFailureKind({
      error: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."
    }),
    "auth"
  );
  assert.equal(inferFailureKind({ error: "npm test failed" }), null);
  assert.equal(inferFailureKind({ error: "" }), null);
});

test("authFailureCopy: with a remedy, the hint is shown verbatim in its own slot", () => {
  const copy = authFailureCopy("Claude Code", "MBP-14", "claude /login");
  assert.equal(
    copy.sentence,
    "Claude Code's authentication is no longer valid. 0x2F cannot authenticate a provider for you."
  );
  assert.equal(copy.hintLabel, "ON MBP-14");
  assert.equal(copy.hint, "claude /login");
});

test("authFailureCopy: without a remedy, a generic sign-in sentence names the provider and machine", () => {
  const copy = authFailureCopy("Gemini CLI", "MBP-14", null);
  assert.equal(copy.hintLabel, null);
  assert.equal(copy.hint, null);
  assert.equal(
    copy.instruction,
    "Sign in to Gemini CLI on MBP-14, then RETRY. The task and its runs are kept."
  );
});

test("authFailureLine: the one-line summary shared by the compact row, arg and mobile", () => {
  assert.equal(authFailureLine("Claude Code", "MBP-14"), "claude code is not authenticated on MBP-14");
  assert.equal(authFailureLine("Claude Code", ""), "claude code is not authenticated");
});

test("projectRow: a classified auth failure reads STOPPED AT, not FAILED AT", () => {
  const failed = task({
    status: "failed",
    error: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    failure: { kind: "auth", remedy: "claude /login" }
  });
  const row = projectRow(failed, [], { open: true, providers: WITH_NAMES, node: "MBP-14" });
  assert.equal(row.phaseLabel, "STOPPED AT");
  assert.equal(row.arg, "claude code is not authenticated on MBP-14");
  assert.equal(row.sub, "claude code is not authenticated on MBP-14");
  assert.equal(row.failureKind, "auth");
  assert.equal(row.failureRemedy, "claude /login");
  assert.equal(row.failureProviderName, "Claude Code");
  assert.equal(row.failureCopy.hint, "claude /login");
  // The raw vendor text is never discarded — it's demoted, not deleted.
  assert.equal(row.error, failed.error);
});

test("projectRow: an unclassified failure is completely unaffected by the new fields", () => {
  const failed = task({ status: "failed", error: "npm test failed with 3 failing specs" });
  const row = projectRow(failed, [], { open: true, providers: WITH_NAMES, node: "MBP-14" });
  assert.equal(row.phaseLabel, "FAILED AT");
  assert.equal(row.arg, "npm test failed with 3 failing specs");
  assert.equal(row.failureKind, null);
  assert.equal(row.failureCopy, null);
});

// Guard (§03, section 04's implementation notes): a decision question's body
// can legitimately contain a fenced code block (the agent quoting the exact
// snippet the tradeoff turns on) — the heading/body split must not corrupt
// it, and the shared rich-text parser must still recognize it as a distinct
// code block once it lands in the body.
test("a decision question with a fenced code block in its body renders intact", () => {
  const question =
    "Should retries back off exponentially?\n\n" +
    "Today's loop is:\n\n" +
    "```js\nfor (let i = 0; i < 3; i++) attempt();\n```\n\n" +
    "A flat retry storms the API under sustained failure.";
  const blocked = task({ status: "needs_you", blockedOn: { type: "decision", text: question } });
  const row = projectRow(blocked, [], { open: true });
  assert.equal(row.permQuestionHeading, "Should retries back off exponentially?");
  assert.ok(row.permQuestionBody.includes("```js"));
  assert.ok(row.permQuestionBody.includes("for (let i = 0; i < 3; i++) attempt();"));

  const blocks = parseRich(row.permQuestionBody);
  const code = blocks.find(b => b.type === "code");
  assert.ok(code, "the fence must still parse as a distinct code block, not paragraph prose");
  assert.equal(code.lang, "js");
  assert.equal(code.text, "for (let i = 0; i < 3; i++) attempt();");
});

// --- the task brief in a detail view ----------------------------------------
//
// A detail view shows the derived title as its heading. It must ALSO show the
// brief the user wrote — otherwise shortening the title would take away the
// user's own words, which is the one thing they actually authored. But it
// must not show it twice: when the title already says everything the brief
// says, the body is empty and a one-line task looks exactly as it did before
// briefs existed.
//
// The decision is delegated to the SAME derivation core used to name the
// task (core/title.mjs), never to a `brief !== title` string comparison.

test("briefBody is empty when the derived title already represents the whole brief", () => {
  const row = projectRow(task({ title: "fix the login redirect", brief: "fix the login redirect" }), [], { open: true });
  assert.equal(row.brief, "fix the login redirect");
  assert.equal(row.briefBody, "", "nothing to render — the heading already said it");
});

// The adjustment that a naive inequality gets wrong: the brief and the title
// are DIFFERENT STRINGS here, yet the title represents all of it.
test("a decorated or wrapped brief does not render a body that only repeats the heading", () => {
  for (const brief of ["# Fix the login redirect", "- Fix the login redirect", "  Fix the login redirect  "]) {
    const row = projectRow(task({ title: "Fix the login redirect", brief }), [], { open: true });
    assert.notEqual(row.brief, row.title, "the raw strings differ — a `!==` check would render a body");
    assert.equal(row.briefBody, "", brief);
  }
});

test("a real multi-paragraph brief renders in full under the heading", () => {
  const brief =
    "Audit the authentication boundary for token leakage.\n\n" +
    "Scope\n- every path that reads or writes the per-runtime auth token\n" +
    "- the pairing ceremony\n\nConstraints\n- no new dependencies";
  const row = projectRow(
    task({ title: "Audit the authentication boundary for token leakage.", brief }),
    [],
    { open: true }
  );
  // The body is the brief MINUS the sentence the heading already is — the
  // heading is never printed twice (the same split the decision card uses).
  assert.ok(!row.briefBody.startsWith("Audit the authentication boundary"),
    "the heading sentence must not be repeated as the body's first line");
  assert.ok(row.briefBody.startsWith("Scope"));
  assert.ok(row.briefBody.includes("no new dependencies"), "the rest of the brief is intact");
  // And it survives the shared rich-text subset as structure, not one blob.
  const blocks = parseRich(row.briefBody);
  assert.ok(blocks.some(b => b.type === "list"), "the Scope list must parse as a list");
});

test("a task written before briefs existed renders no duplicate body", () => {
  // Legacy shape: a title, no brief. The title WAS the full text then, so
  // falling back to it must not produce a body repeating the heading.
  const legacy = task({ title: "investigate the correction lifecycle" });
  delete legacy.brief;
  const row = projectRow(legacy, [], { open: true });
  assert.equal(row.brief, "investigate the correction lifecycle");
  assert.equal(row.briefBody, "");
});

test("briefTruncated is carried through so a cut remote brief can say it was cut", () => {
  const plain = projectRow(task({ title: "t", brief: "t" }), [], { open: true });
  assert.equal(plain.briefTruncated, false);
  const cut = projectRow(task({ title: "t", brief: "t and more", briefTruncated: true }), [], { open: true });
  assert.equal(cut.briefTruncated, true);
});
