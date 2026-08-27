// The frame builders — the finalized TUI design, drawn from the view model.
//
// Every function here is PURE: model + TUI state in, lines of cells out. No
// I/O, no runtime, no clock of its own (the time is passed in). That is what
// makes the whole visual layer assertable in a test, and it is why the
// terminal's layout logic can live beside the Web's without either surface
// growing a second state model.
//
// Layout, keymap hints and visual hierarchy follow the handoff rather than
// terminal convention: the left pane is a grouped ledger with the states
// that want you at the top, the right pane is the selected task in full, and
// the last three rows are a fixed footer (a rule, a message line, a hint
// line) that never scrolls.

import {
  GROUPS,
  FILTERS
} from "./model.mjs";
import {
  visible,
  selected,
  primaryAction,
  secondaryAction,
  INPUT_LABELS,
  INPUT_NOTES
} from "./state.mjs";
import { fmtDuration } from "../web/ledger.mjs";

// --- text helpers -------------------------------------------------------------

// A cell occupies exactly one row, so any text placed in one is flattened
// first. Provider-authored strings (an error, a tool argument, a decision
// question) routinely contain newlines, and a raw "\n" inside a cell would
// tear the grid apart — every column after it on that row shifts. `wrap` is
// the opposite path: it is the only helper that HONORS newlines, because it
// is producing rows rather than filling one.
// Newlines, tabs and control bytes are removed; runs of SPACES are not —
// the hint line and the action row use multi-space as a separator, and
// collapsing those would silently reflow the design's own spacing. ANSI
// sequences are stripped because provider output is arbitrary text: an
// escape code that reached a cell would repaint the rest of the row.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function oneline(value) {
  return String(value ?? "")
    .replace(ANSI_RE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_RE, "")
    .trim();
}

export function pad(value, n) {
  const s = oneline(value);
  const width = Math.max(0, n | 0);
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

export function padl(value, n) {
  const s = oneline(value);
  const width = Math.max(0, n | 0);
  return s.length >= width ? s.slice(0, width) : " ".repeat(width - s.length) + s;
}

export function cut(value, n) {
  const s = oneline(value);
  const width = Math.max(1, n | 0);
  return s.length <= width ? s : s.slice(0, Math.max(1, width - 1)) + "…";
}

// A path shortened from the FRONT: the filename is what identifies it, the
// leading directories are context you drop first.
export function shortPath(value, n) {
  const width = Math.max(6, n | 0);
  const p = oneline(value);
  if (p.length <= width) return p;
  const parts = p.split("/");
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + out;
    if (next.length + 2 > width) break;
    out = next;
  }
  return "…/" + out;
}

export function wrap(value, n) {
  const width = Math.max(8, n | 0);
  const out = [];
  for (const paragraph of String(value ?? "").split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if ((line + " " + word).length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line.length) out.push(line);
  }
  return out;
}

const len = cells => cells.reduce((total, cell) => total + String(cell.t ?? "").length, 0);

// --- the run rule --------------------------------------------------------------
//
// The design's progress rule, measured honestly. Its mock runtime knew each
// run's total duration and could draw a percentage; a real run has no known
// end, so this draws what IS known: one mark per reported signal, then the
// live head, then unreported ground. A finished run fills — it is finished,
// and that is a fact. Nothing here is time-proportional, exactly as
// src/web/ledger.mjs refuses to synthesize geometry.
export function ruleCells(task, width, p) {
  const w = Math.max(4, width | 0);
  const finished = task.state === "ready" || task.state === "done";
  const failed = task.state === "failed";
  const halted = task.state === "needs";
  const marks = [];

  if (finished || failed) {
    marks.push({ ch: "━".repeat(w), c: failed ? p.bad : p.ok, b: 400 });
  } else {
    const reported = Math.min(task.steps.length, w - 1);
    if (reported > 0) marks.push({ ch: "━".repeat(reported), c: p.fg, b: 400 });
    marks.push(
      halted ? { ch: "!", c: p.accent, b: 600 } : { ch: "◆", c: p.fg, b: 600 }
    );
    const rest = w - reported - 1;
    if (rest > 0) marks.push({ ch: "┄".repeat(rest), c: p.ghost, b: 400 });
  }
  return marks.map(m => ({ t: m.ch, c: m.c, b: m.b, bg: "transparent" }));
}

export function glyph(task, p) {
  if (task.state === "needs") return { t: "!", c: p.accent, b: 600 };
  if (task.state === "failed") return { t: "✕", c: p.bad, b: 600 };
  if (task.state === "ready") return { t: "✓", c: p.ok, b: 500 };
  if (task.state === "working") return { t: "▶", c: p.fg, b: 400 };
  return { t: "·", c: p.ghost, b: 400 };
}

export function stateWord(task) {
  if (task.state === "needs") {
    return task.halt?.kind === "decision" ? "DECISION" : "PERMISSION";
  }
  return task.state === "done" ? "CLOSED" : task.state.toUpperCase();
}

function stateColor(task, p) {
  if (task.state === "needs") return p.accent;
  if (task.state === "failed") return p.bad;
  if (task.state === "ready") return p.ok;
  if (task.state === "done") return p.ghost;
  return p.dim;
}

// --- left pane: the ledger -----------------------------------------------------

export function buildLeft(model, state, w, p, T) {
  const lines = [];
  const counts = model.counts;
  const now = new Date(model.at);
  const two = v => String(v).padStart(2, "0");
  const clock = two(now.getHours()) + ":" + two(now.getMinutes()) + ":" + two(now.getSeconds());
  const searching = state.searching || state.search;
  const label = searching ? "/" + state.search : "~/" + model.workspace.label;

  lines.push({
    cells: [
      T(" 0x2F ", p.fg, 600),
      T(pad(cut(label, w - 12 - clock.length), w - 10 - clock.length),
        searching ? p.accent : p.dim,
        state.searching ? 600 : 400),
      T("● ", p.ok),
      T(clock, p.dim)
    ]
  });
  lines.push({
    cells: [
      T(" ! " + counts.needs, counts.needs ? p.accent : p.ghost, counts.needs ? 600 : 400),
      T("  ✕ " + counts.failed, counts.failed ? p.bad : p.ghost, counts.failed ? 600 : 400),
      T("  ✓ " + counts.ready, counts.ready ? p.ok : p.ghost),
      T("  ▶ " + counts.working, p.dim),
      T("  · " + counts.done, p.ghost)
    ]
  });
  lines.push({ cells: [T(" " + "─".repeat(Math.max(1, w - 2)), p.rule)] });

  const tasks = visible(model.tasks, state);
  const current = selected(model.tasks, state);

  for (const [key, heading] of GROUPS) {
    const items = tasks.filter(t => t.state === key);
    if (!items.length) continue;
    lines.push({ cells: [T("")] });
    lines.push({
      cells: [
        T(" " + heading + " ", key === "needs" ? p.accent : key === "failed" ? p.bad : p.dim, 600),
        T("─".repeat(Math.max(1, w - 4 - heading.length)) + " " + items.length, p.rule)
      ]
    });

    for (const task of items) {
      const isSelected = current && task.id === current.id;
      const bg = isSelected ? p.sel : "transparent";
      const g = glyph(task, p);
      const tag = task.providerSig + (task.run > 1 ? "·r" + task.run : "");
      const titleW = Math.max(10, w - 9 - tag.length - 2);
      const cells = [
        T(isSelected ? " ❯" : "  ", p.accent, 600),
        { t: g.t, c: g.c, b: g.b, bg },
        T(" " + task.idLabel + " ", p.ghost),
        T(pad(cut(task.title, titleW), titleW), task.state === "done" ? p.ghost : p.fg, isSelected ? 600 : 400),
        T(" " + tag + " ", task.state === "done" ? p.ghost : p.dim, 500)
      ];
      for (const cell of cells) cell.bg = bg;
      lines.push({ cells, bg, selected: isSelected });

      // A second line for the rows that carry an obligation, and for
      // whatever is selected. Everything else stays one row — the ledger's
      // job is to let you scan, not to explain every task at once.
      let sub = null;
      if (task.state === "needs") {
        sub = [T("     " + (task.halt?.kind === "decision"
          ? "awaiting your answer"
          : "wants " + task.halt.op.toLowerCase() + " " + shortPath(task.halt.path, Math.max(8, w - 26))), p.accent)];
      } else if (task.state === "failed") {
        sub = [T("     " + cut(task.fail?.at ?? "stopped", w - 6), p.bad)];
      } else if (task.state === "ready") {
        const n = task.files.length;
        sub = [T("     " + (n ? n + (n === 1 ? " file" : " files") + " changed" : "no file changes reported"), p.dim)];
      } else if (task.state === "working") {
        const last = [...task.steps].reverse().find(s => s.kind === "tool" || s.kind === "command");
        sub = [T("     ", p.dim)]
          .concat(ruleCells(task, 14, p))
          .concat([T("  " + cut(last ? last.verb.toLowerCase() + " " + last.arg : task.activity || "starting", Math.max(6, w - 22)), p.dim)]);
      }
      if (sub && (isSelected || task.state === "needs" || task.state === "failed")) {
        for (const cell of sub) cell.bg = bg;
        lines.push({ cells: sub, bg });
      }
    }
  }

  if (!tasks.length) {
    lines.push({ cells: [T("")] });
    lines.push({
      cells: [T("  nothing in " + FILTERS[state.filter].toLowerCase(), p.ghost)]
    });
  }
  return lines;
}

// --- right pane: the selected task ---------------------------------------------

export function buildRight(model, state, w, p, T) {
  const task = selected(model.tasks, state);
  const lines = [];
  if (!task) {
    return [
      { cells: [T(" no task selected", p.ghost)] },
      { cells: [T("")] },
      { cells: [T(" n opens the composer — a task is permanent, the run is not", p.ghost)] }
    ];
  }

  const word = stateWord(task);
  const head = [
    T(" #" + task.idLabel + "  ", p.ghost),
    T(cut(task.title, Math.max(8, w - 10 - word.length)), p.fg, 600)
  ];
  head.push(T(" ".repeat(Math.max(1, w - 1 - len(head) - word.length)), p.dim));
  head.push(T(word, stateColor(task, p), 600));
  lines.push({ cells: head });
  lines.push({ cells: [T(" " + "─".repeat(Math.max(1, w - 2)), p.rule)] });

  const field = (label, cells) =>
    lines.push({ cells: [T(" " + pad(label, 9), p.ghost, 500)].concat(cells) });

  const runCount = task.runs.length || 1;
  const noteCount = task.notes.length;
  field("TASK", [
    T(
      "open " + Math.round(task.opened) + "m · " +
      runCount + (runCount === 1 ? " run" : " runs") + " · " +
      noteCount + (noteCount === 1 ? " note" : " notes"),
      p.dim
    )
  ]);
  field("RUN " + task.run, [
    T(task.providerSig + " ", p.fg, 600),
    T(pad(task.providerName, 17), p.fg, 500),
    T(padl(fmtDuration(task.elapsed), 7) + "  ", p.dim),
    T(
      task.state === "needs" ? "halted on you"
        : task.state === "working" ? "executing"
          : task.state === "failed" ? "stopped"
            : task.state === "ready" ? "complete · awaiting you"
              : "closed",
      task.state === "needs" ? p.accent : task.state === "failed" ? p.bad : p.dim
    )
  ]);
  // Which machine ran it. One task can outlive the terminal it was started
  // from, and a run's node is persisted per run, never assumed.
  field("ON", [T(model.node + " · " + model.workspace.label, p.ghost)]);

  if (task.history.length) {
    lines.push({ cells: [T("")] });
    field("RUNS", [
      T("this task has been attempted " + runCount + (runCount === 1 ? " time" : " times"), p.ghost)
    ]);
    for (const run of task.runs) {
      const live = run.run === task.run;
      const color = run.outcome === "failed" ? p.bad : live ? p.fg : p.dim;
      lines.push({
        cells: [
          T("   " + padl(run.num, 2) + "  ", p.ghost),
          T(pad(run.provider, 15), live ? p.fg : p.dim, live ? 600 : 400),
          T(padl(run.duration ?? "—", 7) + "  ", p.ghost),
          T(pad(run.state, 10), color, live ? 600 : 500),
          T(run.model ? cut(run.model, Math.max(4, w - 42)) : "", p.ghost)
        ]
      });
    }
  }

  // TRACE — one row per reported signal. A provider that reports nothing has
  // an empty trace and says so; it is never padded with invented steps.
  lines.push({ cells: [T("")] });
  const log = task.steps;
  const shown = state.expand ? log : log.slice(-6);
  const hidden = log.length - shown.length;
  field("TRACE", [
    T(
      "run " + task.run + " · " + log.length + (log.length === 1 ? " event" : " events") +
      (hidden > 0 ? " · " + hidden + " earlier hidden — t" : state.expand && log.length > 6 ? " · t collapses" : ""),
      p.ghost
    )
  ]);
  if (!log.length) {
    lines.push({
      cells: [T("   " + (task.coarse
        ? "this provider does not report step detail"
        : "run has not reported yet"), p.ghost)]
    });
  }
  let lastKind = null;
  for (const step of shown) {
    const kind = step.kind === lastKind ? "" : step.kind.toUpperCase();
    lastKind = step.kind;
    const time = fmtDuration(step.t);
    const argW = Math.max(6, w - 3 - 9 - 8 - time.length - 3);
    const verb = step.human ? "YOU" : step.verb.toUpperCase();
    const bad = step.kind === "fail";
    const halt = step.kind === "halt";
    lines.push({
      cells: [
        T("   " + pad(kind, 9), p.ghost, 500),
        T(pad(verb, 8), step.human || halt ? p.accent : bad ? p.bad : p.dim, step.human || halt ? 600 : 500),
        T(pad(cut(step.arg, argW), argW), step.human ? p.accent : bad ? p.bad : p.fg),
        T("  " + time, p.ghost)
      ]
    });
  }

  // ON TASK — the human record. It is kept on the TASK, so it survives every
  // run, and the next run's input is rebuilt from it.
  if (task.notes.length) {
    lines.push({ cells: [T("")] });
    field("ON TASK", [T("kept across every run", p.ghost)]);
    for (const note of task.notes) {
      const noteW = Math.max(10, w - 26);
      wrap(note.text, noteW).forEach((row, i) => {
        lines.push({
          cells: [
            T("   " + pad(i ? "" : note.kind.toUpperCase(), 11), p.ghost, 500),
            T(pad(row, noteW), p.fg),
            T(i ? "" : "  run " + note.run, p.ghost)
          ]
        });
      });
    }
  }

  lines.push({ cells: [T("")] });
  lines.push(...stateBlock(task, w, p, T));

  const primary = primaryAction(task, state, model);
  const secondary = secondaryAction(task);
  lines.push({ cells: [T("")] });
  const acts = [];
  if (primary) {
    acts.push(T("   ↵ ", p.accent, 600));
    acts.push(T(pad(primary.label, primary.label.length + 3), p.accent, 600));
  }
  if (secondary) acts.push(T("x " + pad(secondary.label, secondary.label.length + 3), p.dim));
  acts.push(T("c NOTE", p.dim));
  lines.push({ cells: acts, pin: true });
  return lines;
}

// The band that says what this task wants from you right now.
function stateBlock(task, w, p, T) {
  const lines = [];
  const row = (label, value, color, weight) =>
    lines.push({
      cells: [T("   " + pad(label, 8), p.dim), T(cut(value, Math.max(6, w - 14)), color, weight)]
    });

  if (task.state === "needs" && task.halt.kind === "permission") {
    lines.push({ cells: [T(" NEEDS YOU · PERMISSION", p.accent, 600)] });
    lines.push({
      cells: [
        T("   " + pad(task.halt.op.toLowerCase(), 8), p.dim),
        T(shortPath(task.halt.path, Math.max(8, w - 14)), p.fg, 600)
      ]
    });
    if (task.halt.plan) row("plan", task.halt.plan, p.fg);
    if (task.halt.why) row("why", task.halt.why, p.dim);
    if (task.halt.options.length) row("options", task.halt.options.join(" · "), p.dim);
    if (task.halt.partial) {
      row("", "some options do not map to ALLOW/REJECT — inspect above", p.ghost);
    }
    row("", task.halt.note, p.ghost);
  } else if (task.state === "needs") {
    lines.push({ cells: [T(" NEEDS YOU · DECISION", p.accent, 600)] });
    // The question in full — it is prose a human has to actually answer, not
    // a label. core/lifecycle.mjs preserves it verbatim; nothing truncates
    // it on the way here.
    for (const rowText of wrap(task.halt.question, Math.max(10, w - 6))) {
      lines.push({ cells: [T("   " + rowText, p.fg, 600)] });
    }
    for (const rowText of wrap(task.halt.detail, Math.max(10, w - 6))) {
      lines.push({ cells: [T("   " + rowText, p.dim)] });
    }
    lines.push({ cells: [T("")] });
    for (const rowText of wrap(task.halt.note, Math.max(10, w - 6))) {
      lines.push({ cells: [T("   " + rowText, p.ghost)] });
    }
  } else if (task.state === "failed") {
    lines.push({
      cells: [
        T(" FAILED", p.bad, 600),
        T("   run " + task.run + " on " + task.providerName + " stopped at " + fmtDuration(task.elapsed), p.dim)
      ]
    });
    row("at", task.fail.at, p.fg);
    // The design's `reason` is one line, and a provider's `error` frequently
    // is not — a stack trace arrives verbatim. So the band keeps its shape
    // (the failure in one line a human can read at a glance) and the rest is
    // DEMOTED rather than discarded, the same treatment the Web gives it.
    row("reason", task.fail.headline, p.bad);
    row("state", task.fail.kept, p.dim);
    if (task.fail.auth) {
      // A provider that is no longer authenticated is not a task failure —
      // 0x2F says so plainly and names the machine, because it cannot sign
      // in for you.
      for (const rowText of wrap(task.fail.auth.sentence, Math.max(10, w - 14))) {
        lines.push({ cells: [T("   " + pad("", 8), p.dim), T(rowText, p.fg)] });
      }
      if (task.fail.remedy) row("run", task.fail.remedy, p.accent, 600);
    }
    row("", "a retry keeps the title, your notes and every answer", p.ghost);
    if (task.fail.detail) {
      lines.push({ cells: [T("")] });
      lines.push({
        cells: [T(" " + task.providerName + " SAID", p.ghost, 600)]
      });
      for (const rowText of wrap(task.fail.detail, Math.max(10, w - 6))) {
        lines.push({ cells: [T("   " + rowText, p.ghost)] });
      }
    }
  } else if (task.state === "ready") {
    lines.push({
      cells: [
        T(" READY", p.ok, 600),
        T("   nothing committed · the changes are in the working tree", p.dim)
      ]
    });
    if (task.files.length) {
      for (const file of task.files) {
        lines.push({ cells: [T("   " + shortPath(file, Math.max(8, w - 6)), p.fg)] });
      }
    } else {
      lines.push({
        cells: [T("   " + (task.coarse
          ? "this provider does not report which files it changed"
          : "no file changes reported"), p.ghost)]
      });
    }
  } else if (task.state === "working") {
    const last = [...task.steps].reverse().find(s => s.kind === "tool" || s.kind === "command");
    lines.push({
      cells: [T(" WORKING", p.fg, 600), T("   ", p.dim)].concat(ruleCells(task, Math.min(28, Math.max(6, w - 22)), p))
    });
    row(last ? last.verb.toLowerCase() : "", last ? last.arg : task.activity || "starting", p.fg);
  } else {
    lines.push({
      cells: [
        T(" CLOSED", p.ghost, 600),
        T("   closed after " + task.run + (task.run === 1 ? " run" : " runs"), p.ghost)
      ]
    });
  }
  return lines;
}

// --- the changes view (d) ------------------------------------------------------
//
// The design's diff mode, over the data a run actually reports. No provider
// in the registry emits hunks and the runtime stores none, so this shows
// what IS known — the change a halted run PLANS to make, or the files a run
// has already touched — instead of inventing a diff.
export function buildChanges(model, state, cols, p, T) {
  const task = selected(model.tasks, state);
  if (!task) return [{ cells: [T(" no task selected", p.ghost)] }];
  const lines = [];
  const planned = task.state === "needs" && task.halt?.kind === "permission";
  const kindWord = planned
    ? "PLANNED · NOT YET WRITTEN"
    : task.state === "done"
      ? "ACCEPTED"
      : "IN THE WORKING TREE · NOTHING COMMITTED";

  lines.push({
    cells: [
      T(" CHANGES  #" + task.idLabel + "  ", p.fg, 600),
      T(cut(task.title, Math.max(8, cols - 40)), p.fg, 600)
    ]
  });
  lines.push({
    cells: [
      T("          " + kindWord + "   run " + task.run + " · " + task.providerName,
        planned ? p.accent : p.dim, planned ? 600 : 400)
    ]
  });
  lines.push({ cells: [T(" " + "─".repeat(Math.max(1, cols - 2)), p.rule)] });

  if (planned) {
    lines.push({ cells: [T("")] });
    lines.push({
      cells: [
        T(" " + pad(task.halt.op.toLowerCase(), 8), p.dim),
        T(task.halt.path, p.fg, 600)
      ]
    });
    if (task.halt.plan) {
      lines.push({ cells: [T("")] });
      for (const row of wrap(task.halt.plan, Math.max(10, cols - 4))) {
        lines.push({ cells: [T("  " + row, p.fg)] });
      }
    }
    lines.push({ cells: [T("")] });
    lines.push({
      cells: [T("  the file has not been written — allow the request and the run writes it", p.ghost)]
    });
  } else if (task.files.length) {
    lines.push({ cells: [T("")] });
    for (const file of task.files) {
      lines.push({ cells: [T("  " + cut(file, cols - 4), p.fg)] });
    }
    lines.push({ cells: [T("")] });
    lines.push({
      cells: [T("  " + task.files.length + (task.files.length === 1 ? " file" : " files") +
        " reported changed by this run · 0x2F does not stage or commit anything", p.ghost)]
    });
  } else {
    lines.push({ cells: [T("")] });
    lines.push({ cells: [T("  this run has not reported writing anything", p.ghost)] });
  }
  return lines;
}

// --- the composer (n) ----------------------------------------------------------

export function buildComposer(model, state, cols, p, T) {
  const c = state.composer;
  const lines = [];
  const w = Math.min(cols - 6, 96);

  lines.push({
    cells: [
      T(" NEW TASK", p.fg, 600),
      T("   a task is permanent — the run you are about to start is not", p.ghost)
    ]
  });
  lines.push({ cells: [T(" " + "─".repeat(Math.max(1, cols - 2)), p.rule)] });
  lines.push({ cells: [T("")] });

  const providerCells = [T(" " + pad("PROVIDER", 11), p.ghost, 500)];
  for (const id of model.providerOrder) {
    const on = id === c.provider;
    const info = model.lookup(id);
    providerCells.push({
      t: " " + info.sig + " " + info.name + " ",
      c: on ? p.bg : p.dim,
      b: on ? 600 : 400,
      bg: on ? p.fg : "transparent"
    });
    providerCells.push(T(" ", p.dim));
  }
  providerCells.push(T(" tab", p.ghost));
  lines.push({ cells: providerCells });
  lines.push({ cells: [T("")] });

  const briefed = c.original !== null;
  lines.push({
    cells: [
      T(" " + pad(briefed ? "BRIEF" : "NOTE", 11), briefed ? p.accent : p.ghost, 500),
      T(briefed
        ? "expanded from your note · ⌃z reverts"
        : "plain words are enough — ⌥↵ expands them into a brief", p.ghost)
    ]
  });

  const body = wrap(c.text, w);
  if (!c.text.length) {
    lines.push({
      cells: [
        T("   ", p.fg),
        { t: " ", c: p.accent, cur: true, bg: "transparent" },
        T(" what should the machine do?", p.ghost)
      ]
    });
  } else {
    body.forEach((row, i) => {
      const last = i === body.length - 1;
      lines.push({
        cells: [T("   " + row, p.fg)].concat(
          last ? [{ t: " ", c: p.accent, cur: true, bg: "transparent" }] : []
        )
      });
    });
  }

  lines.push({ cells: [T("")] });
  if (briefed) {
    lines.push({
      cells: [
        T(" " + pad("YOUR NOTE", 11), p.ghost, 500),
        T(cut(c.original, Math.max(8, cols - 16)), p.ghost)
      ]
    });
    lines.push({ cells: [T("")] });
  }
  lines.push({
    cells: [
      T(" ↵ START ", p.accent, 600),
      T("  ⌥↵ brief   ⌃n newline   tab provider   esc cancel", p.dim)
    ]
  });
  // The title the ledger will show is DERIVED from these words — there is no
  // second field to fill in, and saying so here is the only way a first-time
  // user learns it.
  lines.push({ cells: [T("")] });
  lines.push({ cells: [T(" 0x2F names the task from what you write.", p.ghost)] });
  return lines;
}

// --- help (?) ------------------------------------------------------------------

const KEYS = [
  ["j  k", "move between tasks · g / G jump to first / last"],
  ["J  K", "scroll the task detail"],
  ["tab", "filter the ledger — all · needs you · failed · ready · working"],
  ["/", "search by title, brief or number"],
  ["↵", "the one action this task is waiting for (shown bottom-left)"],
  ["x", "the alternative — reject · save only · send back · drop"],
  ["d", "changes — the planned write, or what the run already touched"],
  ["c", "note or correct — kept on the task, carried into every later run"],
  ["p", "point the next run at another provider"],
  ["t", "expand the trace of the current run"],
  ["n", "new task — ⌥↵ expands your note into a brief, ↵ starts it"],
  ["esc", "clear filter and search · cancel an input"],
  ["?", "this list"],
  ["q", "detach — runs keep executing without you"]
];

const MODEL_NOTES = [
  "a TASK is permanent — its title, your notes, your answers, its whole run history",
  "a RUN is one provider attempt at that task; runs fail, get sent back, get replaced",
  "a permission resumes the same run · a decision or a correction starts the next one",
  "the runtime is shared — the same tasks are in the CLI, the web client and the phone"
];

export function buildHelp(cols, p, T) {
  const lines = [
    { cells: [T(" KEYS", p.fg, 600)] },
    { cells: [T(" " + "─".repeat(Math.max(1, cols - 2)), p.rule)] },
    { cells: [T("")] }
  ];
  for (const [key, description] of KEYS) {
    lines.push({ cells: [T("   " + pad(key, 8), p.accent, 600), T(description, p.dim)] });
  }
  lines.push({ cells: [T("")] });
  lines.push({ cells: [T("   MODEL", p.fg, 600)] });
  for (const note of MODEL_NOTES) lines.push({ cells: [T("   " + note, p.dim)] });
  return lines;
}

// --- the whole frame -----------------------------------------------------------

export function frame(model, state, opts = {}) {
  const cols = Math.max(60, opts.cols ?? 132);
  const rows = Math.max(12, opts.rows ?? 38);
  const p = opts.palette;
  const T = (t, c, b) => ({ t: String(t), c, b: b || 400, bg: "transparent" });

  const FOOTER = 3;
  const avail = rows - FOOTER;
  let lines = [];
  let hint = "";

  const padTo = (cells, w, bg) => {
    const out = (cells ?? []).map(cell => ({
      ...cell,
      bg: cell.bg && cell.bg !== "transparent" ? cell.bg : bg || "transparent"
    }));
    let room = w - len(out);
    if (room < 0) {
      let over = -room;
      for (let i = out.length - 1; i >= 0 && over > 0; i--) {
        const take = Math.min(over, out[i].t.length);
        out[i] = { ...out[i], t: out[i].t.slice(0, out[i].t.length - take) };
        over -= take;
      }
      room = 0;
    }
    if (room > 0) out.push({ t: " ".repeat(room), c: p.dim, b: 400, bg: bg || "transparent" });
    return out;
  };

  if (state.mode === "quit") {
    lines = [
      { cells: [T("")] },
      { cells: [T(" detached.", p.fg, 600)] },
      { cells: [T(" runs keep executing — reattach with ", p.dim), T("2f tui", p.accent)] }
    ];
  } else if (state.mode === "help") {
    lines = buildHelp(cols, p, T);
    hint = "any key   back";
  } else if (state.mode === "composer") {
    lines = buildComposer(model, state, cols, p, T).slice(0, avail);
  } else if (state.mode === "diff") {
    const all = buildChanges(model, state, cols, p, T);
    const max = Math.max(0, all.length - avail);
    const off = Math.min(state.dscroll, max);
    lines = all.slice(off, off + avail);
    hint = "j/k scroll" + (max ? "   " + Math.min(all.length, off + avail) + "/" + all.length : "") +
      "   any other key   back";
  } else {
    // Two panes. The left width is a fixed reading measure at normal sizes
    // and a fraction only when the terminal is too narrow to afford it.
    const narrow = cols < 110;
    const Lw = narrow ? Math.round(cols * 0.42) : cols <= 140 ? 46 : 54;
    const Rw = cols - Lw - 1;
    const left = buildLeft(model, state, Lw, p, T);
    const right = buildRight(model, state, Rw, p, T);

    // Window the ledger around the selection, keeping its three-row header
    // pinned — the counts and the clock must never scroll away.
    let leftWindow = left;
    if (left.length > avail) {
      const selIndex = left.findIndex(l => l.selected);
      const start = Math.max(3, Math.min(left.length - avail + 3, selIndex - Math.floor(avail / 2)));
      leftWindow = left.slice(0, 3).concat(left.slice(start, start + avail - 3));
    }

    // The action row is pinned to the bottom of the right pane: the one
    // thing this task wants from you never scrolls out of view.
    const pinIndex = right.findIndex(l => l.pin);
    const pinned = pinIndex >= 0 ? right[pinIndex] : null;
    let body = pinIndex >= 0 ? right.slice(0, pinIndex) : right.slice();
    const cap = pinned ? avail - 2 : avail;
    if (body.length > cap) {
      const headRows = body.slice(0, 2);
      const rest = body.slice(2);
      const maxOff = Math.max(0, rest.length - (cap - 3));
      const off = Math.min(state.rscroll, maxOff);
      body = headRows.concat(rest.slice(off, off + cap - 3)).concat([
        {
          cells: [
            T("   ", p.ghost),
            { t: "─".repeat(Math.max(4, Rw - 24)), c: p.rule, b: 400, bg: "transparent" },
            T("  " + Math.min(rest.length, off + cap - 3) + "/" + rest.length + " · J K", p.ghost)
          ]
        }
      ]);
    }
    let rightWindow = body;
    if (pinned) {
      while (rightWindow.length < avail - 2) rightWindow.push({ cells: [T("")] });
      rightWindow = rightWindow.concat([
        { cells: [T(" " + "─".repeat(Math.max(1, Rw - 2)), p.rule)] },
        pinned
      ]);
    }

    for (let i = 0; i < avail; i++) {
      const l = leftWindow[i];
      const r = rightWindow[i];
      const bg = l?.bg ?? "transparent";
      lines.push({
        cells: padTo(l ? l.cells : [T("")], Lw, bg)
          .concat([{ t: "│", c: p.rule, b: 400, bg: "transparent" }])
          .concat(padTo(r ? r.cells : [T("")], Rw, "transparent"))
      });
    }

    const task = selected(model.tasks, state);
    const primary = primaryAction(task, state, model);
    const secondary = secondaryAction(task);
    const parts = [];
    if (primary) parts.push("↵ " + primary.label.toLowerCase());
    if (secondary) parts.push("x " + secondary.label.toLowerCase());
    if (task) parts.push("c note");
    if (task?.hasChanges) parts.push("d changes");
    parts.push("j/k move", "/ search", "tab " + FILTERS[state.filter].toLowerCase(), "n new", "? keys", "q detach");
    for (const part of parts) {
      const next = hint ? hint + "   " + part : part;
      if (next.length > cols - 4) {
        hint += "   ?";
        break;
      }
      hint = next;
    }
  }

  while (lines.length < avail) lines.push({ cells: [T("")] });
  lines = lines.slice(0, avail);

  lines.push({ cells: [T(" " + "─".repeat(Math.max(1, cols - 2)), p.rule)] });

  if (state.input) {
    const task = selected(model.tasks, state);
    lines.push({
      cells: [
        T(" " + INPUT_LABELS[state.input] + " ", p.accent, 600),
        T("› ", p.ghost),
        T(cut(state.draft, Math.max(8, cols - INPUT_LABELS[state.input].length - 6)), p.fg),
        { t: " ", c: p.accent, cur: true, bg: "transparent" }
      ]
    });
    lines.push({
      cells: [
        T(" ↵ commit   esc cancel", p.dim),
        T("   ", p.dim),
        T(INPUT_NOTES[state.input] ?? "", p.ghost),
        T(task && state.input === "answer" ? "" : "", p.ghost)
      ]
    });
  } else if (state.searching) {
    lines.push({
      cells: [
        T(" SEARCH ", p.accent, 600),
        T("/ ", p.ghost),
        T(state.search, p.fg),
        { t: " ", c: p.accent, cur: true, bg: "transparent" }
      ]
    });
    lines.push({
      cells: [
        T(" ↵ keep   esc clear   " + visible(model.tasks, state).length + " of " +
          model.tasks.length + " tasks match", p.dim)
      ]
    });
  } else {
    const flash = state.flash;
    lines.push({
      cells: flash
        ? [
            T(" " + (flash.tone === "warn" ? "·" : "✓") + " ", flash.tone === "warn" ? p.bad : p.ok, 600),
            T(cut(flash.text, cols - 5), p.fg)
          ]
        : [
            T(" › ", p.ghost, 600),
            T(state.busy ? "working…" : "n to submit work", p.ghost)
          ]
    });
    lines.push({ cells: [T(" " + cut(hint, cols - 2), p.dim)] });
  }

  for (const line of lines) {
    for (const cell of line.cells) {
      if (!cell.b) cell.b = 400;
      if (!cell.bg) cell.bg = "transparent";
    }
  }
  // `bg` travels with the frame because the caret cell is drawn inverted —
  // its ink is the terminal's own ground, which only the palette knows.
  return { lines, cols, rows, bg: p.bg };
}
