// The Web ledger projection: normalized Work events -> what the browser draws.
//
// This is the same module the browser imports (served at /app/ledger.mjs), so
// these tests cover the production rendering path, not a copy of it. They
// assert the DESIGN's behaviour — phases, the travel rule, Needs You, the
// Ready result, compressed done rows — against REAL normalized events.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASES,
  classifyPhase,
  stepArgument,
  toSteps,
  trace,
  bands,
  projectRow,
  projectLedger,
  sortTasks,
  counts,
  fmtDuration,
  relativePath,
  blockedTitle,
  eventsForRun,
  projectRuns,
  isRichProvider
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

test("phase classification is provider-neutral and never throws on unknown tools", () => {
  assert.equal(classifyPhase("Read", "src/a.ts"), "inspect");
  assert.equal(classifyPhase("Grep", "foo"), "inspect");
  assert.equal(classifyPhase("Edit", "src/a.ts"), "act");
  assert.equal(classifyPhase("write_file", "src/a.ts"), "act");
  assert.equal(classifyPhase("Bash", "pnpm test capture"), "verify");
  assert.equal(classifyPhase("shell", "npm run lint"), "verify");
  assert.equal(classifyPhase("apply_patch", "src/a.ts"), "act");
  // An unknown tool inherits the phase already in progress rather than
  // inventing one — a future harness cannot break the ledger.
  assert.equal(classifyPhase("quantum_thing", "", "act"), "act");
  assert.equal(classifyPhase("quantum_thing", ""), "inspect");
  assert.deepEqual(PHASES, ["inspect", "act", "verify"]);
});

test("stepArgument reads whatever the tool input names as its target", () => {
  assert.equal(stepArgument({ file_path: "/w/src/a.ts" }), "/w/src/a.ts");
  assert.equal(stepArgument({ command: "pnpm test" }), "pnpm test");
  assert.equal(stepArgument({ pattern: "heldCaptures" }), "heldCaptures");
  assert.equal(stepArgument({}), "");
});

test("toSteps turns a real event log into ordered steps, files and activity", () => {
  const events = log([
    ["run.started", 0, { sessionId: "sess-1" }],
    ["tool.started", 2, { name: "Read", input: { file_path: "/w/src/a.ts" } }],
    ["progress", 3, { text: "looking at   the retry window" }],
    ["tool.started", 6, { name: "Edit", input: { file_path: "/w/src/a.ts" } }],
    ["file.changed", 6, { path: "/w/src/a.ts" }],
    ["tool.started", 9, { name: "Bash", input: { command: "npm test" } }]
  ]);

  const { steps, files, activity, sessionId } = toSteps(task(), events);

  assert.deepEqual(steps.map(s => s.verb), ["READ", "EDIT", "BASH"]);
  assert.deepEqual(steps.map(s => s.phase), ["inspect", "act", "verify"]);
  assert.deepEqual(steps.map(s => Math.round(s.t)), [2, 6, 9]);
  assert.deepEqual(files, ["/w/src/a.ts"]);
  assert.equal(sessionId, "sess-1");
  // The progress line is narration, not a step — it becomes the activity
  // line and is cleared by the next real step.
  assert.equal(activity, "");
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

test("the travel rule draws executed work only — never scheduled work it cannot know", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 3, { name: "Edit", input: { file_path: "a.ts" } }]
  ]);
  const { steps } = toSteps(task(), events);
  const laid = trace(steps, { live: true, halted: false, finished: false });

  assert.deepEqual(laid.groups.map(g => g.label), ["INSPECT", "ACT"]);
  // The point of execution is the luminous head, and it is the last cell.
  const cells = laid.groups.flatMap(g => g.cells);
  assert.equal(cells.filter(c => c.isHead).length, 1);
  assert.equal(cells[cells.length - 1].isHead, true);
  // Nothing faint/scheduled is drawn ahead of it.
  assert.equal(cells.filter(c => c.c === "#c6cfd6").length, 0);
});

test("an interruption tears the track open instead of capping it", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 2, { reason: "permission", blockedOn: { type: "permission" } }]
  ]);
  const { steps } = toSteps(task({ status: "needs_you" }), events);
  const laid = trace(steps, { live: false, halted: true, finished: false });
  const cells = laid.groups.flatMap(g => g.cells);
  assert.equal(cells.filter(c => c.isHalt).length, 1);
  assert.equal(cells.filter(c => c.isHead).length, 0);
});

test("a finished run's track is struck in graphite, with no head", () => {
  const events = log([["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }]]);
  const { steps } = toSteps(task({ status: "ready" }), events);
  const cells = trace(steps, { live: false, halted: false, finished: true }).groups.flatMap(g => g.cells);
  assert.ok(cells.length > 0);
  assert.ok(cells.every(c => c.c === "#2f2f2f"));
});

test("a long run is strided down so the track stays one line wide", () => {
  const many = [];
  for (let i = 0; i < 400; i++) many.push(["tool.started", i, { name: "Read", input: { file_path: "a" + i } }]);
  const { steps } = toSteps(task(), log(many));
  const laid = trace(steps, { budget: 66, live: true });
  const cells = laid.groups.flatMap(g => g.cells).length;
  assert.ok(cells <= 70, "expected the track to stay bounded, got " + cells);
});

test("bands group the run into investigation / change / verification", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 3, { name: "Grep", input: { pattern: "heldCaptures" } }],
    ["tool.started", 6, { name: "Edit", input: { file_path: "a.ts" } }],
    ["tool.started", 9, { name: "Bash", input: { command: "npm test" } }]
  ]);
  const { steps } = toSteps(task(), events);
  const [investigation, change, verification] = bands(task(), steps);

  assert.equal(investigation.label, "INVESTIGATION");
  assert.equal(investigation.items.length, 2);
  assert.match(investigation.meta, /2 steps/);
  assert.equal(change.items.length, 1);
  assert.equal(verification.items.length, 1);
  // The band the run is standing in is the one that reads as live.
  assert.equal(verification.meta, "1 step · 0:00");
  assert.equal(verification.rule, "2px solid #2f2f2f");
});

test("an empty band says what it is waiting for rather than showing nothing", () => {
  const [investigation, change] = bands(task(), []);
  assert.equal(investigation.pending, true);
  assert.equal(change.pendingText, "awaiting investigation");
});

test("a halted band waits on you", () => {
  const events = log([["tool.started", 1, { name: "Edit", input: { file_path: "a.ts" } }]]);
  const { steps } = toSteps(task({ status: "needs_you" }), events);
  const change = bands(task({ status: "needs_you" }), steps)[1];
  assert.equal(change.meta, "1 step · 0:00");
  assert.equal(change.rule, "2px solid #2f5fa8");
});

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

test("projectRow renders the ready result from the files the run actually changed", () => {
  const events = log([
    ["tool.started", 1, { name: "Edit", input: { file_path: "/w/src/a.ts" } }],
    ["file.changed", 1, { path: "/w/src/a.ts" }],
    ["tool.started", 4, { name: "Bash", input: { command: "npm test" } }],
    ["run.completed", 5, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "ready" }), events, { base: "/w", open: true });
  assert.equal(row.ready, true);
  assert.equal(row.stateLabel, "READY");
  assert.deepEqual(row.files, ["src/a.ts"]);
  assert.equal(row.phaseLabel, "COMPLETE");
  assert.equal(row.arg, "1 file changed");
  // The clock measures the run (first event -> last event), not the wall
  // time since the task was filed.
  assert.equal(row.elapsed, "0:04");
});

test("projectRow compresses a done task and drops its mini track", () => {
  const events = log([["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }]]);
  const row = projectRow(task({ status: "done" }), events, {});
  assert.equal(row.compact, true);
  assert.equal(row.titleSize, "15px");
  assert.equal(row.titleColor, "#5c6771");
  assert.deepEqual(row.mini, []);
  assert.match(row.sub, /^closed · /);
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
  // A different harness on a different node changes only that line.
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

test("step arguments and changed files are shown as project paths, not machine paths", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "/w/services/capture/ingest.ts" } }],
    ["tool.started", 2, { name: "Edit", input: { file_path: "/w/services/capture/ingest.ts" } }],
    ["file.changed", 2, { path: "/w/services/capture/ingest.ts" }]
  ]);
  const { steps, files } = toSteps(task(), events, { base: "/w" });
  assert.deepEqual(steps.map(s => s.arg), [
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
      // A legacy run with no timing: duration stays absent, shown as "—".
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
  assert.equal(runs[1].model, null); // DSH never surfaced a model — absent
  // An unknown provider id falls back to the id itself.
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
      canReject: false // no reject option supplied — ALLOW only, never guessed
    }
  });
  const row = projectRow(blocked, [], { base: "/w", open: true });
  assert.equal(row.permLive, true);
  assert.equal(row.permAllowable, true);
  assert.equal(row.permRejectable, false);
  assert.equal(row.permOptions.length, 1);
  assert.equal(row.permOptions[0].kind, "allow_once");
  assert.equal(row.permPath, "src/submit-capture.ts");
  assert.equal(row.permWhy, "Edit submit-capture.ts"); // description fallback
});

test("a long intent keeps the expanded heading proportionate (smallest typography adjustment)", () => {
  const long =
    "Inspect the current CLI output for '2f providers'. Find one small usability improvement that would make provider availability or integration type easier to scan. Do not modify code yet.";
  const short = task().title;
  assert.ok(long.length > 90, "the fixture should exceed the long-title threshold");
  assert.ok(short.length <= 90, "the default fixture should stay a short title");

  // Long intents drop to the narrow heading size at any width.
  assert.equal(projectRow(task({ title: long }), [], { open: true, mid: true }).titleSize, "24px");
  assert.equal(projectRow(task({ title: long }), [], { open: true, mid: false }).titleSize, "24px");
  // Short intents keep the current treatment exactly.
  assert.equal(projectRow(task(), [], { open: true, mid: true }).titleSize, "31px");
  assert.equal(projectRow(task(), [], { open: true, mid: false }).titleSize, "24px");
  // A long halted intent is proportionate too.
  const halted = task({ title: long, status: "needs_you", blockedOn: { type: "permission" } });
  assert.equal(projectRow(halted, [], { open: true, mid: true }).titleSize, "26px");
  assert.equal(projectRow(task({ status: "needs_you", blockedOn: { type: "permission" } }), [], { open: true, mid: true }).titleSize, "34px");

  // Collapsed rows keep the compact size regardless of intent length.
  assert.equal(projectRow(task({ title: long }), [], { open: false }).titleSize, "17.5px");
  // The persisted intent is never truncated by the projection.
  assert.equal(projectRow(task({ title: long }), [], { open: true }).title, long);
});

test("after a terminal failure, downstream bands read as not reached, not awaiting", () => {
  const events = log([
    ["tool.started", 1, { name: "Read", input: { file_path: "a.ts" } }],
    ["run.failed", 2, { error: "spawn dsh ENOENT" }]
  ]);
  const failed = task({ status: "failed", error: "spawn dsh ENOENT" });
  const { steps } = toSteps(failed, events);
  const [investigation, change, verification] = bands(failed, steps);

  // The phase that was standing when the run failed keeps its steps; the
  // phases that can no longer execute say so instead of "awaiting".
  assert.ok(investigation.items.length >= 1);
  assert.equal(change.pendingText, "not reached");
  assert.equal(change.meta, "not reached");
  assert.equal(verification.pendingText, "not reached");

  // A task closed from a failure reads the same way (existing state — the
  // error survives close — never a new lifecycle state).
  const closedFromFailure = bands(task({ status: "done", error: "spawn dsh ENOENT" }), steps);
  assert.equal(closedFromFailure[1].pendingText, "not reached");

  // Live and completed runs keep the historical wording; only the terminal
  // failure presentation changed.
  assert.equal(bands(task(), steps)[1].pendingText, "awaiting investigation");
  assert.equal(bands(task({ status: "ready" }), steps)[1].pendingText, "awaiting investigation");
});

test("projectRow exposes the AUTO routing decision of the current run", () => {
  const routed = task({
    runs: [
      { run: 1, provider: "alpha", outcome: "ready", routing: { mode: "auto", reason: "preferred compatible provider", considered: ["alpha", "beta"] } }
    ]
  });
  const row = projectRow(routed, [], {});
  assert.deepEqual(row.routed, { provider: "alpha", reason: "preferred compatible provider" });

  // Manual runs and legacy tasks have no routing decision.
  const manual = projectRow(task({ runs: [{ run: 1, provider: "alpha", outcome: "ready" }] }), [], {});
  assert.equal(manual.routed, null);
  assert.equal(projectRow(task(), [], {}).routed, null);
});

// --- progressive fidelity --------------------------------------------------
//
// How much of a run's shape can be drawn is a DECLARED provider capability,
// never an inference from an empty event log. These pin the difference.

const RICH = { "claude-code": { capabilities: { supportsStructuredEvents: true } } };
const COARSE = { "deepseek-harness": { capabilities: { supportsStructuredEvents: false } } };
const coarseTask = over => task({ execution: { provider: "deepseek-harness", node: "local", workspace: "local" }, ...over });

test("observability comes from the declared capability, not from the events", () => {
  assert.equal(isRichProvider("claude-code", RICH), true);
  assert.equal(isRichProvider("deepseek-harness", COARSE), false);
  // An unregistered or unknown provider is assumed coarse — never claim more
  // than the provider declares.
  assert.equal(isRichProvider("some-future-harness", RICH), false);
  assert.equal(isRichProvider(undefined, RICH), false);
});

test("a coarse provider keeps the INSPECT/ACT/VERIFY frame instead of vanishing", () => {
  const events = log([
    ["run.started", 0, {}],
    ["run.completed", 40, { status: "ready" }]
  ]);
  const row = projectRow(coarseTask({ status: "ready" }), events, { open: true, providers: COARSE });

  assert.equal(row.coarse, true);
  assert.deepEqual(row.groups.map(g => g.label), ["INSPECT", "ACT", "VERIFY"]);
  const cells = row.groups.flatMap(g => g.cells);
  assert.ok(cells.length > 0);
  assert.ok(cells.every(c => c.unobserved === true));
  assert.ok(cells.every(c => c.h === "3px"));
});

test("a coarse provider says 'not reported', never 'awaiting change'", () => {
  const events = log([["run.completed", 40, { status: "ready" }]]);
  const rowBands = projectRow(coarseTask({ status: "ready" }), events, {
    open: true,
    providers: COARSE
  }).bands;
  for (const band of rowBands) {
    assert.equal(band.pendingText, "not reported by this provider", band.label);
    assert.equal(band.unobserved, true, band.label);
  }
});

test("a rich provider with no steps yet still reads as not started", () => {
  const row = projectRow(task({ status: "working" }), log([["run.started", 0, {}]]), {
    open: true,
    providers: RICH
  });
  assert.equal(row.coarse, false);
  // The phase in flight reads as running; the ones after it are genuinely
  // still ahead — not "unreportable".
  assert.equal(row.bands[0].pendingText, "running");
  assert.equal(row.bands[1].pendingText, "awaiting investigation");
  assert.equal(row.bands[2].pendingText, "awaiting change");
  assert.ok(row.bands.every(b => b.unobserved === false));
});

test("a coarse result reports files as unknown rather than as zero", () => {
  const coarse = projectRow(coarseTask({ status: "ready" }), [], { open: true, providers: COARSE });
  assert.equal(coarse.filesReported, false);
  assert.match(coarse.arg, /not reported by this provider/);

  // A rich provider that genuinely changed nothing still says zero.
  const rich = projectRow(task({ status: "ready" }), [], { open: true, providers: RICH });
  assert.equal(rich.filesReported, true);
  assert.equal(rich.arg, "no files changed");
});

test("a coarse frame carries the halt tear exactly once and invents no phase", () => {
  const events = log([
    ["run.started", 0, {}],
    ["needs_user", 30, { reason: "decision", blockedOn: { type: "decision" } }]
  ]);
  const row = projectRow(
    coarseTask({ status: "needs_you", blockedOn: { type: "decision", text: "which one?" } }),
    events,
    { open: true, providers: COARSE }
  );
  const cells = row.groups.flatMap(g => g.cells);
  assert.equal(cells.filter(c => c.isHalt).length, 1);
  assert.deepEqual(row.groups.map(g => g.label), ["INSPECT", "ACT", "VERIFY"]);
  assert.equal(row.phaseLabel, "HALTED AT");
});

test("the track spends its cells on time, so a long step strikes wider", () => {
  // Two steps: the first held the run for 40s, the second for 4s.
  const events = log([
    ["tool.started", 0, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 40, { name: "Edit", input: { file_path: "a.ts" } }],
    ["run.completed", 44, { status: "ready" }]
  ]);
  const row = projectRow(task({ status: "ready" }), events, { open: true, providers: RICH });
  const [inspect, act] = row.groups;
  assert.equal(inspect.label, "INSPECT");
  assert.equal(act.label, "ACT");
  assert.ok(
    inspect.cells.length > act.cells.length * 3,
    `expected the 40s step to strike far wider than the 4s one, got ${inspect.cells.length} vs ${act.cells.length}`
  );
});

test("time parked on a human is not counted as execution on the track", () => {
  const events = log([
    ["tool.started", 0, { name: "Read", input: { file_path: "a.ts" } }],
    ["tool.started", 10, { name: "Edit", input: { file_path: "a.ts" } }],
    ["needs_user", 12, { reason: "permission", blockedOn: { type: "permission" } }]
  ]);
  const blocked = task({ status: "needs_you", blockedOn: { type: "permission", file: "a.ts" } });
  // "now" is an hour after the halt: the HALTED-AT clock grows, the track does not.
  const row = projectRow(blocked, events, {
    open: true,
    providers: RICH,
    now: Date.parse("2026-01-01T11:00:00.000Z")
  });
  const act = row.groups.find(g => g.label === "ACT");
  const inspect = row.groups.find(g => g.label === "INSPECT");
  assert.ok(
    act.cells.length < inspect.cells.length * 2,
    `waiting time leaked into the track: inspect ${inspect.cells.length} vs act ${act.cells.length}`
  );
});
