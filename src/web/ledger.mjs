// Ledger projection — normalized Work events -> the Web ledger view model.
//
// This module is PURE presentation, the Web client's counterpart to
// render.mjs (which does the same job for the terminal). It decides how a
// task *reads*; it never decides what a status MEANS. Lifecycle stays in
// core/lifecycle.mjs, business rules stay in core/actions.mjs.
//
// It is deliberately dependency-free and DOM-free so that it can be
//   - imported by Node tests, and
//   - served verbatim to the browser as an ES module (src/web/app.js).
// One implementation, two runtimes, no build step.
//
// Provider neutrality: the only inputs are normalized Work events
// (core/events.mjs) and the normalized task shape. Tool *names* inside
// `tool.started` are provider vocabulary, so they are treated as opaque
// labels and classified by generic, cross-harness word stems with a safe
// fallback — nothing here assumes Claude Code, Codex, or any other harness.

// The three phases the ledger groups execution into. This is a reading
// device (a run has an investigation, a change, and a verification part),
// not a lifecycle state: Work Core has no notion of phases.
export const PHASES = ["inspect", "act", "verify"];

// Above this length an intent is a paragraph, not a title: the expanded
// heading drops to the narrow-width size so a long engineering prompt reads
// as a heading, not a wall of type. A rendering read, never a data rule.
export const LONG_TITLE_CHARS = 90;

export const PHASE_LABELS = {
  inspect: "INVESTIGATION",
  act: "CHANGE",
  verify: "VERIFICATION"
};

export const PHASE_TRACK_LABELS = {
  inspect: "INSPECT",
  act: "ACT",
  verify: "VERIFY"
};

const PHASE_PENDING = {
  inspect: "not started",
  act: "awaiting investigation",
  verify: "awaiting change"
};

// Generic verb stems shared by coding harnesses. Unknown names never break
// the projection — they inherit the phase already in progress.
const INSPECT_STEM = /^(read|search|grep|glob|find|list|ls|cat|view|open|fetch|browse|web|lookup|inspect|plan|think|todo)/;
const ACT_STEM = /^(edit|write|patch|apply|create|update|delete|remove|move|rename|mkdir|multiedit|notebook)/;
const VERIFY_STEM = /(test|spec|lint|typecheck|tsc|build|check|verify|coverage|bench)/;

export const COLORS = {
  ink: "#2f2f2f",
  inkSoft: "#37424c",
  muted: "#5c6771",
  rule: "#dbe2e7",
  accent: "#2f5fa8",
  fail: "#b8532a",
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

// --- step extraction -------------------------------------------------------

// A short, single-line rendering of long text (an answer, a question).
function snippet(value, max = 140) {
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// The argument a step operated on, in provider-neutral terms: whatever the
// tool input names as its target. Falls back to nothing rather than guessing.
export function stepArgument(input = {}) {  const candidates = [
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

export function classifyPhase(name, argument, current = "inspect") {
  const n = String(name ?? "").toLowerCase();
  const a = String(argument ?? "").toLowerCase();
  if (VERIFY_STEM.test(n)) return "verify";
  // A shell-ish step is classified by what it runs, not by the tool's name.
  if (a && VERIFY_STEM.test(a) && !ACT_STEM.test(n)) return "verify";
  if (ACT_STEM.test(n)) return "act";
  if (INSPECT_STEM.test(n)) return "inspect";
  return PHASES.includes(current) ? current : "inspect";
}

// Turn one task's event log into the ordered steps the ledger draws.
// Only events that represent a unit of work become steps; `progress` is
// narration and is surfaced separately as the current activity line.
export function toSteps(task, events = [], opts = {}) {
  const base = opts.base ?? "";
  const origin = ms(events.find(e => e.at)?.at) ?? ms(task.createdAt) ?? Date.now();
  const steps = [];
  const files = [];
  let phase = "inspect";
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
        const raw = stepArgument(event.input ?? {});
        // Paths read as project paths, not as this machine's filesystem.
        const argument = relativePath(base, raw);
        phase = classifyPhase(event.name, raw, phase);
        steps.push({
          kind: "tool",
          verb: String(event.name ?? "step").toUpperCase(),
          arg: argument,
          phase,
          at,
          t,
          human: false
        });
        activity = "";
        break;
      }

      case "file.changed": {
        const changed = relativePath(base, event.path);
        if (changed && !files.includes(changed)) files.push(changed);
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
          phase,
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
          phase,
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
            phase,
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
          phase,
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
          phase,
          at,
          t,
          human: false
        });
        break;

      default:
        break;
    }
  }

  return { origin, lastAt, steps, files, activity, sessionId };
}

// --- travel rule -----------------------------------------------------------
//
// One punched cell per unit of work, grouped by phase. Struck cells are
// executed; the luminous cap is the point of execution; an interruption
// tears the track open; artifacts (files the run changed) leave ticks
// beneath the axis.
//
// The design draws scheduled work as faint cells ahead of the head. Work has
// no plan of remaining steps and will not invent one, so a real track ends
// at the head: what happened, and where execution currently stands.

function cellHeight(phase, index, scale) {
  const base = { inspect: 6, act: 16, verify: 11 }[phase] ?? 8;
  const wobble = ((index * 37) % 5) - 2;
  return Math.max(3, Math.round((base + wobble * 0.9) * scale));
}

export function trace(steps, opts = {}) {
  const {
    budget = 66,
    w = 4,
    scale = 1,
    marks = true,
    accent = COLORS.accent,
    live = false,
    halted = false,
    finished = false
  } = opts;

  const units = steps.filter(s => s.kind === "tool" || s.kind === "human");
  const groups = [];
  const cellGap = marks ? 2 : 1;
  const groupGap = marks ? 14 : 5;

  // One punched cell per unit of WORK, and the unit is time — a step that
  // held the run for 40s is a longer strike than one that took 2s. Both the
  // step order and the gaps between step timestamps are real, so this is an
  // encoding of recorded data, not a filler that pads the track to width.
  //
  // Long runs are strided down first so the track stays one line wide; each
  // surviving step then keeps at least two cells so it stays legible.
  const stride = units.length > budget / 2 ? Math.ceil(units.length / (budget / 2)) : 1;
  const shown = units.filter((_, i) => i % stride === 0);

  const endT = opts.endT ?? (units.length ? units[units.length - 1].t : 0);
  const spanOf = i => {
    const next = i + 1 < shown.length ? shown[i + 1].t : endT;
    return Math.max(0.25, next - shown[i].t);
  };
  const totalSpan = shown.reduce((sum, _, i) => sum + spanOf(i), 0) || 1;
  const cellsFor = i => Math.max(2, Math.round((spanOf(i) / totalSpan) * budget));

  let index = 0;
  let stepIndex = -1;
  for (const step of shown) {
    stepIndex++;
    const last = groups[groups.length - 1];
    const group =
      last && last.phase === step.phase
        ? last
        : (groups.push({
            phase: step.phase,
            label: PHASE_TRACK_LABELS[step.phase] ?? step.phase.toUpperCase(),
            cells: [],
            done: true,
            active: false
          }),
          groups[groups.length - 1]);

    const per = cellsFor(stepIndex);
    for (let k = 0; k < per; k++) {
      group.cells.push({
        w: w + "px",
        h: cellHeight(step.phase, index, scale) + "px",
        c: finished ? COLORS.trackPast : COLORS.trackLive,
        past: true,
        artifact: null
      });
      index++;
    }
  }

  // The point of execution: a luminous cap while the run is moving, a tear
  // in the track while it is halted on the human.
  if (halted || live) {
    const phase = shown.length ? shown[shown.length - 1].phase : "inspect";
    const last = groups[groups.length - 1];
    const group =
      last && last.phase === phase
        ? last
        : (groups.push({
            phase,
            label: PHASE_TRACK_LABELS[phase] ?? phase.toUpperCase(),
            cells: [],
            done: shown.length > 0,
            active: false
          }),
          groups[groups.length - 1]);
    group.active = true;

    if (halted) {
      if (marks) {
        group.cells.push({ w: "8px", h: "0px", c: "transparent" });
        group.cells.push({ w: "2px", h: "0px", c: "transparent", isHalt: true });
        group.cells.push({ w: "8px", h: "0px", c: "transparent" });
      } else {
        group.cells.push({ w: w + "px", h: Math.round(22 * scale) + "px", c: accent });
      }
    } else {
      group.cells.push({
        w: w + "px",
        h: Math.round(28 * scale) + "px",
        c: accent,
        isHead: marks
      });
    }
  }

  // Geometry: run the layout once so the axis wash, the artifact ticks and
  // the phase labels all agree on the same x-scale.
  let x = 0;
  let doneW = 0;
  const markList = [];
  groups.forEach((group, gi) => {
    if (gi > 0) x += groupGap;
    let gw = 0;
    group.cells.forEach((cell, ci) => {
      if (ci > 0) {
        x += cellGap;
        gw += cellGap;
      }
      if (cell.artifact) markList.push({ x: Math.round(x) + "px", c: cell.artifact });
      const width = parseFloat(cell.w);
      x += width;
      gw += width;
      if (cell.past) doneW = x;
    });
    group.w = Math.round(gw) + "px";
    group.lc = group.active
      ? halted
        ? accent
        : COLORS.ink
      : group.done
        ? COLORS.inkSoft
        : COLORS.muted;
  });

  return {
    groups,
    marks: markList,
    doneW: Math.round(doneW) + "px",
    totalW: Math.round(x) + "px"
  };
}

// Artifact ticks: one per file the run actually changed, placed under the
// cell where the change happened. Computed against a laid-out trace so the
// positions line up with the drawn track.
export function artifactMarks(steps, laid, changedFiles, accent = COLORS.accent) {
  if (!changedFiles.length) return [];
  const units = steps.filter(s => s.kind === "tool" || s.kind === "human");
  if (!units.length) return [];
  const total = parseFloat(laid.totalW) || 0;
  const marks = [];
  units.forEach((step, i) => {
    if (!changedFiles.includes(step.arg)) return;
    const x = Math.round(((i + 0.5) / units.length) * total);
    marks.push({ x: x + "px", c: accent });
  });
  return marks;
}

// --- bands -----------------------------------------------------------------

export function bands(task, steps, accent = COLORS.accent) {
  const currentPhase = steps.length ? steps[steps.length - 1].phase : "inspect";
  const halted = task.status === "needs_you";
  const running = task.status === "working";
  // A terminal failure (or a task closed from one) means downstream phases
  // can never execute — they are NOT REACHED, not still waiting. This is
  // read from existing lifecycle state, never a new lifecycle state.
  const terminal =
    task.status === "failed" || (task.status === "done" && !!task.error);

  return PHASES.map(key => {
    const items = steps.filter(s => s.phase === key && s.kind !== "halt");
    const here = currentPhase === key && (halted || running);
    const active = here && running;
    const blocked = here && halted;
    const span = items.length
      ? fmtDuration(items[items.length - 1].t - items[0].t)
      : "—";
    const status = blocked
      ? "waiting on you"
      : active
        ? "running"
        : terminal
          ? "not reached"
          : PHASE_PENDING[key];

    return {
      key,
      label: PHASE_LABELS[key],
      labelColor: items.length || here ? COLORS.ink : COLORS.muted,
      labelWeight: here ? 600 : 500,
      rule: blocked
        ? "2px solid " + accent
        : active
          ? "2px solid " + COLORS.ink
          : "1px solid " + COLORS.rule,
      meta: items.length
        ? items.length + (items.length === 1 ? " step · " : " steps · ") + span
        : status,
      pending: items.length === 0,
      pendingText: status,
      pendingColor: here ? COLORS.ink : COLORS.muted,
      items: items.map(step => ({
        verb: step.verb,
        arg: step.arg,
        t: fmtDuration(step.t),
        human: step.human,
        vc: step.human ? accent : step.kind === "fail" ? COLORS.fail : COLORS.inkSoft,
        ac: step.human ? accent : step.kind === "fail" ? COLORS.fail : COLORS.ink
      }))
    };
  });
}

// --- rows ------------------------------------------------------------------

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

// One ledger row: everything the DOM layer needs, already decided.
export function projectRow(task, events, opts = {}) {
  const {
    now = Date.now(),
    open = false,
    selected = false,
    wide = true,
    mid = true,
    accent = COLORS.accent,
    base = ""
  } = opts;

  const { origin, lastAt, steps, files, activity, sessionId } = toSteps(task, events, { base });

  const halted = task.status === "needs_you";
  const running = task.status === "working";
  const failed = task.status === "failed";
  const ready = task.status === "ready";
  const done = task.status === "done";
  const finished = ready || done || failed;

  // A finished run's clock stops at its last event; a live one keeps running.
  const elapsed = (finished ? lastAt : now) - origin;

  // The TRACK measures execution, not attention. A task parked on you for an
  // hour has a long HALTED-AT clock, but the step it stopped mid-way through
  // did not take an hour — so the track ends at the last recorded event
  // unless the run is genuinely still moving.
  const traceEnd = (running ? now : lastAt) - origin;

  const full = trace(steps, {
    // Where the run currently stands, so the step in flight is measured
    // against now instead of collapsing to a minimum-width strike.
    endT: traceEnd / 1000,
    budget: mid ? 66 : 44,
    w: 4,
    scale: 1,
    marks: true,
    accent,
    live: running,
    halted,
    finished
  });
  full.marks = artifactMarks(steps, full, files, accent);

  const mini = done
    ? { groups: [] }
    : trace(steps, {
        endT: traceEnd / 1000,
        budget: 40,
        w: 2,
        scale: 0.5,
        marks: false,
        accent,
        live: running,
        halted,
        finished
      });

  const last = steps.filter(s => s.kind === "tool").slice(-1)[0];
  const currentPhase = steps.length ? steps[steps.length - 1].phase : "inspect";
  // A long intent is a paragraph, not a heading: keep the expanded title at
  // the narrow-width size so it stays proportionate at any width. Collapsed
  // rows are unaffected — the intent is summarized there by design.
  const longTitle = open && task.title.length > LONG_TITLE_CHARS;

  const stateLabel = STATE_LABELS[task.status] ?? String(task.status).toUpperCase();
  const stateColor = halted ? accent : failed ? COLORS.fail : done ? COLORS.muted : COLORS.ink;

  let phaseLabel = "";
  let arg = "";
  if (halted) {
    phaseLabel = "HALTED AT";
    arg = relativePath(base, task.blockedOn?.file) || task.blockedOn?.text || "waiting on you";
  } else if (ready) {
    phaseLabel = "COMPLETE";
    arg = files.length
      ? files.length + (files.length === 1 ? " file changed" : " files changed")
      : "no files changed";
  } else if (done) {
    phaseLabel = "CLOSED";
    arg = files.length
      ? files.length + (files.length === 1 ? " file changed" : " files changed")
      : "closed";
  } else if (failed) {
    phaseLabel = "FAILED AT";
    arg = task.error ?? "Execution failed";
  } else {
    phaseLabel = (PHASE_TRACK_LABELS[currentPhase] ?? "").toUpperCase();
    arg = activity || (last ? last.verb.toLowerCase() + "  " + last.arg : "starting execution");
  }

  let sub;
  if (done) sub = "closed · " + fmtDuration(elapsed / 1000);
  else if (failed) sub = task.error ?? "failed";
  else if (ready) sub = files.length ? files.length + " files · ready for you" : "ready for you";
  else if (halted) sub = blockedTitle(task.blockedOn).toLowerCase();
  else sub = activity || (last ? last.verb.toLowerCase() + "  " + last.arg : "starting");

  return {
    id: task.id,
    num: "/" + two(task.id),
    title: task.title,
    status: task.status,
    open,
    compact: !open,
    selected,
    halted,
    running,
    ready,
    failed,
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
    mini: mini.groups,
    groups: full.groups,
    marks: full.marks,
    doneW: full.doneW,
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
    bands: bands(task, steps, accent),
    files,
    error: task.error ?? ""
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
