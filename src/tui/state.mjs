// TUI state and the keymap — pure.
//
// Everything in here is presentation state: which row is selected, which
// filter is on, what the user has half-typed. No Work state lives here, and
// no business rule: `apply` returns the next TUI state plus an optional
// INTENT — a description of the shared action the controller should invoke.
// That split is what keeps the keymap testable without a runtime and keeps
// src/core/actions.mjs the only place that can change a task.
//
// The keymap follows the finalized design, not terminal convention: ↵ is
// "the one action this task is waiting for" rather than "open", x is the
// alternative, and the letters (c/d/p/t/n) are the design's.

import { FILTER_KEYS } from "./model.mjs";
import { isPrintable } from "./keys.mjs";

export function initialState(opts = {}) {
  return {
    sel: 0,
    filter: 0,
    search: "",
    searching: false,
    mode: "work",
    input: null,
    draft: "",
    rscroll: 0,
    dscroll: 0,
    expand: false,
    rerunProvider: null,
    flash: null,
    // The loaded change set for the diff view (actions.getTaskDiff output) —
    // null until the view is opened, so entering `d` never blocks the frame
    // on a git walk.
    diff: null,
    composer: { text: "", original: null, provider: opts.provider ?? null },
    busy: false
  };
}

export function visible(tasks, state) {
  const key = FILTER_KEYS[state.filter];
  let out = key === "all" ? tasks : tasks.filter(t => t.state === key);
  const q = state.search.trim().toLowerCase();
  if (q) {
    out = out.filter(t =>
      (t.idLabel + " " + t.title + " " + t.brief).toLowerCase().includes(q)
    );
  }
  return out;
}

export function selected(tasks, state) {
  const list = visible(tasks, state);
  if (!list.length) return null;
  return list[Math.min(state.sel, list.length - 1)];
}

// The provider the NEXT run of this task would use. A failed run defaults to
// the same provider (a RETRY is a retry — the intent has not changed); `p`
// points it somewhere else.
export function rerunTarget(task, state) {
  return state.rerunProvider ?? task?.provider ?? null;
}

function nextProvider(order, current) {
  if (!order.length) return current;
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

// --- the two actions a row offers -------------------------------------------
//
// One primary (↵) and one alternative (x), derived from Work state alone.
// `input` means the gesture needs text first; `intent` means it fires now.

export function primaryAction(task, state, ctx = {}) {
  if (!task) return null;
  const target = rerunTarget(task, state);
  const name = ctx.lookup ? ctx.lookup(target).name : String(target ?? "").toUpperCase();
  if (task.state === "needs") {
    return task.halt?.kind === "permission"
      ? { label: "ALLOW", intent: { type: "allow", id: task.id } }
      : { label: "ANSWER & CONTINUE", input: "answer" };
  }
  if (task.state === "ready") return { label: "ACCEPT", intent: { type: "accept", id: task.id } };
  if (task.state === "failed") {
    return {
      label: target === task.provider ? "RETRY" : "RETRY ON " + name,
      intent: { type: "rerun", id: task.id, provider: target }
    };
  }
  if (task.state === "done") {
    return {
      label: "REOPEN ON " + name,
      intent: { type: "rerun", id: task.id, provider: target }
    };
  }
  return null;
}

export function secondaryAction(task) {
  if (!task) return null;
  if (task.state === "needs") {
    return task.halt?.kind === "permission"
      ? { label: "REJECT", intent: { type: "reject", id: task.id } }
      : { label: "SAVE ONLY", input: "answer-save" };
  }
  if (task.state === "ready") return { label: "SEND BACK", input: "sendback" };
  if (task.state === "failed") return { label: "DROP", intent: { type: "drop", id: task.id } };
  return null;
}

export const INPUT_LABELS = {
  answer: "ANSWER & CONTINUE",
  "answer-save": "SAVE ONLY",
  note: "NOTE ON TASK",
  sendback: "SEND BACK"
};

export const INPUT_NOTES = {
  answer: "recorded on the task · the next run continues with it",
  "answer-save": "recorded on the task · the task stays NEEDS YOU",
  note: "recorded on the task · every later run carries it",
  sendback: "recorded on the task · the next run is rebuilt with it"
};

function commitInput(state, task) {
  const text = state.draft.trim();
  const kind = state.input;
  const cleared = { ...state, input: null, draft: "" };
  if (!task || !text) return { state: cleared, intent: null };
  if (kind === "answer") {
    return { state: cleared, intent: { type: "answer", id: task.id, text, continue: true } };
  }
  if (kind === "answer-save") {
    return { state: cleared, intent: { type: "answer", id: task.id, text, continue: false } };
  }
  if (kind === "note") return { state: cleared, intent: { type: "note", id: task.id, text } };
  if (kind === "sendback") {
    return { state: cleared, intent: { type: "sendback", id: task.id, text } };
  }
  return { state: cleared, intent: null };
}

// --- the composer -------------------------------------------------------------
//
// ⇧↵ inserts a newline when the terminal can deliver it (Kitty's CSI-u or
// xterm's modifyOtherKeys — see keys.mjs); a terminal that cannot tell ⇧↵
// from ↵ sends no distinct bytes, so ⌃n remains the universal fallback.
// ⌥↵ (brief) survives as-is: terminals deliver Alt as an ESC prefix in the
// same read.
function composerKey(state, key, ctx) {
  const c = state.composer;
  const set = patch => ({ ...state, composer: { ...c, ...patch } });

  if (key.name === "escape") return { state: { ...state, mode: "work" }, intent: null };
  if (key.name === "enter" && key.alt) {
    if (!c.text.trim() || c.original !== null) return { state, intent: null };
    return { state, intent: { type: "refine", text: c.text } };
  }
  if (key.name === "enter" && key.shift) {
    return { state: set({ text: c.text + "\n" }), intent: null };
  }
  if (key.name === "char" && key.ctrl && key.ch === "n") {
    return { state: set({ text: c.text + "\n" }), intent: null };
  }
  if (key.name === "char" && key.ctrl && key.ch === "z") {
    return c.original !== null
      ? { state: set({ text: c.original, original: null }), intent: null }
      : { state, intent: null };
  }
  if (key.name === "enter") {
    if (!c.text.trim()) return { state, intent: null };
    return { state, intent: { type: "create", brief: c.text.trim(), provider: c.provider } };
  }
  if (key.name === "tab") {
    return { state: set({ provider: nextProvider(ctx.providerOrder ?? [], c.provider) }), intent: null };
  }
  if (key.name === "backspace") return { state: set({ text: c.text.slice(0, -1) }), intent: null };
  if (isPrintable(key)) return { state: set({ text: c.text + key.ch }), intent: null };
  return { state, intent: null };
}

// One key press -> { state, intent }. `ctx` is read-only context the keymap
// needs to resolve a gesture: the visible task list, the provider order and
// the provider lookup for labels.
export function apply(state, key, ctx = {}) {
  const tasks = ctx.tasks ?? [];
  const list = visible(tasks, state);
  const task = selected(tasks, state);
  const none = { state, intent: null };

  if (key.name === "ctrl-c") return { state: { ...state, mode: "quit" }, intent: { type: "quit" } };

  if (state.mode === "composer") return composerKey(state, key, ctx);

  if (state.mode === "quit") return { state, intent: { type: "quit" } };

  if (state.mode === "diff") {
    if (key.name === "char" && key.ch === "j") return { state: { ...state, dscroll: state.dscroll + 1 }, intent: null };
    if (key.name === "down") return { state: { ...state, dscroll: state.dscroll + 1 }, intent: null };
    if (key.name === "char" && key.ch === "k") return { state: { ...state, dscroll: Math.max(0, state.dscroll - 1) }, intent: null };
    if (key.name === "up") return { state: { ...state, dscroll: Math.max(0, state.dscroll - 1) }, intent: null };
    return { state: { ...state, mode: "work", dscroll: 0 }, intent: null };
  }

  if (state.mode !== "work") return { state: { ...state, mode: "work" }, intent: null };

  if (state.searching) {
    if (key.name === "enter") return { state: { ...state, searching: false, sel: 0 }, intent: null };
    if (key.name === "escape") return { state: { ...state, searching: false, search: "", sel: 0 }, intent: null };
    if (key.name === "backspace") return { state: { ...state, search: state.search.slice(0, -1), sel: 0 }, intent: null };
    if (isPrintable(key)) return { state: { ...state, search: state.search + key.ch, sel: 0 }, intent: null };
    return none;
  }

  if (state.input) {
    if (key.name === "enter") return commitInput(state, task);
    if (key.name === "escape") return { state: { ...state, input: null, draft: "" }, intent: null };
    if (key.name === "backspace") return { state: { ...state, draft: state.draft.slice(0, -1) }, intent: null };
    if (isPrintable(key)) return { state: { ...state, draft: state.draft + key.ch }, intent: null };
    return none;
  }

  const move = d => ({
    state: {
      ...state,
      sel: Math.max(0, Math.min(list.length - 1, state.sel + d)),
      rscroll: 0,
      rerunProvider: null
    },
    intent: null
  });

  if (key.name === "down") return move(1);
  if (key.name === "up") return move(-1);
  if (key.name === "tab") {
    return { state: { ...state, filter: (state.filter + 1) % FILTER_KEYS.length, sel: 0 }, intent: null };
  }
  if (key.name === "shift-tab") {
    return {
      state: { ...state, filter: (state.filter + FILTER_KEYS.length - 1) % FILTER_KEYS.length, sel: 0 },
      intent: null
    };
  }
  if (key.name === "escape") {
    return {
      state: { ...state, expand: false, filter: 0, search: "", rscroll: 0, rerunProvider: null },
      intent: null
    };
  }
  if (key.name === "enter") {
    const primary = primaryAction(task, state, ctx);
    if (!primary) return { state: { ...state, expand: !state.expand }, intent: null };
    if (primary.input) return { state: { ...state, input: primary.input, draft: "" }, intent: null };
    return { state, intent: primary.intent };
  }
  if (key.name !== "char" || key.ctrl || key.alt) return none;

  switch (key.ch) {
    case "j": return move(1);
    case "k": return move(-1);
    case "J": return { state: { ...state, rscroll: state.rscroll + 4 }, intent: null };
    case "K": return { state: { ...state, rscroll: Math.max(0, state.rscroll - 4) }, intent: null };
    case "g": return { state: { ...state, sel: 0, rscroll: 0 }, intent: null };
    case "G": return { state: { ...state, sel: Math.max(0, list.length - 1), rscroll: 0 }, intent: null };
    case "/": return { state: { ...state, searching: true, search: "" }, intent: null };
    case "d":
      if (task?.hasChanges) return { state: { ...state, mode: "diff", dscroll: 0 }, intent: null };
      return {
        state: {
          ...state,
          flash: { text: "nothing changed on " + (task ? "#" + task.idLabel : "this task") + " yet", tone: "warn" }
        },
        intent: null
      };
    case "p": {
      if (!task) return none;
      const next = nextProvider(ctx.providerOrder ?? [], rerunTarget(task, state));
      const name = ctx.lookup ? ctx.lookup(next).name : String(next ?? "").toUpperCase();
      return {
        state: { ...state, rerunProvider: next, flash: { text: "the next run would go to " + name, tone: "ok" } },
        intent: null
      };
    }
    case "c":
      return task ? { state: { ...state, input: "note", draft: "" }, intent: null } : none;
    case "x": {
      const secondary = secondaryAction(task);
      if (!secondary) return none;
      if (secondary.input) return { state: { ...state, input: secondary.input, draft: "" }, intent: null };
      return { state, intent: secondary.intent };
    }
    case "n":
      return { state: { ...state, mode: "composer" }, intent: null };
    case "t":
      return { state: { ...state, expand: !state.expand, rscroll: 0 }, intent: null };
    case "?":
      return { state: { ...state, mode: "help" }, intent: null };
    case "q":
      return { state: { ...state, mode: "quit" }, intent: { type: "quit" } };
    default:
      return none;
  }
}
