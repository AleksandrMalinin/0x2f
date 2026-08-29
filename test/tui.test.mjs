// The TUI surface — input decoding, the pure keymap, the view model, and
// the frame.
//
// The point of these tests is the boundary, not the pixels: the terminal
// client must reach Work ONLY through src/core/actions.mjs, and it must
// never grow a second opinion about what a status means. So the vertical
// slice below drives a REAL runtime (with a fake execution node, exactly as
// test/actions.test.mjs does) from a key press all the way to a persisted
// task change, and asserts on the store afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { createRuntime } from "../src/runtime.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { decodeKeys, isPrintable } from "../src/tui/keys.mjs";
import {
  initialState,
  apply,
  visible,
  selected,
  primaryAction,
  secondaryAction
} from "../src/tui/state.mjs";
import { snapshot, STATE_KEY } from "../src/tui/model.mjs";
import { frame, wrap, cut, pad, oneline, shortPath, cellWord } from "../src/tui/view.mjs";
import { renderLine, renderFrame, createPainter, colorSupport } from "../src/tui/screen.mjs";
import { providerSignature, palette } from "../src/tui/theme.mjs";
import { createApp } from "../src/tui/app.mjs";

const ESC = "\u001b";

// --- fixtures -----------------------------------------------------------------

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return 4242;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return 4243;
    },
    async cancelExecution() {},
    calls
  };
}

async function makeRuntime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-tui-"));
  const node = fakeNode();
  return { runtime: createRuntime(base, { node }), node, base };
}

// A task parked on the human, as a provider run would leave it. `live` marks
// an interactive permission request (the run's process still holds it), so
// ALLOW resolves in place without a resumable session.
async function blockTask(runtime, brief, blockedOn, { live = false } = {}) {
  const task = await runtime.actions.createWork({ brief });
  const blocked = applyOutcome(task, { status: "needs_you", blockedOn: { ...blockedOn, live } });
  blocked.execution = { ...task.execution, externalSessionId: live ? undefined : "sess-1" };
  await runtime.store.updateTask(blocked);
  return blocked;
}

const KEY = ch => ({ name: "char", ch });

// --- input decoding -------------------------------------------------------------

test("decodeKeys: a lone ESC chunk is Escape; ESC with more bytes is a modifier", () => {
  assert.deepEqual(decodeKeys(ESC), [{ name: "escape" }]);
  assert.deepEqual(decodeKeys(ESC + "[A"), [{ name: "up" }]);
  assert.deepEqual(decodeKeys(ESC + "[Z"), [{ name: "shift-tab" }]);
  // Alt+Enter — the design's "expand this note into a brief".
  assert.deepEqual(decodeKeys(ESC + "\r"), [{ name: "enter", alt: true }]);
});

test("decodeKeys: Shift+Enter decodes when the terminal can deliver it", () => {
  // Kitty's CSI-u form, xterm's modifyOtherKeys form and the alternate
  // ordering — the three sequences real terminals send for Shift+Enter.
  assert.deepEqual(decodeKeys(ESC + "[13;2u"), [{ name: "enter", shift: true }]);
  assert.deepEqual(decodeKeys(ESC + "[27;2;13~"), [{ name: "enter", shift: true }]);
  assert.deepEqual(decodeKeys(ESC + "[27;2;13u"), [{ name: "enter", shift: true }]);
  // Ctrl+Enter (modifier 5) is not Shift+Enter — it stays unknown rather
  // than being misread as a newline or a submit.
  assert.deepEqual(decodeKeys(ESC + "[27;5;13~"), [{ name: "unknown" }]);
  assert.deepEqual(decodeKeys("\r"), [{ name: "enter" }], "plain Enter is untouched");
});

test("decodeKeys: plain keys, control keys and a paste", () => {
  assert.deepEqual(decodeKeys("j"), [KEY("j")]);
  assert.deepEqual(decodeKeys("\r"), [{ name: "enter" }]);
  assert.deepEqual(decodeKeys("\t"), [{ name: "tab" }]);
  assert.deepEqual(decodeKeys("\u007f"), [{ name: "backspace" }]);
  assert.deepEqual(decodeKeys("\u0003"), [{ name: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("\u000e"), [{ name: "char", ch: "n", ctrl: true }]);
  // A paste is many characters in one chunk — it must type, not be dropped.
  assert.equal(decodeKeys("abc").length, 3);
  assert.ok(decodeKeys("abc").every(isPrintable));
});

test("isPrintable rejects modified keys, so Ctrl+z never lands in a draft", () => {
  assert.equal(isPrintable({ name: "char", ch: "z", ctrl: true }), false);
  assert.equal(isPrintable({ name: "char", ch: "z", alt: true }), false);
  assert.equal(isPrintable({ name: "enter" }), false);
  assert.equal(isPrintable(KEY("z")), true);
});

// --- the keymap ----------------------------------------------------------------

const TASKS = [
  { id: 3, idLabel: "003", title: "correction lifecycle", brief: "", state: "needs", status: "needs_you", provider: "claude-code", halt: { kind: "decision" }, hasChanges: false },
  { id: 4, idLabel: "004", title: "dedupe ingest", brief: "", state: "needs", status: "needs_you", provider: "codex", halt: { kind: "permission" }, hasChanges: true },
  { id: 6, idLabel: "006", title: "flaky retry", brief: "", state: "failed", status: "failed", provider: "gemini", halt: null, hasChanges: false },
  { id: 2, idLabel: "002", title: "rate-limit headers", brief: "", state: "ready", status: "ready", provider: "claude-code", halt: null, hasChanges: true },
  { id: 1, idLabel: "001", title: "strip absolute paths", brief: "", state: "done", status: "done", provider: "claude-code", halt: null, hasChanges: true }
];

const CTX = {
  tasks: TASKS,
  providerOrder: ["claude-code", "deepseek-harness", "codex", "gemini"],
  lookup: id => ({ id, sig: providerSignature(id), name: String(id).toUpperCase() })
};

test("j/k move the selection and clamp at both ends", () => {
  let state = initialState();
  state = apply(state, KEY("k"), CTX).state;
  assert.equal(selected(TASKS, state).id, 3, "already at the top");
  for (let i = 0; i < 10; i++) state = apply(state, KEY("j"), CTX).state;
  assert.equal(selected(TASKS, state).id, 1, "clamped at the last row");
});

test("tab cycles the filter and shift-tab cycles it back", () => {
  let state = initialState();
  state = apply(state, { name: "tab" }, CTX).state;
  assert.equal(visible(TASKS, state).every(t => t.state === "needs"), true);
  state = apply(state, { name: "shift-tab" }, CTX).state;
  assert.equal(visible(TASKS, state).length, TASKS.length, "back to ALL");
});

test("/ searches title, brief and number, and esc clears filter and search together", () => {
  let state = initialState();
  state = apply(state, KEY("/"), CTX).state;
  for (const ch of "dedupe") state = apply(state, KEY(ch), CTX).state;
  assert.deepEqual(visible(TASKS, state).map(t => t.id), [4]);
  state = apply(state, { name: "enter" }, CTX).state;
  state = apply(state, { name: "escape" }, CTX).state;
  assert.equal(visible(TASKS, state).length, TASKS.length);
});

test("Enter and x resolve to the action each Work state is actually waiting for", () => {
  const state = initialState();
  const primary = t => primaryAction(t, state, CTX)?.label;
  const secondary = t => secondaryAction(t)?.label;

  const [decision, permission, failed, ready, done] = TASKS;
  assert.equal(primary(permission), "ALLOW");
  assert.equal(secondary(permission), "REJECT");
  // A decision is answered, never allowed — the two gestures are the
  // product's ANSWER & CONTINUE / SAVE ONLY pair.
  assert.equal(primary(decision), "ANSWER & CONTINUE");
  assert.equal(secondary(decision), "SAVE ONLY");
  assert.equal(primary(ready), "ACCEPT");
  assert.equal(secondary(ready), "SEND BACK");
  // RETRY, not SEND BACK: the intent has not changed, the run environment did.
  assert.equal(primary(failed), "RETRY");
  assert.equal(secondary(failed), "DROP");
  assert.equal(primary(done), "REOPEN ON CLAUDE-CODE");
  assert.equal(secondaryAction(done), null, "a closed task has no alternative gesture");
  assert.equal(
    primaryAction({ state: "working", halt: null }, state, CTX),
    null,
    "a working run wants nothing from you"
  );
});

test("Enter on a permission fires immediately; Enter on a decision asks for text first", () => {
  let state = initialState();
  state = apply(state, KEY("j"), CTX).state; // 004, the permission
  const fired = apply(state, { name: "enter" }, CTX);
  assert.deepEqual(fired.intent, { type: "allow", id: 4 });

  const decision = apply(initialState(), { name: "enter" }, CTX);
  assert.equal(decision.intent, null);
  assert.equal(decision.state.input, "answer");
});

test("an input commits to an intent, and esc throws the draft away", () => {
  let state = apply(initialState(), { name: "enter" }, CTX).state;
  for (const ch of "hash it") state = apply(state, KEY(ch), CTX).state;
  const committed = apply(state, { name: "enter" }, CTX);
  assert.deepEqual(committed.intent, { type: "answer", id: 3, text: "hash it", continue: true });
  assert.equal(committed.state.input, null);

  const cancelled = apply(state, { name: "escape" }, CTX);
  assert.equal(cancelled.intent, null);
  assert.equal(cancelled.state.draft, "");
});

test("x on a decision is SAVE ONLY — the same answer, without spending a run", () => {
  let state = apply(initialState(), KEY("x"), CTX).state;
  assert.equal(state.input, "answer-save");
  for (const ch of "keep it") state = apply(state, KEY(ch), CTX).state;
  const committed = apply(state, { name: "enter" }, CTX);
  assert.deepEqual(committed.intent, { type: "answer", id: 3, text: "keep it", continue: false });
});

test("p retargets only the NEXT run, and moving the selection forgets it", () => {
  let state = apply(initialState(), KEY("j"), CTX).state;
  state = apply(state, KEY("j"), CTX).state; // 006, failed on gemini
  state = apply(state, KEY("p"), CTX).state;
  assert.equal(state.rerunProvider, "claude-code", "wraps past the end of the order");
  assert.equal(primaryAction(TASKS[2], state, CTX).label, "RETRY ON CLAUDE-CODE");
  state = apply(state, KEY("j"), CTX).state;
  assert.equal(state.rerunProvider, null);
});

test("d refuses on a task with nothing to show, and says so instead of opening an empty view", () => {
  const state = apply(initialState(), KEY("d"), CTX);
  assert.equal(state.state.mode, "work");
  assert.match(state.state.flash.text, /nothing changed on #003/);

  const withChanges = apply(apply(initialState(), KEY("j"), CTX).state, KEY("d"), CTX);
  assert.equal(withChanges.state.mode, "diff");
});

test("the composer: Alt+Enter briefs, Shift+Enter or Ctrl+n adds a newline, Enter creates, Ctrl+z reverts", () => {
  let state = apply(initialState({ provider: "codex" }), KEY("n"), CTX).state;
  assert.equal(state.mode, "composer");
  for (const ch of "fix it") state = apply(state, KEY(ch), CTX).state;

  assert.deepEqual(
    apply(state, { name: "enter", alt: true }, CTX).intent,
    { type: "refine", text: "fix it" }
  );
  // The design's newline gesture: Shift+Enter when the terminal can send it.
  const shifted = apply(state, { name: "enter", shift: true }, CTX).state;
  assert.equal(shifted.composer.text, "fix it\n");
  // Ctrl+n remains the universal fallback for terminals that cannot.
  const ctrlN = apply(state, { name: "char", ch: "n", ctrl: true }, CTX).state;
  assert.equal(ctrlN.composer.text, "fix it\n");
  assert.deepEqual(
    apply(state, { name: "enter" }, CTX).intent,
    { type: "create", brief: "fix it", provider: "codex" }
  );
  assert.equal(apply(state, { name: "tab" }, CTX).state.composer.provider, "gemini");

  const briefed = { ...state, composer: { ...state.composer, original: "fix it", text: "A long brief." } };
  assert.equal(apply(briefed, { name: "char", ch: "z", ctrl: true }, CTX).state.composer.text, "fix it");
});

test("q and Ctrl+c both detach", () => {
  assert.deepEqual(apply(initialState(), KEY("q"), CTX).intent, { type: "quit" });
  assert.deepEqual(apply(initialState(), { name: "ctrl-c" }, CTX).intent, { type: "quit" });
});

// --- text helpers ---------------------------------------------------------------

test("oneline protects the grid from provider text without eating the design's spacing", () => {
  assert.equal(oneline("a\nb\tc"), "a b c");
  assert.equal(oneline(ESC + "[31mred" + ESC + "[0m"), "red", "ANSI from a provider never reaches a cell");
  assert.equal(oneline("a   b"), "a   b", "multi-space separators survive");
});

test("cut, pad and shortPath keep a cell to its measure", () => {
  assert.equal(cut("abcdefgh", 4), "abc…");
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("abcdef", 3), "abc");
  assert.equal(shortPath("a/b/c/d/file.ts", 12), "…/d/file.ts");
  assert.equal(shortPath("short.ts", 40), "short.ts");
});

test("cellWord ellipsis-truncates long provider words and keeps the column gap", () => {
  // A tool verb in an 8-column slot must never merge into the next column
  // as "EDIT SUBsrc/app.ts" — it truncates WITH an ellipsis and a gap.
  assert.equal(cellWord("EDIT SUBMIT PATH", 8), "EDIT S… ");
  assert.equal(cellWord("edit submit-capture.ts", 8), "edit s… ");
  // Short words render exactly as pad did — the grid keeps its columns.
  assert.equal(cellWord("CHANGED", 8), "CHANGED ");
  assert.equal(cellWord("plan", 8), "plan    ");
  assert.equal(cellWord("DEEPSEEK HARNESS", 15), "DEEPSEEK HARN… ");
});

test("wrap keeps paragraph breaks — a decision question is prose, not a label", () => {
  assert.deepEqual(wrap("one two three", 8), ["one two", "three"]);
  assert.deepEqual(wrap("a\n\nb", 20), ["a", "", "b"]);
});

// --- the screen -----------------------------------------------------------------

test("renderLine pads and truncates to exactly the column count", () => {
  const cells = [{ t: "abc", c: "#ffffff" }, { t: "defgh", c: "#ff0000" }];
  assert.equal(renderLine(cells, 10, { support: "none" }), "abcdefgh  ");
  assert.equal(renderLine(cells, 4, { support: "none" }), "abcd");
});

test("renderLine emits truecolor when the terminal has it and 256 when it does not", () => {
  const cells = [{ t: "x", c: "#8fb2ee" }];
  assert.match(renderLine(cells, 1, { support: "truecolor" }), /38;2;143;178;238m/);
  assert.match(renderLine(cells, 1, { support: "256" }), /38;5;\d+m/);
  assert.equal(renderLine(cells, 1, { support: "none" }), "x");
});

test("colorSupport follows the documented capability contract", () => {
  // NO_COLOR always wins, even over COLORTERM=truecolor.
  assert.equal(colorSupport({ NO_COLOR: "1", TERM: "xterm-256color", COLORTERM: "truecolor" }), "none");
  // COLORTERM=truecolor / 24bit advertise truecolor.
  assert.equal(colorSupport({ TERM: "xterm", COLORTERM: "truecolor" }), "truecolor");
  assert.equal(colorSupport({ TERM: "xterm", COLORTERM: "24bit" }), "truecolor");
  // A TERM that says truecolor does too.
  assert.equal(colorSupport({ TERM: "xterm-truecolor" }), "truecolor");
  // A dumb or absent TERM means a terminal that cannot be styled: plain text.
  assert.equal(colorSupport({ TERM: "dumb" }), "none");
  assert.equal(colorSupport({ TERM: "" }), "none");
  assert.equal(colorSupport({}), "none");
  // Anything else is treated as the xterm-256 cube — the conservative middle.
  assert.equal(colorSupport({ TERM: "xterm-256color" }), "256");
  assert.equal(colorSupport({ TERM: "xterm" }), "256");
  assert.equal(colorSupport({ TERM: "screen" }), "256");
});

test("256-color fallback quantizes the palette onto the canonical xterm cube", () => {
  // The xterm cube levels are {0, 95, 135, 175, 215, 255}. A regression
  // quantized mid-bright values one step too high, so the accent rendered as
  // lavender (#afd7ff) instead of blue (#87afff) on TERM=xterm-256color.
  const line = cells => renderLine([{ t: "x", c: cells }], 1, { support: "256" });
  assert.equal(line("#8fb2ee"), ESC + "[38;5;111mx" + ESC + "[0m", "accent lands on cube (2,3,5)");
  assert.equal(line("#e79274"), ESC + "[38;5;174mx" + ESC + "[0m", "bad lands on cube (4,2,2)");
  assert.equal(line("#96a1aa"), ESC + "[38;5;109mx" + ESC + "[0m", "dim lands on cube (2,3,3)");
  // Truecolor output is byte-identical regardless of the cube mapping.
  assert.equal(
    renderLine([{ t: "x", c: "#8fb2ee" }], 1, { support: "truecolor" }),
    ESC + "[38;2;143;178;238mx" + ESC + "[0m"
  );
});

// Count printable characters emitted while NO background is in effect —
// the cells where the user's own terminal ground would show through.
function unpainted(line) {
  let bgOn = false;
  let bare = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC) {
      const end = line.indexOf("m", i);
      const codes = line.slice(i + 2, end).split(";");
      if (codes[0] === "0") bgOn = false;
      for (const c of codes) if (c === "48") bgOn = true;
      i = end + 1;
      continue;
    }
    if (!bgOn) bare++;
    i++;
  }
  return bare;
}

test("a cell's own background wins; every other cell sits on the frame's ground", () => {
  const cells = [
    { t: "ab", c: "#e2e8ee", bg: "transparent" },
    { t: "cd", c: "#e2e8ee", bg: "#232c34" }
  ];
  const line = renderLine(cells, 8, { support: "truecolor", bg: "#161c21" });
  assert.ok(line.includes("48;2;22;28;33"), "the transparent cell takes the ground");
  assert.ok(line.includes("48;2;35;44;52"), "the selected cell keeps its own");
  // Including the pad: an unpainted tail would stripe every short line.
  assert.equal(unpainted(line), 0);
});

test("the painter rewrites only the rows that changed, and repaints fully on resize", () => {
  const writes = [];
  const painter = createPainter({ write: s => writes.push(s) }, { support: "none" });
  const lines = n => [{ cells: [{ t: "a", c: "#ffffff" }] }, { cells: [{ t: n, c: "#ffffff" }] }];

  painter.paint(lines("one"), 5, 2);
  writes.length = 0;
  painter.paint(lines("two"), 5, 2);
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].includes(ESC + "[1;1H"), "the unchanged first row is not rewritten");
  assert.ok(writes[0].includes(ESC + "[2;1H"), "the changed row is");

  writes.length = 0;
  painter.paint(lines("two"), 5, 2);
  assert.equal(writes.length, 0, "an identical frame writes nothing at all");

  writes.length = 0;
  painter.paint(lines("two"), 9, 2);
  assert.ok(writes[0].includes(ESC + "[2J"), "a resize clears and repaints");
});

// --- the view model --------------------------------------------------------------

test("projectTask maps Work status onto the design's state keys, never the reverse", () => {
  assert.deepEqual(STATE_KEY, {
    needs_you: "needs",
    failed: "failed",
    ready: "ready",
    working: "working",
    done: "done"
  });
});

test("a decision's question reaches the model in full — nothing truncates it on the way", async () => {
  const { runtime } = await makeRuntime();
  const question =
    "Dedupe on ingestKey, or on the payload hash? ingestKey is stable for 96% of clients; " +
    "the remaining 4% resend with a fresh key after an offline window, and the payload hash " +
    "catches those but costs a read per submit.";
  await blockTask(runtime, "Investigate the correction lifecycle", { type: "decision", text: question });

  const model = await snapshot(runtime);
  const task = model.tasks[0];
  assert.equal(task.state, "needs");
  assert.equal(task.halt.kind, "decision");
  // Heading + body together are the whole question, character for character.
  assert.equal((task.halt.question + " " + task.halt.detail).trim(), question);
});

test("a permission halt carries the operation, the path and whether it resumes in place", async () => {
  const { runtime, base } = await makeRuntime();
  await blockTask(
    runtime,
    "Dedupe the capture ingest path",
    {
      type: "permission",
      tool: "Edit",
      file: path.join(base, "services/capture/dedupe.ts"),
      plannedChange: "derive the ingest key in one place"
    },
    { live: true }
  );

  const task = (await snapshot(runtime)).tasks[0];
  assert.equal(task.halt.kind, "permission");
  assert.equal(task.halt.op, "EDIT");
  // The path reads as a project path — never as this machine's filesystem.
  assert.equal(task.halt.path, "services/capture/dedupe.ts");
  assert.equal(task.halt.plan, "derive the ingest key in one place");
  assert.match(task.halt.note, /same run continues/);
  assert.equal(task.hasChanges, true, "a planned write is something to look at");
});

test("the human record is read from the event log, so NOTE, ANSWER and CORRECTION stay distinguishable", async () => {
  const { runtime } = await makeRuntime();
  const task = await blockTask(runtime, "Rate-limit headers", { type: "decision", text: "Seconds or ms?" });
  await runtime.actions.answerWork(task.id, { answer: "whole seconds" });
  await runtime.actions.noteWork(task.id, { note: "set them before the body flushes" });
  await runtime.actions.correctWork(task.id, { correction: "use a 503, not a 429" });

  const projected = (await snapshot(runtime)).tasks[0];
  assert.deepEqual(projected.notes.map(n => n.kind), ["answer", "note", "correction"]);
  assert.deepEqual(projected.notes.map(n => n.text), [
    "whole seconds",
    "set them before the body flushes",
    "use a 503, not a 429"
  ]);
});

test("provider identity is derived, so a configured provider is not a blank column", () => {
  assert.equal(providerSignature("claude-code"), "CC");
  assert.equal(providerSignature("deepseek-harness"), "DS");
  assert.equal(providerSignature("codex"), "CX");
  assert.equal(providerSignature("gemini"), "GM");
  assert.equal(providerSignature("acme-agent", "Acme Agent"), "AA");
  assert.equal(providerSignature("zed", "Zed"), "ZE");
  assert.equal(providerSignature(null), "??");
});

// --- the frame -------------------------------------------------------------------

async function frameFor(runtime, state, size = { cols: 132, rows: 38 }) {
  const model = await snapshot(runtime);
  const built = frame(model, state, { ...size, palette: palette("dark") });
  return { built, model, text: renderFrame(built.lines, size.cols, size.rows, { support: "none" }) };
}

test("every rendered row is exactly the terminal width, at every size", async () => {
  const { runtime } = await makeRuntime();
  await blockTask(runtime, "Dedupe the capture ingest path", {
    type: "permission",
    tool: "Edit",
    file: "services/capture/dedupe.ts",
    plannedChange: "derive the ingest key in one place"
  });

  for (const size of [{ cols: 80, rows: 24 }, { cols: 132, rows: 38 }, { cols: 200, rows: 50 }]) {
    const { text } = await frameFor(runtime, initialState(), size);
    assert.equal(text.length, size.rows, `${size.cols}x${size.rows}: row count`);
    for (const row of text) {
      assert.equal(row.length, size.cols, `${size.cols}x${size.rows}: "${row}"`);
      assert.ok(!row.includes("\n"), "a row never contains a newline");
    }
  }
});

test("both themes paint their own ground, in every mode and at every size", async () => {
  // A full-screen surface that names its own palette must paint the ground
  // that palette was contrast-tuned against. Inheriting the terminal's
  // background instead would make --light dark ink on a dark ground for
  // anyone whose terminal is dark.
  const { runtime } = await makeRuntime();
  await blockTask(runtime, "Dedupe the capture ingest path", {
    type: "permission",
    tool: "Edit",
    file: "services/capture/dedupe.ts",
    plannedChange: "derive the ingest key in one place"
  });
  const model = await snapshot(runtime);

  for (const theme of ["dark", "light"]) {
    const p = palette(theme);
    for (const size of [{ cols: 80, rows: 24 }, { cols: 132, rows: 38 }]) {
      for (const mode of ["work", "help", "composer", "diff"]) {
        const built = frame(model, { ...initialState(), mode }, { ...size, palette: p });
        assert.equal(built.bg, p.bg, `${theme}: the frame reports its ground`);
        const rows = renderFrame(built.lines, size.cols, size.rows, {
          support: "truecolor",
          bg: built.bg
        });
        const bare = rows.reduce((total, row) => total + unpainted(row), 0);
        assert.equal(bare, 0, `${theme} ${size.cols}x${size.rows} ${mode}: unpainted cells`);
      }
    }
  }
});

test("the two palettes are the design's, and they never share an ink", () => {
  const dark = palette("dark");
  const light = palette("light");
  assert.equal(dark.bg, "#161c21");
  assert.equal(light.bg, "#f2f4f6");
  // Every role is defined in both, and no role was left pointing at the
  // other theme's value.
  for (const role of ["bg", "fg", "dim", "rule", "accent", "ok", "bad", "sel", "ghost"]) {
    assert.match(dark[role], /^#[0-9a-f]{6}$/, `dark.${role}`);
    assert.match(light[role], /^#[0-9a-f]{6}$/, `light.${role}`);
    assert.notEqual(dark[role], light[role], `${role} is theme-specific`);
  }
  assert.equal(palette("nonsense").bg, dark.bg, "an unknown theme falls back to dark");
});

test("the frame shows the workspace, the counts, the halt and the action it is waiting for", async () => {
  const { runtime } = await makeRuntime();
  await blockTask(runtime, "Dedupe the capture ingest path", {
    type: "permission",
    tool: "Edit",
    file: "services/capture/dedupe.ts",
    plannedChange: "derive the ingest key in one place"
  });

  const { text, model } = await frameFor(runtime, initialState());
  const screen = text.join("\n");
  assert.ok(screen.includes("0x2F"), "the chrome names the product");
  assert.ok(screen.includes(model.workspace.label), "and the checkout it is serving");
  assert.ok(screen.includes("NEEDS YOU"), "the group that wants you is at the top");
  assert.ok(screen.includes("PERMISSION"), "the state word says which kind of block");
  assert.ok(screen.includes("services/capture/dedupe.ts"));
  assert.ok(screen.includes("derive the ingest key in one place"));
  // The one action, in the pinned row and in the hint line.
  assert.ok(screen.includes("ALLOW"));
  assert.ok(screen.includes("REJECT"));
});

test("the last three rows above the bottom gutter are a fixed footer that the panes never scroll into", async () => {
  const { runtime } = await makeRuntime();
  await blockTask(runtime, "A task that needs a decision", { type: "decision", text: "Which way?" });
  const { text } = await frameFor(runtime, initialState());
  // The very last row is blank — the frame's own bottom gutter.
  assert.match(text[text.length - 1], /^\s*$/, "the bottom gutter");
  assert.match(text[text.length - 4], /^\s+─+\s*$/, "a rule");
  assert.match(text[text.length - 3], /n to submit work/, "the message line");
  assert.match(text[text.length - 2], /q detach/, "the hint line");
});

test("help, the composer and the changes view each render their own full frame", async () => {
  const { runtime } = await makeRuntime();
  await blockTask(runtime, "Dedupe the capture ingest path", {
    type: "permission",
    tool: "Edit",
    file: "services/capture/dedupe.ts",
    plannedChange: "derive the ingest key in one place"
  });

  const help = (await frameFor(runtime, { ...initialState(), mode: "help" })).text.join("\n");
  assert.ok(help.includes("KEYS") && help.includes("a TASK is permanent"));

  const composer = (await frameFor(runtime, {
    ...initialState(),
    mode: "composer",
    composer: { text: "", original: null, provider: "claude-code" }
  })).text.join("\n");
  assert.ok(composer.includes("NEW TASK"));
  assert.ok(composer.includes("0x2F names the task from what you write."));

  const changes = (await frameFor(runtime, { ...initialState(), mode: "diff" })).text.join("\n");
  assert.ok(changes.includes("PLANNED · NOT YET WRITTEN"), "a halted write has not happened yet");
  assert.ok(changes.includes("services/capture/dedupe.ts"));
});

// A real git repository in the workspace: one committed file the run then
// modifies. The diff view must draw the ACTUAL hunks, not a file list.
function git(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd }, (error, stdout) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout ?? "") })
    );
  });
}

test("the changes view draws the REAL diff from the working tree, loaded on d", async () => {
  const { runtime, base } = await makeRuntime();
  await git(["init", "-q"], base);
  await git(["config", "user.email", "test@0x2f.dev"], base);
  await git(["config", "user.name", "0x2F test"], base);
  await fs.writeFile(path.join(base, "dedupe.ts"), "const key = ingestKey;\n");
  await git(["add", "."], base);
  await git(["commit", "-qm", "init"], base);
  await fs.writeFile(path.join(base, "dedupe.ts"), "const key = payloadHash;\n");

  const task = await runtime.actions.createWork({ brief: "Dedupe the capture ingest path" });
  // The run reported this file changed — exactly what a worker would append.
  await runtime.store.appendEvent(task.slug, {
    type: "file.changed",
    path: path.join(base, "dedupe.ts"),
    taskId: task.id,
    at: new Date().toISOString()
  });
  await runtime.store.updateTask(applyOutcome(task, { status: "ready", result: "done" }));

  const app = createApp(runtime);
  await app.refresh();
  assert.equal(app.selected().hasChanges, true);

  await app.key({ name: "char", ch: "d" });
  assert.equal(app.state.mode, "diff");
  assert.ok(Array.isArray(app.state.diff), "the app loaded the change set");
  assert.equal(app.state.diff[0].kind, "hunks");
  assert.match(app.state.diff[0].hunks, /^-const key = ingestKey;$/m, "the removed line");
  assert.match(app.state.diff[0].hunks, /^\+const key = payloadHash;$/m, "the added line");

  const text = renderFrame(app.frame({ cols: 132, rows: 38 }).lines, 132, 38, { support: "none" }).join("\n");
  assert.ok(text.includes("dedupe.ts"));
  assert.ok(text.includes("const key = payloadHash"), "the hunk content is on screen");
  assert.ok(text.includes("the real diff of the working tree vs HEAD"));
});

test("a working rerun's rule draws a measured percentage against its prior runs", async () => {
  const { runtime } = await makeRuntime();
  const task = await runtime.actions.createWork({ brief: "Rate-limit headers" });
  // Run 1 completed in 100s; run 2 is the current working run, 50s in.
  const started = new Date().toISOString();
  const prior = new Date(Date.now() - 100_000).toISOString();
  await runtime.store.updateTask({
    ...task,
    status: "working",
    runs: [
      { run: 1, provider: "claude-code", startedAt: prior, outcome: "ready", durationMs: 100_000 },
      { run: 2, provider: "claude-code", startedAt: started, outcome: "working" }
    ]
  });

  const model = await snapshot(runtime, { now: Date.now() + 50_000 });
  const projected = model.tasks[0];
  assert.equal(projected.state, "working");
  assert.deepEqual(projected.progress, { percent: 50, basis: "previous run" });

  // The detail pane names the basis so the ratio is never mistaken for a
  // provider guarantee.
  const built = frame(model, initialState(), { cols: 132, rows: 38, palette: palette("dark") });
  const text = renderFrame(built.lines, 132, 38, { support: "none" }).join("\n");
  assert.ok(text.includes("50% of previous run"));
});

test("an empty workspace says so instead of rendering a broken grid", async () => {
  const { runtime } = await makeRuntime();
  const { text } = await frameFor(runtime, initialState());
  assert.equal(text.length, 38);
  assert.ok(text.join("\n").includes("no task selected"));
});

// --- the vertical slice ----------------------------------------------------------

test("overview -> detail -> a NEEDS YOU permission -> back, against the real runtime", async () => {
  const { runtime, node, base } = await makeRuntime();
  await runtime.actions.createWork({ brief: "Upgrade drizzle 0.31 to 0.33" });
  const blocked = await blockTask(
    runtime,
    "Dedupe the capture ingest path",
    { type: "permission", tool: "Edit", file: path.join(base, "services/capture/dedupe.ts") },
    { live: true }
  );

  const app = createApp(runtime);
  await app.refresh();

  // The ledger leads with what wants you.
  assert.equal(app.model.tasks[0].id, blocked.id);
  assert.equal(app.model.counts.needs, 1);
  assert.equal(app.selected().id, blocked.id, "and the cursor starts there");

  // The detail pane is showing that task's halt.
  const before = renderFrame(app.frame({ cols: 132, rows: 38 }).lines, 132, 38, { support: "none" }).join("\n");
  assert.ok(before.includes("NEEDS YOU · PERMISSION"));

  // Enter — the one action. It goes through the shared action, not a local rule.
  const intent = await app.key({ name: "enter" });
  assert.deepEqual(intent, { type: "allow", id: blocked.id });

  // The permission was resolved where Work says it is resolved: an
  // interactive request is answered through the decision file, in place,
  // without a new worker.
  const decision = JSON.parse(
    await fs.readFile(path.join(runtime.store.taskDir(blocked.slug), "permission.json"), "utf8")
  );
  assert.equal(decision.grant, "allow");
  assert.ok(
    !node.calls.some(([kind]) => kind === "resume"),
    "a live request is answered in place — no worker is respawned"
  );

  // And the surface says what happened, in the message line.
  assert.match(app.state.flash.text, /allowed/);

  // Back to the overview: j moves off the row, and the frame still draws.
  await app.key({ name: "char", ch: "j" });
  const after = renderFrame(app.frame({ cols: 132, rows: 38 }).lines, 132, 38, { support: "none" });
  assert.equal(after.length, 38);
  assert.ok(after.join("\n").includes("drizzle"));
});

test("ANSWER & CONTINUE persists the answer and starts the next run; SAVE ONLY does not", async () => {
  const { runtime, node } = await makeRuntime();
  const task = await blockTask(runtime, "Investigate the correction lifecycle", {
    type: "decision",
    text: "Dedupe on ingestKey, or on the payload hash?"
  });

  const app = createApp(runtime);
  await app.refresh();

  // SAVE ONLY first: x, type, commit.
  await app.key({ name: "char", ch: "x" });
  for (const ch of "hash it") await app.key({ name: "char", ch });
  await app.key({ name: "enter" });

  let stored = await runtime.actions.getWork(task.id);
  assert.equal(stored.status, "needs_you", "SAVE ONLY records the answer and leaves the task on you");
  assert.deepEqual(stored.context.notes.map(n => n.text), ["hash it"]);
  assert.equal(node.calls.length, 1, "no run was spent");
  assert.match(app.state.flash.text, /stays NEEDS YOU/);

  // ANSWER & CONTINUE: the same answer path, plus the next run.
  await app.key({ name: "enter" });
  for (const ch of "and log it") await app.key({ name: "char", ch });
  await app.key({ name: "enter" });

  stored = await runtime.actions.getWork(task.id);
  assert.equal(stored.status, "working");
  assert.equal(stored.runs.length, 2, "a decision continues as a NEW run");
  assert.deepEqual(stored.context.notes.map(n => n.text), ["hash it", "and log it"]);
  assert.deepEqual(node.calls.at(-1), ["start", task.slug]);
});

test("SEND BACK records the correction on the task, then rebuilds the next run from it", async () => {
  const { runtime, node } = await makeRuntime();
  const task = await runtime.actions.createWork({ brief: "Rate-limit headers on /v1/capture" });
  await runtime.store.updateTask(applyOutcome(task, { status: "ready", result: "done" }));

  const app = createApp(runtime);
  await app.refresh();
  assert.equal(app.selected().state, "ready");

  await app.key({ name: "char", ch: "x" }); // SEND BACK
  for (const ch of "retry-after in whole seconds") await app.key({ name: "char", ch });
  await app.key({ name: "enter" });

  const stored = await runtime.actions.getWork(task.id);
  assert.equal(stored.status, "working");
  assert.equal(stored.runs.length, 2);
  assert.deepEqual(stored.context.notes.map(n => n.text), ["retry-after in whole seconds"]);
  // A correction is its own normalized event — not a plain note.
  const events = await runtime.store.readEvents(stored.slug);
  assert.ok(
    events.some(e => e.type === "task.corrected" && e.correction === "retry-after in whole seconds"),
    "the send-back records a task.corrected event"
  );
  // The next run's prompt is rebuilt from Task state — the correction is in it.
  const prompt = await runtime.store.readRunPrompt(stored, 2);
  assert.ok(prompt.includes("retry-after in whole seconds"));
  assert.deepEqual(node.calls.at(-1), ["start", task.slug]);
});

test("RETRY reruns a failed task on the same provider; the intent has not changed", async () => {
  const { runtime } = await makeRuntime();
  const task = await runtime.actions.createWork({ brief: "Flaky test: offline queue retry" });
  await runtime.store.updateTask(applyOutcome(task, { status: "failed", error: "exit 1" }));

  const app = createApp(runtime);
  await app.refresh();
  assert.equal(app.selected().state, "failed");
  await app.key({ name: "enter" }); // RETRY

  const stored = await runtime.actions.getWork(task.id);
  assert.equal(stored.runs.length, 2);
  assert.equal(
    stored.runs.at(-1).provider,
    stored.runs[0].provider,
    "a retry is a retry — the intent did not change, so neither does the provider"
  );
});

test("ACCEPT closes the task through the shared action, and the ledger re-groups it", async () => {
  const { runtime } = await makeRuntime();
  const task = await runtime.actions.createWork({ brief: "Strip absolute paths from the relay payload" });
  await runtime.store.updateTask(applyOutcome(task, { status: "ready", result: "done" }));

  const app = createApp(runtime);
  await app.refresh();
  await app.key({ name: "enter" }); // ACCEPT

  assert.equal((await runtime.actions.getWork(task.id)).status, "done");
  assert.equal(app.model.counts.done, 1);
  assert.equal(app.model.counts.ready, 0);
});

test("a refusal from the shared action is surfaced verbatim, never swallowed or worked around", async () => {
  const { runtime } = await makeRuntime();
  // A working task cannot be rerun — runs of one task are sequential. The
  // TUI must not have its own opinion about that; it must show Work's.
  const task = await runtime.actions.createWork({ brief: "Upgrade drizzle" });
  const app = createApp(runtime);
  await app.refresh();

  await app.run({ type: "rerun", id: task.id });
  assert.equal(app.state.flash.tone, "warn");
  assert.match(app.state.flash.text, /is working/);
  assert.equal((await runtime.actions.getWork(task.id)).runs.length, 1, "nothing happened");
});

test("the TUI never writes Work state itself — the store is only reached through actions", async () => {
  // A structural assertion: src/tui may import the runtime, the shared
  // actions and the ledger projection, but nothing that mutates state
  // directly. If this fails, a business rule has leaked into the surface.
  const dir = new URL("../src/tui/", import.meta.url);
  const files = await fs.readdir(dir);
  for (const file of files) {
    const source = await fs.readFile(new URL(file, dir), "utf8");
    for (const forbidden of ["store.updateTask", "store.createTask", "store.appendEvent", "applyOutcome"]) {
      assert.ok(
        !source.includes(forbidden),
        `src/tui/${file} must not call ${forbidden} — that belongs to core/actions.mjs`
      );
    }
  }
});
