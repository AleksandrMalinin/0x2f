// Ledger projection — normalized Work events -> the Web ledger view model.
//
// This module is PURE presentation, the Web client's counterpart to
// render.mjs (which does the same job for the terminal). It decides how a
// task *reads*; it never decides what a status MEANS. Lifecycle stays in
// core/lifecycle.mjs, business rules stay in core/actions.mjs.
//
// It is DOM-free so that it can be
//   - imported by Node tests, and
//   - served verbatim to the browser as an ES module (src/web/app.js).
// One implementation, two runtimes, no build step. Its one import
// (../core/title.mjs) follows the same rule: the specifier resolves in Node
// and, because the server serves that file at /core/title.mjs, in the
// browser too — so the title 0x2F persisted and the title the client
// reasons about can never drift.
//
// Progressive fidelity: how much of a run's shape can be drawn is a
// DECLARED provider capability (capabilities.supportsStructuredEvents /
// supportsFileChanges / supportsCommands / resultOnCompletion), never an
// inference from "we saw no events". A dimension SHOWS when it is actually
// present in the event log (an observed fact always renders — see
// `sections()`); the declaration governs whether an absence is expected
// (quiet) or a drift worth a console warning, never whether data is hidden.
//
// Every mark on the trace corresponds to exactly one normalized event —
// there is no time-proportional or index-proportional geometry here. A
// provider that reports nothing gets a single ambient liveness bar, never a
// synthesized phase frame and never a per-interval dot that could be misread
// as a reported step.

import { deriveTitle, briefBody } from "../core/title.mjs";

export const LONG_TITLE_CHARS = 90;

export const COLORS = {
  ink: "#2f2f2f",
  inkSoft: "#37424c",
  muted: "#5c6771",
  rule: "#dbe2e7",
  accent: "#2f5fa8",
  fail: "#b8532a",
  unobserved: "#c6cfd6",
  trackPast: "#2f2f2f",
  trackLive: "#3d454c"
};

export const STATE_LABELS = {
  working: "WORKING",
  needs_you: "NEEDS YOU",
  ready: "READY",
  failed: "FAILED",
  done: "DONE"
};

// A run's outcome uses the Work status vocabulary (the provider contract
// produces ready / needs_you / failed; "working" is the in-flight run).
export const RUN_STATE_LABELS = {
  working: "WORKING",
  needs_you: "NEEDS YOU",
  ready: "READY",
  failed: "FAILED"
};

// Ledger order: what wants you first, then what is moving, then what is
// finished. Newest first inside a state. Mirrors the CLI's grouping so both
// surfaces present the same priority.
const STATE_RANK = { needs_you: 0, working: 1, ready: 2, failed: 3, done: 4 };

export function stateRank(status) {
  return STATE_RANK[status] ?? 9;
}

export function sortTasks(tasks) {
  return tasks
    .slice()
    .sort((a, b) => stateRank(a.status) - stateRank(b.status) || b.id - a.id);
}

export function counts(tasks) {
  const out = { needs_you: 0, working: 0, ready: 0, failed: 0, done: 0 };
  for (const task of tasks) {
    if (out[task.status] !== undefined) out[task.status]++;
  }
  return out;
}

export function two(value) {
  return String(value).padStart(2, "0");
}

// m:ss for a run you are watching, h:mm:ss once it has been going (or
// waiting on you) for over an hour — "479:23" tells you nothing.
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return minutes + ":" + two(s % 60);
  return Math.floor(minutes / 60) + ":" + two(minutes % 60) + ":" + two(s % 60);
}

function ms(value) {
  const t = Date.parse(value ?? "");
  return Number.isFinite(t) ? t : null;
}

function uniq(list) {
  const out = [];
  for (const item of list) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

// --- rich text (a small safe Markdown subset) ------------------------------
//
// Provider-authored prose (a written result, a failure, a decision question)
// renders through a deliberately small subset: headings, paragraphs, lists,
// bold, inline code and fenced code blocks. Nothing else — no links, images,
// blockquotes, tables or raw HTML. The parser is pure (no DOM) so it can run
// in Node tests and in the browser from the same file; it emits only text
// tokens, so the DOM layer can build every node with textContent and never
// touch innerHTML.
//
// Token shapes (inline): { text } | { code } | { bold: [token, ...] }
// Block shapes:            { type: "heading", level: 1..3, inline: [token, ...] }
//                          { type: "paragraph", inline: [token, ...] }
//                          { type: "list", ordered: bool, items: [[token, ...], ...] }
//                          { type: "code", lang: string|null, text: string }

const BOLD_RE = /\*\*([^*]+)\*\*/;
const CODE_RE = /`([^`]+)`/;
const FENCE_RE = /^```(\S*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^\s*[-*+]\s+(.+)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.+)$/;

// Inline pass: balanced **bold** and `code` spans, earliest construct first.
// Code content is verbatim — it never re-enters inline parsing. Anything
// unbalanced (`**` or a lone backtick) stays literal text, so a stray marker
// in prose is shown as-is instead of being swallowed or turned into markup.
export function parseInline(text) {
  const tokens = [];
  let rest = String(text);
  while (rest) {
    const bold = rest.match(BOLD_RE);
    const code = rest.match(CODE_RE);
    const pickBold = bold && (!code || bold.index < code.index);
    const chosen = pickBold ? bold : code;
    if (!chosen) {
      if (rest) tokens.push({ text: rest });
      break;
    }
    if (chosen.index > 0) tokens.push({ text: rest.slice(0, chosen.index) });
    if (pickBold) {
      tokens.push({ bold: parseInline(chosen[1]) });
    } else {
      tokens.push({ code: chosen[1] });
    }
    rest = rest.slice(chosen.index + chosen[0].length);
  }
  return tokens;
}

// Block pass: fenced code, ATX headings (1–6, styled as 1–3), bullet and
// ordered lists, paragraphs. Fence content is kept verbatim (newlines and
// long lines included — layout keeps it inside the Ledger width). Paragraph
// soft breaks collapse to spaces, the way Markdown prose reads.
export function parseRich(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const lang = fence[1] || null;
      const code = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: "heading",
        level: Math.min(heading[1].length, 3),
        inline: parseInline(heading[2].trim())
      });
      i++;
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const ordered = ORDERED_RE.test(line);
      const items = [];
      while (i < lines.length) {
        const item = (ordered ? ORDERED_RE : BULLET_RE).exec(lines[i]);
        if (!item) break;
        items.push(parseInline(item[1].trim()));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        !t ||
        FENCE_RE.test(t) ||
        HEADING_RE.test(t) ||
        BULLET_RE.test(t) ||
        ORDERED_RE.test(t)
      ) {
        break;
      }
      para.push(t);
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" ")) });
  }

  return blocks;
}

// --- progressive fidelity ----------------------------------------------------

// The reading mode: a pure function of declared capability, never of what
// happened to arrive in the event log so far. "coarse" — no structured
// stream at all. "partial" — structured, but this run has not (yet) produced
// evidence of either dimension the design can show (files or commands): a
// rich provider thirty seconds in reads this way, and it is NOT the same
// thing as coarse — nothing here says "not reported". "rich" — the provider
// declares at least one of the observable dimensions.
export function fidelity(providerId, providers = {}) {
  const caps = providers[providerId]?.capabilities ?? {};
  if (caps.supportsStructuredEvents !== true) return "coarse";
  return caps.supportsFileChanges === true || caps.supportsCommands === true
    ? "rich"
    : "partial";
}

// Every mark class the trace can draw. Height encodes class, nothing else —
// there is no phase, so there is nothing else height COULD encode. "read",
// "search" and "plan" have no source today (that would mean reading tool
// names, the inference this rewrite removes); they exist in the vocabulary
// so a future typed tool kind (ACP's `kind`, see providers/acp.mjs) can
// light them up without another projection change.
export const MARK_CLASS = [
  "quiet", "read", "search", "plan", "change", "command", "tool", "human", "halt", "fail"
];

// Mark class from the event SHAPE the step was built from, never from the
// tool's name. `step.kind` already carries this (toSteps decided it once,
// at the only point event fields are legitimately provider vocabulary).
export function markClass(step) {
  if (!step) return "quiet";
  switch (step.kind) {
    case "change":
    case "command":
    case "tool":
    case "human":
    case "halt":
    case "fail":
      return step.kind;
    default:
      return "tool";
  }
}

// --- step extraction -------------------------------------------------------

// A short, single-line rendering of long text (an answer, a question).
function snippet(value, max = 140) {
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// The argument a step operated on, in provider-neutral terms: whatever the
// tool input names as its target. Falls back to nothing rather than guessing.
export function stepArgument(input = {}) {
  const candidates = [
    input.file_path,
    input.path,
    input.notebook_path,
    input.command,
    input.pattern,
    input.query,
    input.prompt,
    input.url
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Turn one task's event log into the ordered units the ledger draws — one
// unit per reported signal, never a synthesized one. `files`/`commands` are
// convenience projections of the same units (deduped paths; raw command
// strings, one per invocation).
export function toSteps(task, events = [], opts = {}) {
  const base = opts.base ?? "";
  const origin = ms(events.find(e => e.at)?.at) ?? ms(task.createdAt) ?? Date.now();
  const steps = [];
  let activity = "";
  let sessionId = task.execution?.externalSessionId ?? null;
  let lastAt = origin;

  for (const event of events) {
    const at = ms(event.at) ?? origin;
    const t = Math.max(0, (at - origin) / 1000);
    if (at > lastAt) lastAt = at;

    switch (event.type) {
      case "run.started":
        if (event.sessionId) sessionId = event.sessionId;
        break;

      case "progress":
        if (typeof event.text === "string" && event.text.trim()) {
          activity = event.text.replace(/\s+/g, " ").trim();
        }
        break;

      case "tool.started": {
        const input = event.input ?? {};
        // Paths read as project paths, not as this machine's filesystem.
        const argument = relativePath(base, stepArgument(input));
        const isCommand = typeof input.command === "string";
        steps.push({
          kind: isCommand ? "command" : "tool",
          verb: String(event.name ?? "step").toUpperCase(),
          arg: argument,
          at,
          t,
          human: false
        });
        activity = "";
        break;
      }

      case "file.changed": {
        const changed = relativePath(base, event.path);
        if (changed) {
          steps.push({ kind: "change", verb: "CHANGED", arg: changed, at, t, human: false });
        }
        break;
      }

      case "needs_user": {
        // The worker records `needs_user` twice for one block: once from the
        // provider stream, once as the terminal outcome. Only the outcome
        // carries `blockedOn`; collapse them into a single halt step.
        const reason = event.reason ?? event.blockedOn?.type ?? "decision";
        const last = steps[steps.length - 1];
        if (last && last.kind === "halt") {
          last.at = at;
          last.t = t;
          last.reason = reason;
          break;
        }
        steps.push({
          kind: "halt",
          verb: "HALT",
          arg: reason === "permission" ? "waiting on your permission" : "waiting on your decision",
          reason,
          at,
          t,
          human: false
        });
        break;
      }

      case "task.answered": {
        // The human answered a needs_you/decision block. A decision is
        // answered, never allowed/rejected — the ledger shows it as a human
        // step so the answer is part of the run's story.
        const answer =
          typeof event.answer === "string" && event.answer.trim()
            ? event.answer.replace(/\s+/g, " ").trim()
            : "";
        steps.push({
          kind: "human",
          verb: "YOU",
          arg: answer ? "answered the decision · " + snippet(answer, 140) : "answered the decision",
          at,
          t,
          human: true
        });
        break;
      }

      case "task.updated":
        // A resume the human authorised. `grant` is normalized Work state
        // (lifecycle.beginResume records it as execution.lastAction), so the
        // ledger can show who moved the task without inventing anything.
        if (event.grant === "allow" || event.grant === "reject") {
          steps.push({
            kind: "human",
            verb: "YOU",
            arg: event.grant === "allow"
              ? "granted the request · resuming the same session"
              : "declined the request · resuming with it withdrawn",
            at,
            t,
            human: true
          });
        }
        break;

      case "permission.resolved":
        // An interactive ACP permission answered in place — the same run
        // continues (no session restart, no new worker).
        steps.push({
          kind: "human",
          verb: "YOU",
          arg: event.grant === "allow"
            ? "allowed the request · continuing the same run"
            : "declined the request · continuing the same run",
          at,
          t,
          human: true
        });
        break;

      case "run.failed":
        steps.push({
          kind: "fail",
          verb: "FAILED",
          arg: String(event.error ?? "Execution failed"),
          at,
          t,
          human: false
        });
        break;

      default:
        break;
    }
  }

  const files = uniq(steps.filter(s => s.kind === "change").map(s => s.arg));
  const commands = steps.filter(s => s.kind === "command").map(s => s.arg);

  return { origin, lastAt, steps, files, commands, activity, sessionId };
}

// --- trace tail --------------------------------------------------------------
//
// Fixed counts, no stride, no merge, no scroll. One mark per reported
// signal, most recent N, oldest dropped silently. The halt tear and the
// struck fail mark are positions, not units — they sit outside this budget
// and are placed separately, always visible.

export const TAIL = { expanded: 24, collapsed: 12, provenance: 12 };

export function tail(steps, n) {
  const units = steps.filter(s => s.kind !== "halt" && s.kind !== "fail");
  return { marks: units.slice(-n), truncated: units.length > n, total: units.length };
}

// --- the travel rule ---------------------------------------------------------
//
// One cell per unit of WORK — one reported event, one mark, at a fixed
// width. There is no time-proportional or index-proportional allocation:
// a step that held the run for 40s draws exactly the same width as one that
// took 2s, because both are one fact, not a duration to spend pixels on.
// Height encodes class (markClass); nothing else.

const CLASS_HEIGHT = {
  quiet: 4,
  read: 6,
  search: 6,
  plan: 8,
  change: 15,
  command: 11,
  tool: 8,
  human: 13
};

function classHeight(cls, scale) {
  return Math.max(3, Math.round((CLASS_HEIGHT[cls] ?? 8) * scale));
}

// Changes are drawn in the accent regardless of finished state — an artifact
// stays legible as an artifact, not just as "a past step like any other".
function classColor(cls, accent, finished) {
  if (cls === "human" || cls === "change") return accent;
  return finished ? COLORS.trackPast : COLORS.trackLive;
}

// A coarse provider reports no events, so there is nothing to tail. The
// honest reading is ambient time + liveness, never a per-interval dot: in a
// lane where every other mark means "one real event happened", a repeated
// unit here would plausibly be misread as one too. One continuous bar
// (capped, so its length can never be mistaken for a step count), the same
// head/tear the live lane uses, and the elapsed-time readout that already
// exists in the status line.
function coarseTrace({ w, scale, accent, live, halted, elapsedSeconds }) {
  const CAP_PX = 220;
  const PX_PER_SECOND = 0.5;
  const barW = Math.max(10, Math.min(CAP_PX, Math.round(elapsedSeconds * PX_PER_SECOND)));
  const cells = [{ x: 0, w: barW + "px", h: Math.round(4 * scale) + "px", c: COLORS.unobserved, ambient: true }];
  let x = barW;
  const doneW = x;
  if (halted) {
    x += 8;
    cells.push({ x, w: "2px", h: "0px", c: "transparent", isHalt: true });
    x += 2;
  } else if (live) {
    x += 8;
    cells.push({ x, w: w + "px", h: Math.round(28 * scale) + "px", c: accent, isHead: true });
    x += w;
  }
  return {
    cells,
    doneW: Math.round(doneW) + "px",
    totalW: Math.round(x) + "px",
    truncated: false,
    total: 0,
    units: []
  };
}

export function trace(steps, opts = {}) {
  const {
    n = TAIL.expanded,
    w = 4,
    gap = 2,
    scale = 1,
    accent = COLORS.accent,
    live = false,
    halted = false,
    finished = false,
    coarse = false,
    elapsedSeconds = 0
  } = opts;

  if (coarse) return coarseTrace({ w, scale, accent, live, halted, elapsedSeconds });

  const { marks: units, truncated, total } = tail(steps, n);
  const cells = [];
  let x = 0;
  for (const step of units) {
    if (cells.length) x += gap;
    const cls = markClass(step);
    cells.push({
      x,
      w: w + "px",
      h: classHeight(cls, scale) + "px",
      c: classColor(cls, accent, finished),
      cls,
      arg: step.arg
    });
    x += w;
  }
  const doneW = x;

  // The point of execution: a luminous head while the run is moving, a tear
  // in the track while it is halted on the human. Neither is a unit — both
  // are positions, placed after every real mark regardless of tail budget.
  if (halted) {
    if (cells.length) x += gap;
    cells.push({ x, w: "2px", h: "0px", c: "transparent", isHalt: true });
    x += 2;
  } else if (live) {
    if (cells.length) x += gap;
    cells.push({ x, w: w + "px", h: Math.round(28 * scale) + "px", c: accent, isHead: true });
    x += w;
  }

  return {
    cells,
    doneW: Math.round(doneW) + "px",
    totalW: Math.round(x) + "px",
    truncated,
    total,
    units
  };
}

// --- brackets ----------------------------------------------------------------
//
// One is implementable from what the system actually knows: CHANGES, spanning
// the first to the last change-class mark in the VISIBLE tail. VERIFY needs a
// typed check result (a provider does not have one — see §11 of the spec);
// INSPECT needs a declared phase (nothing declares one). Both stay
// unreachable by construction rather than approximated from a command string
// or a tool-name guess.

function contiguousRuns(list, predicate) {
  const runs = [];
  let start = -1;
  list.forEach((item, i) => {
    const hit = predicate(item);
    if (hit && start === -1) start = i;
    if (!hit && start !== -1) {
      runs.push({ from: start, to: i - 1 });
      start = -1;
    }
  });
  if (start !== -1) runs.push({ from: start, to: list.length - 1 });
  return runs;
}

// `units` and `cells` come from the SAME trace() call (units[i] <-> cells[i]
// for i < units.length) so a bracket's pixels always agree with what is
// actually drawn.
export function brackets(units, caps = {}, cells = []) {
  const out = [];
  if (caps?.supportsFileChanges === true) {
    for (const span of contiguousRuns(units, s => markClass(s) === "change")) {
      const from = cells[span.from];
      const to = cells[span.to];
      if (!from || !to) continue;
      out.push({
        label: "CHANGES",
        x: Math.round(from.x) + "px",
        w: Math.round(to.x + parseFloat(to.w) - from.x) + "px"
      });
    }
  }
  return out;
}

// --- section composition ------------------------------------------------------
//
// A dimension SHOWS when it is actually present in this run's events —
// observed facts always render, even against a false declaration (a
// provider that emits more than it declared is not hidden, it is flagged:
// see `capabilityDrift`). The declaration only decides whether that absence
// is expected and quiet, or a contradiction worth a console warning.
//
// CHECKS never appears: there is no typed check result anywhere in the
// normalized model, so it is omitted from the projection entirely — never a
// pending placeholder, never an empty section.

export function sections(task, steps, caps = {}, result = null) {
  const activityUnits = steps.filter(
    s => s.kind === "tool" || s.kind === "command" || s.kind === "human" || s.kind === "halt"
  );
  const files = uniq(steps.filter(s => s.kind === "change").map(s => s.arg));
  const commands = steps.filter(s => s.kind === "command").map(s => s.arg);

  const failed = task.status === "failed" || (task.status === "done" && !!task.error);
  const closed = task.status === "ready" || task.status === "done";
  const hasResult = typeof result === "string" && result.trim().length > 0;

  const capabilityDrift = [];
  if (files.length && caps.supportsFileChanges !== true) capabilityDrift.push("fileChanges");
  if (commands.length && caps.supportsCommands !== true) capabilityDrift.push("commands");
  if (activityUnits.length && caps.supportsStructuredEvents !== true) capabilityDrift.push("structuredEvents");

  return {
    activity: activityUnits.length
      ? { recent: activityUnits.slice(-5), earlier: Math.max(0, activityUnits.length - 5) }
      : null,
    files: files.length ? { paths: files } : null,
    commands: commands.length ? { commands } : null,
    result: !failed && closed && hasResult ? { text: result } : null,
    failure: failed ? { error: task.error ?? "" } : null,
    capabilityDrift
  };
}

// Which sections a status is allowed to show at all, even when data is
// present (§10 — the lifecycle hierarchy). DONE is deliberately the
// narrowest: a closed row carries no trace and no operational detail, only
// what it produced.
const SECTION_KEYS_BY_STATUS = {
  working: ["activity", "files", "commands"],
  needs_you: ["activity", "files"],
  ready: ["result", "files", "commands"],
  failed: ["failure", "files"],
  done: ["result"]
};

// --- the quiet note ------------------------------------------------------------
//
// One condition, one constant string. A capability-GAP note (a declared
// limitation contradicting what is visible) is deliberately not implemented
// here: it would fire from a declaration alone, without the UI actually
// having produced a misleading juxtaposition, and the more conservative
// choice — proven by nothing having gone wrong in the composed sections
// above — is silence.
export function capabilityNote(task, caps = {}) {
  if (caps.resultOnCompletion === true && task.status === "working") {
    return "result reported on completion";
  }
  return null;
}

// --- misc row helpers --------------------------------------------------------

export function blockedTitle(blockedOn) {
  if (!blockedOn) return "";
  if (blockedOn.type === "permission") return "PERMISSION REQUIRED";
  if (blockedOn.type === "decision") return "DECISION REQUIRED";
  return "NEEDS YOU";
}

export function relativePath(base, file) {
  if (!file) return "";
  if (!base) return file;
  const prefix = base.endsWith("/") ? base : base + "/";
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

// --- the decision question (§03) --------------------------------------------
//
// A blocking question is prose, not a label: the heading is its first
// sentence (the same split the agent's own writing already has — a concrete
// question, then the tradeoff that makes it non-obvious), and everything
// after that renders as body prose through the shared rich-text subset. A
// one-line question renders as heading only — this is a render-time
// derivation, never a stored value, so raising the storage cap (see
// core/lifecycle.mjs) needed no migration here.
const SENTENCE_END_RE = /^(.+?[.?!])(\s|$)/s;

export function firstSentence(text) {
  const s = String(text ?? "").trim();
  const m = s.match(SENTENCE_END_RE);
  return m ? m[1] : s;
}

// The prose after the first sentence — "" for a one-line question, which
// callers treat as "heading only, no body".
export function restAfterFirstSentence(text) {
  const s = String(text ?? "").trim();
  const heading = firstSentence(s);
  return s.slice(heading.length).trim();
}

// --- provider failure classification (§01) ----------------------------------
//
// A failure is classified at the provider boundary (task.failure.kind, set
// by the adapter — see core/lifecycle.mjs) or, for legacy tasks and adapters
// that predate the field, conservatively inferred here from the stored error
// text. Inference lives ONLY at projection time, never in the adapter
// contract, so no migration of persisted tasks is ever needed. Only "auth"
// changes presentation today.
const AUTH_INFERENCE_RE =
  /\b401\b|unauthenticated|not authenticated|re-?authenticate|invalid api key|invalid x-api-key|authentication_error|oauth[^.\n]*(expired|invalid|revoked)/i;

export function inferFailureKind(task) {
  if (task?.failure?.kind) return task.failure.kind;
  if (AUTH_INFERENCE_RE.test(task?.error ?? "")) return "auth";
  return null;
}

// The failure band's copy for a provider-not-authenticated stop: one string
// built from exactly the provider's display name and the node label —
// nothing provider-shaped reaches the caller. `remedy` is optional,
// adapter-authored, shown verbatim in its own slot (or the slot is omitted
// and a generic sign-in instruction names the provider and the machine
// instead — a third-party manifest provider gets a comprehensible state
// without 0x2F knowing anything about how it authenticates).
export function authFailureCopy(providerDisplayName, node, remedy) {
  const who = providerDisplayName || "This provider";
  const where = node || "this machine";
  return {
    sentence: who + "'s authentication is no longer valid. 0x2F cannot authenticate a provider for you.",
    hintLabel: remedy ? "ON " + where.toUpperCase() : null,
    hint: remedy || null,
    instruction: remedy
      ? "The task and its runs are kept. Re-authenticate, then RETRY."
      : "Sign in to " + who + " on " + where + ", then RETRY. The task and its runs are kept."
  };
}

// The one-line summary used identically wherever a failure reads as a single
// row/line — the desktop compact row, the status-line `arg`, and the mobile
// row (which appends " · task kept" itself, nothing else): parameterised by
// exactly the provider display name and the node, never provider vocabulary.
export function authFailureLine(providerDisplayName, node) {
  const who = (providerDisplayName || "this provider").toLowerCase();
  return node ? who + " is not authenticated on " + node : who + " is not authenticated";
}

// --- run history ------------------------------------------------------------
//
// A task can hold several runs (same intent, different providers). Run-level
// events in the task's log carry the run number; events written before run
// history existed carry none and belong to run 1 — the only run a legacy task
// ever had. Task lifecycle events (task.created/updated/closed) describe the
// task, not a run, and are never part of any run's event list.

export function eventsForRun(events, runNumber) {
  const n = Number(runNumber);
  return events.filter(e => {
    if (typeof e.type === "string" && e.type.startsWith("task.")) return false;
    if (e.run !== undefined && e.run !== null) return e.run === n;
    return n === 1; // legacy events belong to the only run there was
  });
}

// One run row for the RUNS strip: everything the DOM needs, already decided.
// The API returns run records (core/runs.mjs projection); this formats them
// in the ledger's visual language. Fields a provider never supplied stay
// absent ("—") — missing observability is shown quietly, never invented.
// `opts.providers` maps provider ids to display names (e.g. "Claude Code")
// when the client knows them; unknown ids fall back to the id itself.
export function projectRuns(runs = [], opts = {}) {
  const names = opts.providers ?? {};
  return runs.map(r => {
    const started = ms(r.startedAt);
    const completed = ms(r.completedAt);
    const durationMs = Number.isFinite(r.durationMs)
      ? r.durationMs
      : started && completed
        ? completed - started
        : null;
    return {
      run: r.run,
      num: two(r.run),
      provider: String(names[r.provider] ?? r.provider ?? "?").toUpperCase(),
      node: r.node ?? null,
      model: r.model ?? null,
      duration: durationMs !== null ? fmtDuration(durationMs / 1000) : null,
      outcome: r.outcome ?? "working",
      state:
        RUN_STATE_LABELS[r.outcome] ?? String(r.outcome ?? "?").toUpperCase(),
      stateColor:
        r.outcome === "failed"
          ? COLORS.fail
          : r.outcome === "needs_you"
            ? COLORS.accent
            : r.outcome === "working"
              ? COLORS.ink
              : COLORS.muted,
      legacy: r.legacy === true,
      startedAt: r.startedAt ?? null,
      completedAt: r.completedAt ?? null,
      externalSessionId: r.externalSessionId ?? null,
      attempts: r.attempts ?? 1,
      error: r.error ?? "",
      blockedOn: r.blockedOn ?? null
    };
  });
}

// --- rows ------------------------------------------------------------------

// One ledger row: everything the DOM layer needs, already decided.
export function projectRow(task, events, opts = {}) {
  const {
    now = Date.now(),
    open = false,
    selected = false,
    wide = true,
    mid = true,
    accent = COLORS.accent,
    base = "",
    providers = {},
    // "Which machine" — the same identity the chrome mark already shows
    // (os.hostname() locally, the paired Mac's agent name remotely). Passed
    // in rather than read here so this module stays DOM-free and testable.
    node = ""
  } = opts;

  const capabilities = providers[task.execution?.provider]?.capabilities ?? {};
  const level = fidelity(task.execution?.provider, providers);
  const coarse = level === "coarse";
  const providerDisplayName =
    providers[task.execution?.provider]?.displayName ?? task.execution?.provider ?? "";

  const { origin, lastAt, steps, activity, sessionId } = toSteps(task, events, { base });

  const halted = task.status === "needs_you";
  const running = task.status === "working";
  const failedStatus = task.status === "failed";
  const ready = task.status === "ready";
  const done = task.status === "done";
  const finished = ready || done || failedStatus;

  // A finished run's clock stops at its last event; a live one keeps running.
  const elapsed = (finished ? lastAt : now) - origin;
  // The TRACK measures execution, not attention. A task parked on you for an
  // hour has a long HALTED-AT clock, but the track ends at the last recorded
  // event unless the run is genuinely still moving.
  const traceEnd = (running ? now : lastAt) - origin;
  const elapsedSeconds = Math.max(0, traceEnd / 1000);

  const sec = sections(task, steps, capabilities, null);
  const allowedKeys = SECTION_KEYS_BY_STATUS[task.status] ?? [];
  const activitySection = allowedKeys.includes("activity") ? sec.activity : null;
  const filesSection = allowedKeys.includes("files") ? sec.files : null;
  const commandsSection = allowedKeys.includes("commands") ? sec.commands : null;
  const note = capabilityNote(task, capabilities);

  // §10 — one field, app.js reorders content by it.
  const layout = ready || failedStatus || done ? "answer-primary" : "trace-primary";

  let mainTrace = null;
  if (layout === "trace-primary") {
    const laid = trace(steps, {
      n: TAIL.expanded, w: 4, scale: 1, accent, coarse,
      live: running, halted, finished, elapsedSeconds
    });
    mainTrace = {
      cells: laid.cells,
      doneW: laid.doneW,
      totalW: laid.totalW,
      truncated: laid.truncated,
      total: laid.total,
      brackets: brackets(laid.units, capabilities, laid.cells)
    };
  }

  let provenance = null;
  if (ready || failedStatus) {
    const laid = trace(steps, {
      n: TAIL.provenance, w: 3, scale: 0.55, accent, coarse,
      live: false, halted: false, finished: true, elapsedSeconds
    });
    provenance = {
      cells: laid.cells,
      doneW: laid.doneW,
      totalW: laid.totalW,
      truncated: laid.truncated,
      total: laid.total,
      brackets: brackets(laid.units, capabilities, laid.cells),
      heading: failedStatus ? "BEFORE THE STOP" : "PROVENANCE"
    };
  }

  // A closed task carries no trace at all — the ledger compresses it out of
  // the way and the EXECUTION column belongs to work that is still live.
  const mini = done
    ? { cells: [], doneW: "0px", totalW: "0px" }
    : (() => {
        const laid = trace(steps, {
          n: TAIL.collapsed, w: 2, scale: 0.5, accent, coarse,
          live: running, halted, finished, elapsedSeconds
        });
        return { cells: laid.cells, doneW: laid.doneW, totalW: laid.totalW };
      })();

  const lastActivity = steps.filter(s => s.kind === "tool" || s.kind === "command").slice(-1)[0];
  // A long intent is a paragraph, not a heading: keep the expanded title at
  // the narrow-width size so it stays proportionate at any width. Collapsed
  // rows are unaffected — the intent is summarized there by design.
  const longTitle = open && task.title.length > LONG_TITLE_CHARS;

  // The user's own words. A task created before `brief` existed has only a
  // title (which WAS the full text then) — falling back to it is correct for
  // those tasks by construction, and makes `briefBody` empty for them, so
  // nothing is rendered twice.
  const brief = task.brief ?? task.title ?? "";
  // What a detail view renders UNDER the heading: the brief minus the
  // sentence the heading already is, or "" when the heading said all of it.
  // Delegated to the SAME module core used to name the task — never a
  // `brief !== title` comparison, which would call a title incomplete merely
  // because the brief opened with "# " or wrapped across two lines, and
  // would then render a "body" repeating the heading verbatim.
  const body = briefBody(brief);

  const stateLabel = STATE_LABELS[task.status] ?? String(task.status).toUpperCase();
  const stateColor = halted ? accent : failedStatus ? COLORS.fail : done ? COLORS.muted : COLORS.ink;

  // §01: a provider-not-authenticated stop is not a task breakage — 0x2F
  // shows what it knows (which provider, where to fix it, what survives)
  // instead of the vendor's error string standing in as the whole story.
  // Only "auth" changes anything below; every other/absent kind renders
  // exactly as before.
  const failureKind = failedStatus ? inferFailureKind(task) : null;
  const failureRemedy = failedStatus ? task.failure?.remedy ?? null : null;
  const failureCopy =
    failedStatus && failureKind === "auth"
      ? authFailureCopy(providerDisplayName, node, failureRemedy)
      : null;
  const failureLine =
    failedStatus && failureKind === "auth" ? authFailureLine(providerDisplayName, node) : null;

  let phaseLabel = "";
  let arg = "";
  if (halted) {
    phaseLabel = "HALTED AT";
    arg = relativePath(base, task.blockedOn?.file) || task.blockedOn?.text || "waiting on you";
  } else if (ready) {
    phaseLabel = "COMPLETE";
    arg = filesSection
      ? filesSection.paths.length + (filesSection.paths.length === 1 ? " file changed" : " files changed")
      : "";
  } else if (done) {
    phaseLabel = "CLOSED";
    arg = task.error ?? "";
  } else if (failedStatus) {
    phaseLabel = failureLine ? "STOPPED AT" : "FAILED AT";
    arg = failureLine || task.error || "Execution failed";
  } else {
    // No phase to report — the current activity line (or the last observed
    // step) is the honest thing to show here, never an inferred stage.
    phaseLabel = "";
    arg = activity || (lastActivity ? lastActivity.verb.toLowerCase() + "  " + lastActivity.arg : "starting execution");
  }

  let sub;
  // A closed row's sub is the EXECUTION column's text: the status plus the
  // run's duration. The duration is right-aligned into a fixed field (the
  // widest format, h:mm:ss), so "closed" and the end of the digits sit on
  // the same vertical axis whatever the run lasted — the row reads as a
  // ledger column instead of drifting with the width of the duration. The
  // padding must be non-breaking: CSS collapses plain spaces (white-space:
  // nowrap still collapses), which would silently undo the fixed width.
  if (done) sub = "closed · " + fmtDuration(elapsed / 1000).padStart(7, " ");
  else if (failedStatus) sub = failureLine || task.error || "failed";
  else if (ready) {
    sub = filesSection
      ? filesSection.paths.length + (filesSection.paths.length === 1 ? " file" : " files") + " · ready for you"
      : "ready for you";
  }
  else if (halted) sub = blockedTitle(task.blockedOn).toLowerCase();
  else sub = activity || (lastActivity ? lastActivity.verb.toLowerCase() + "  " + lastActivity.arg : "starting");

  return {
    id: task.id,
    num: "/" + two(task.id),
    title: task.title,
    // The full brief, and the body a detail view renders under the heading:
    // "" whenever the title already says everything the brief says, so a
    // one-line task looks exactly as it did before briefs existed.
    brief,
    briefBody: body,
    briefTruncated: task.briefTruncated === true,
    status: task.status,
    open,
    compact: !open,
    selected,
    halted,
    running,
    ready,
    failed: failedStatus,
    done,
    stateLabel,
    stateColor,
    titleSize: open
      ? longTitle
        ? halted ? "26px" : "24px"
        : mid ? (halted ? "34px" : "31px") : (halted ? "26px" : "24px")
      : done ? "15px" : "17.5px",
    titleWeight: done ? 400 : 500,
    titleColor: done ? COLORS.muted : COLORS.ink,
    subColor: done ? COLORS.muted : COLORS.inkSoft,
    numColor: done ? COLORS.muted : halted ? accent : COLORS.inkSoft,
    bg: halted ? "#e9eefb" : selected && !open ? "#eef2f6" : "#f6f8fa",
    borderT: halted ? "1px solid " + accent : "none",
    borderB: halted ? "1px solid " + accent : "1px solid " + COLORS.rule,
    gutterRule: halted ? "rgba(47,95,168,.32)" : COLORS.rule,
    gutterPad: open ? "30px 12px 0" : done ? "12px" : "17px 12px",
    pad: open
      ? wide ? "28px 32px 34px 22px" : "24px 20px 28px 18px"
      : done ? "10px 24px 10px 20px" : "15px 24px 15px 20px",
    sub,
    mini: mini.cells,
    miniDoneW: mini.doneW,
    miniTotalW: mini.totalW,
    layout,
    tailBudget: layout === "trace-primary" ? TAIL.expanded : TAIL.provenance,
    trace: mainTrace,
    provenance,
    coarse,
    fidelity: level,
    activitySection,
    filesSection,
    commandsSection,
    // Kept flat for the DOM layer's existing consumers (the FILES list, the
    // per-run panel): the same paths `filesSection` carries when it exists.
    files: filesSection ? filesSection.paths : [],
    note,
    capabilityDrift: sec.capabilityDrift,
    phaseLabel,
    arg,
    elapsed: fmtDuration(elapsed / 1000),
    // Secondary metadata: which harness, on which machine, and (when
    // reliably known) which model. Never the primary model — a Task is the
    // product object, execution is under it.
    node: [task.execution?.node, task.execution?.provider, task.execution?.model]
      .filter(Boolean)
      .join(" / "),
    sessionId,
    // What kind of halt this is: a permission (ALLOW/REJECT) or a decision
    // (ANSWER). The interaction surface must keep them separate — a decision
    // is answered, never allowed/rejected.
    permType: task.blockedOn?.type ?? null,
    providerId: task.execution?.provider ?? null,
    permTitle: blockedTitle(task.blockedOn),
    permPath: relativePath(base, task.blockedOn?.file) || task.blockedOn?.tool || "",
    permWhy:
      task.blockedOn?.plannedChange ||
      task.blockedOn?.text ||
      task.blockedOn?.description ||
      "",
    // §03: a decision question is prose, not a label. The heading is its
    // first sentence (rendered plain, at heading size); the body is
    // everything after it, rendered through the shared rich-text subset —
    // never truncated, never break-all (see app.css). A one-line question
    // has an empty body: callers render heading-only.
    permQuestionHeading:
      task.blockedOn?.type === "decision" ? firstSentence(task.blockedOn?.text) : "",
    permQuestionBody:
      task.blockedOn?.type === "decision" ? restAfterFirstSentence(task.blockedOn?.text) : "",
    permDetail: task.blockedOn?.raw ? JSON.stringify(task.blockedOn.raw, null, 2) : "",
    // Interactive ACP permission: which actions can be offered without
    // guessing, and the actual options the agent supplied.
    permLive: task.blockedOn?.live === true,
    permAllowable: task.blockedOn?.canAllow !== false,
    permRejectable: task.blockedOn?.canReject !== false,
    permOptions: task.blockedOn?.options ?? [],
    // The AUTO routing decision of the current run — read from the persisted
    // record, so "why did 0x2F run this here?" never depends on live config.
    routed:
      task.runs?.at(-1)?.routing?.mode === "auto"
        ? {
            provider: task.runs.at(-1).provider,
            reason: task.runs.at(-1).routing.reason
          }
        : null,
    error: task.error ?? "",
    // §01: null unless this is a classified provider-not-authenticated stop
    // — every other failure renders exactly as it did before this field
    // existed. `failureProviderName` is the raw display name (for the
    // "<PROVIDER> SAID" label); `failureCopy` is the composed band copy.
    failureKind,
    failureRemedy,
    failureProviderName: failureKind ? providerDisplayName : null,
    failureCopy
  };
}

// The whole ledger: ordered rows plus the chrome counters.
export function projectLedger(tasks, eventsByTask = {}, opts = {}) {
  const ordered = sortTasks(tasks);
  const openId = opts.openId ?? null;
  const selectedId = opts.selectedId ?? null;

  const rows = ordered.map(task =>
    projectRow(task, eventsByTask[task.id] ?? [], {
      ...opts,
      // A halted task opens itself: it is the thing that needs you.
      open: task.status === "needs_you" || task.id === openId,
      selected: task.id === selectedId
    })
  );

  const c = counts(tasks);
  return {
    rows,
    counts: c,
    countNeeds: two(c.needs_you),
    countWorking: two(c.working),
    countReady: two(c.ready)
  };
}
