// 0x2F Web — the browser client.
//
// This file renders and invokes. It owns NO lifecycle, NO provider logic and
// NO task store: every piece of state on screen comes from the local HTTP API
// (`/api/tasks`, `/api/tasks/:id`, `/api/events/history`) and every change is
// an action call (`/allow`, `/reject`, `/close`, `POST /api/tasks`). Live
// updates arrive as normalized Work events over SSE — the same events the CLI
// writes, so a `2f allow` in a terminal moves this ledger too.
//
// Presentation decisions live in ledger.mjs, which is shared with the Node
// tests; this file is the DOM layer and the transport.

import {
  COLORS,
  projectLedger,
  projectRuns,
  eventsForRun,
  toSteps,
  fmtDuration,
  two,
  parseInline,
  parseRich
} from "/app/ledger.mjs";
import { createSoundPolicy } from "/app/sound-policy.mjs";
import { createSlashPlayer } from "/app/sound.mjs";

const EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.closed",
  "task.answered",
  "run.started",
  "progress",
  "tool.started",
  "file.changed",
  "needs_user",
  "permission.resolved",
  "run.completed",
  "run.failed"
];

// Events that change what a task IS (not just what it is doing) — those
// require re-reading state from the API rather than patching locally. The
// client never derives status from an event; Work Core owns that.
const STATE_EVENTS = new Set([
  "task.created",
  "task.updated",
  "task.closed",
  "needs_user",
  "permission.resolved",
  "run.completed",
  "run.failed"
]);

const MAX_EVENTS_PER_TASK = 2000;

// --- attention settings -----------------------------------------------------
// Two settings, that is all: SOUND on/off, and browser notifications for
// NEEDS YOU. Notifications are opt-in by default and browser permission is
// requested only by a click on the NOTIFY control — never on page load.
const SOUND_KEY = "0x2f.sound";
const NOTIFY_KEY = "0x2f.notify";

function storedFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function persistFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* storage unavailable — the setting still applies for this session */
  }
}

const state = {
  tasks: [],
  eventsByTask: new Map(),
  seen: new Map(),
  openId: null,
  selectedId: null,
  inspectId: null,
  // Run history selection: up to two runs of one task, inspected side by
  // side. [{ taskId, run }] — one selected shows that run's facts, two show
  // the comparison. This is inspection, never evaluation.
  runSelection: [],
  runDetails: new Map(), // `${taskId}:${run}` -> { ...runRecord, result }
  providers: [], // [{ id, displayName }] — for display names on run rows
  connected: false,
  width: window.innerWidth,
  base: "",
  // Remote mode (the client is served by the 0x2F Relay): `macOnline` tracks
  // whether the Mac itself is reachable — distinct from `connected`, which
  // only says the SSE stream to whatever server served this page is alive.
  remote: false,
  macOnline: true,
  flash: null,
  soundOn: storedFlag(SOUND_KEY, true),
  notifyOn: storedFlag(NOTIFY_KEY, false),
  pulse: null, // { type: "ready"|"needs_you", at } — the slash's visual trace
  // Half-typed decision answers per task, kept across re-renders (any event
  // re-renders the ledger; a re-render must never drop a half-typed answer).
  answers: new Map()
};

// --- tiny DOM helper -------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  if (Array.isArray(attrs)) throw new TypeError("el(): pass attributes before children");
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) node.style.setProperty(camelToKebab(prop), String(v));
      }
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
}

// --- rich prose (DOM side of the shared Markdown subset) -------------------
//
// ledger.mjs parses provider prose into a pure token/block AST; these two
// builders turn that AST into DOM. Every leaf is created with textContent
// (the `el` helper), so the subset can never carry arbitrary HTML — a token
// is text, code or bold, nothing else.

function inlineEls(tokens) {
  return tokens.map(token => {
    if (token.code !== undefined) {
      return el("code", { class: "rich-code", text: token.code });
    }
    if (token.bold !== undefined) {
      return el("strong", { class: "rich-bold" }, inlineEls(token.bold));
    }
    return el("span", { text: token.text });
  });
}

function richBlock(block) {
  if (block.type === "heading") {
    return el("div", { class: "rich-h" + block.level }, inlineEls(block.inline));
  }
  if (block.type === "list") {
    return el(
      "div",
      { class: "rich-list" },
      block.items.map((item, index) =>
        el("div", { class: "rich-li" }, [
          el("span", {
            class: "rich-li-mark",
            text: block.ordered ? index + 1 + "." : "–"
          }),
          el("span", { class: "rich-li-body" }, inlineEls(item))
        ])
      )
    );
  }
  if (block.type === "code") {
    return el("pre", { class: "rich-pre" }, [el("code", { text: block.text })]);
  }
  return el("div", { class: "rich-p" }, inlineEls(block.inline));
}

function richBody(text) {
  return el("div", { class: "rich" }, parseRich(text).map(richBlock));
}

// --- transport -------------------------------------------------------------

async function api(path, options) {
  const opts = { ...options };
  // Every mutating request carries a unique idempotency key. The relay
  // forwards it as the command requestId and the Mac never executes the same
  // key twice — so a double tap, a network retry, or a reconnect can never
  // run ACCEPT / ANSWER / SEND BACK twice.
  if ((opts.method ?? "GET") === "POST") {
    opts.headers = { ...(opts.headers ?? {}), "x-0x2f-request-id": requestId() };
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let message = "HTTP " + res.status;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

function requestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return "rid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
}

// Remote mode: the client is served by the relay, which exposes the Mac's
// presence through /api/status. While the Mac is offline, mutating controls
// are unavailable — explicit failure beats "taps SEND BACK now, it executes
// 15 minutes later".
async function checkStatus() {
  let info = null;
  try {
    const res = await fetch("/api/status");
    if (res.status === 401) {
      location.href = "/"; // session lost — the relay serves the pairing page
      return;
    }
    if (res.ok) info = await res.json();
  } catch {
    info = null; // server unreachable — treat as offline if we were remote
  }
  const remote = info?.mode === "relay";
  const macOnline = remote ? info?.mac === "online" : true;
  // Remembers the moment the Mac went unreachable, purely for the mobile
  // Attention Stack's "LAST KNOWN ..." labelling — it freezes elapsed clocks
  // against this timestamp instead of the live one (see renderMobile).
  if (remote && state.macOnline && !macOnline) mobile.offlineSince = Date.now();
  if (macOnline) mobile.offlineSince = null;
  if (remote !== state.remote || macOnline !== state.macOnline) {
    state.remote = remote;
    state.macOnline = macOnline;
    render();
  } else {
    state.remote = remote;
    state.macOnline = macOnline;
  }
}

function remoteBlocked() {
  if (state.remote && !state.macOnline) {
    flash("MAC OFFLINE — actions are unavailable until the Mac reconnects.");
    return true;
  }
  return false;
}

function post(path) {
  return api(path, { method: "POST" });
}

// --- the slash: sound, visual, notification ---------------------------------
//
// Events are many, interruptions are few. The sound policy watches the live
// event stream, dedupes each real transition, and emits at most ONE intent
// per batching window (needs_you outranks ready). This handler turns that
// intent into the same event expressed through three media: the slash sound,
// a brief pulse of the "/" mark, and — for NEEDS YOU, tab hidden, opted in —
// one restrained browser notification.

const slash = createSlashPlayer();
const policy = createSoundPolicy({ onIntent: handleIntent });

function handleIntent(intent) {
  if (intent.type === "needs_you") {
    if (state.soundOn) slash.needsYou();
    pulse("needs_you");
    if (state.notifyOn && document.hidden) notifyNeedsYou(intent);
  } else {
    if (state.soundOn) slash.ready();
    pulse("ready");
  }
}

// The "/" in the chrome is the sonic gesture's visual trace: one quick fade
// for READY, a split fade for NEEDS YOU. Rendered state, so a re-render (a
// late progress event, the clock) never restarts the pulse mid-flight.
const PULSE_MS = { ready: 300, needs_you: 500 };

function pulse(type) {
  state.pulse = { type, at: Date.now() };
  render();
}

// One notification identity, one tag — a burst of halted tasks collapses
// into a single entry. The task is the object; the reason is normalized Work
// vocabulary; provider names never appear.
function notifyNeedsYou(intent) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const task = state.tasks.find(t => t.id === intent.taskId);
  const reason =
    task?.blockedOn?.type === "permission"
      ? "Permission required"
      : task?.blockedOn?.type === "decision"
        ? "Decision needed"
        : "Needs you";
  try {
    const notification = new Notification("0x2F / needs you", {
      body: task ? `${task.title} — ${reason}` : reason,
      tag: "0x2f-needs-you"
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    /* notification could not be shown — the ledger row still says it */
  }
}

function toggleSound() {
  state.soundOn = !state.soundOn;
  persistFlag(SOUND_KEY, state.soundOn);
  slash.unlock(); // a click is a user gesture — prime audio while we are here
  render();
}

// The only control that may ask for browser notification permission: a click
// on NOTIFY. After denial the control stays disabled — no re-prompting.
async function toggleNotify() {
  if (!("Notification" in window) || Notification.permission === "denied") return;
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return; // request rejected by the browser — stay off
    }
  }
  if (permission === "granted") {
    state.notifyOn = !state.notifyOn;
    persistFlag(NOTIFY_KEY, state.notifyOn);
    render();
  }
}

function renderNotifyControl() {
  if (!("Notification" in window)) {
    return el("button", {
      class: "setting disabled",
      disabled: true,
      text: "NOTIFY —",
      title: "browser notifications are not supported here"
    });
  }
  if (Notification.permission === "denied") {
    return el("button", {
      class: "setting disabled",
      disabled: true,
      text: "NOTIFY BLOCKED",
      title: "notifications are blocked in this browser"
    });
  }
  return el("button", {
    class: "setting",
    onClick: toggleNotify,
    text: state.notifyOn ? "NOTIFY ON" : "NOTIFY",
    title: state.notifyOn
      ? "browser notifications for NEEDS YOU: on"
      : "notify me when 0x2F needs you (requests browser permission)"
  });
}

function recordEvent(event) {
  const id = event.taskId;
  if (id === undefined || id === null) return false;
  const key = JSON.stringify(event);
  let seen = state.seen.get(id);
  if (!seen) {
    seen = new Set();
    state.seen.set(id, seen);
  }
  if (seen.has(key)) return false;
  seen.add(key);
  const list = state.eventsByTask.get(id) ?? [];
  list.push(event);
  if (list.length > MAX_EVENTS_PER_TASK) list.splice(0, list.length - MAX_EVENTS_PER_TASK);
  state.eventsByTask.set(id, list);
  return true;
}

async function loadAll() {
  const [tasks, history] = await Promise.all([
    api("/api/tasks"),
    api("/api/events/history")
  ]);
  state.tasks = tasks;
  policy.seed(tasks); // baseline: what is already on screen never sounds
  state.base = history.base ?? "";
  state.eventsByTask = new Map();
  state.seen = new Map();
  for (const [id, events] of Object.entries(history.events ?? {})) {
    for (const event of events) recordEvent({ ...event, taskId: Number(id) });
  }
  // Halted tasks open themselves; make sure the one on screen has its result.
  const halted = state.tasks.find(t => t.status === "needs_you");
  if (halted && state.selectedId === null) state.selectedId = halted.id;
  render();
  if (state.openId !== null) ensureDetail(state.openId);
}

async function reloadTasks() {
  state.tasks = await api("/api/tasks");
  policy.seed(state.tasks);
  render();
  // State changed — re-read any selected runs so their details (outcome,
  // result) track the task instead of going stale.
  for (const sel of state.runSelection) {
    ensureRunDetail(sel.taskId, sel.run, true);
  }
  // The mobile Task Detail screen keeps its own open-task id (state.openId
  // is desktop's inline-expand); refresh its cached detail the same way.
  if (mobile.screen === "detail" && mobile.detailId !== null) ensureDetail(mobile.detailId);
}

// --- actions ---------------------------------------------------------------

function flash(message) {
  state.flash = message;
  render();
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    state.flash = null;
    render();
  }, 4000);
}

async function act(fn) {
  try {
    await fn();
  } catch (error) {
    flash(error.message);
    return;
  }
  await reloadTasks();
}

const allow = id => {
  if (remoteBlocked()) return;
  act(() => post("/api/tasks/" + id + "/allow"));
};
const reject = id => {
  if (remoteBlocked()) return;
  act(() => post("/api/tasks/" + id + "/reject"));
};
const accept = id => {
  if (remoteBlocked()) return;
  act(async () => {
    await post("/api/tasks/" + id + "/close");
    if (state.openId === id) state.openId = null;
  });
};

// SEND BACK reruns the task through the shared rerun action: the next run's
// input is rebuilt from current Task state (answers, notes, prior results),
// so it is the "continue with my correction" gesture of the control loop.
const sendBack = id => {
  if (remoteBlocked()) return;
  act(() => post("/api/tasks/" + id + "/rerun"));
};

// CLOSE tells 0x2F this Work is no longer active — the same closeWork action
// the ACCEPT button uses. It never touches the provider: no resume, no new
// execution attempt, no permission interpretation. It is the escape hatch
// for work that cannot continue (a non-resumable provider, a wrong NEEDS
// YOU, a finished run the user no longer wants).
const close = id => accept(id);

// ANSWER responds to a needs_you/decision block. A decision is answered,
// never allowed/rejected; the answer is persisted with the task.
async function answerDecision(id) {
  if (remoteBlocked()) return;
  const answer = (state.answers.get(id) ?? "").trim();
  if (!answer) return;
  try {
    await api("/api/tasks/" + id + "/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer })
    });
  } catch (error) {
    flash(error.message);
    return;
  }
  state.answers.delete(id);
  await reloadTasks();
}

function toggleOpen(id) {
  state.openId = state.openId === id ? null : id;
  state.selectedId = id;
  render();
  if (state.openId !== null) ensureDetail(state.openId);
}

function toggleInspect(id) {
  state.inspectId = state.inspectId === id ? null : id;
  render();
}

// --- run history -----------------------------------------------------------

// Select/deselect one run of a task. Selection is per-task and holds at most
// two runs; a third click drops the oldest so the comparison stays legible.
function selectRun(taskId, run) {
  const index = state.runSelection.findIndex(
    s => s.taskId === taskId && s.run === run
  );
  if (index >= 0) {
    state.runSelection.splice(index, 1);
  } else {
    state.runSelection = state.runSelection.filter(s => s.taskId === taskId);
    state.runSelection.push({ taskId, run });
    if (state.runSelection.length > 2) state.runSelection.shift();
    ensureRunDetail(taskId, run);
  }
  render();
}

// A run's result lives per-run on disk; fetch it lazily when the run is
// selected, exactly like the task's own result is fetched for an open row.
// `force` re-reads a cached detail — used when state events may have changed
// it (a selected working run completing).
async function ensureRunDetail(taskId, run, force = false) {
  const key = taskId + ":" + run;
  if (!force && state.runDetails.has(key)) return;
  try {
    const detail = await api("/api/tasks/" + taskId + "/runs/" + run);
    state.runDetails.set(key, detail);
    render();
  } catch {
    /* the task may have been closed underneath us */
  }
}

function localTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })
    : "—";
}

function runFacts(run) {
  const facts = [
    ["node", run.node ?? "—"],
    ["model", run.model ?? "—"],
    ["started", localTime(run.startedAt)],
    ["completed", localTime(run.completedAt)],
    ["session", run.externalSessionId ?? "—"],
    ["attempts", String(run.attempts)]
  ];
  return facts.map(([k, v]) =>
    el("div", { class: "run-fact" }, [
      el("span", { class: "run-fact-k", text: k }),
      el("span", { class: "run-fact-v", text: v })
    ])
  );
}

function renderRunHead(run, accent) {
  return el("div", { class: "run-head" }, [
    el("span", { class: "run-head-num", style: { color: accent }, text: "RUN " + run.num }),
    el("span", { class: "run-head-provider", text: run.provider }),
    el("span", { class: "run-head-duration", text: run.duration ?? "—" }),
    el("span", { class: "run-head-state", style: { color: run.stateColor }, text: run.state })
  ]);
}

// The run's execution events. Structured steps when the provider recorded
// them (Claude Code); otherwise the run's real event types, quietly — a
// DeepSeek Harness run shows "started · completed", never invented steps.
function renderRunSteps(run, steps, runEvents) {
  if (steps.length) {
    return el("div", { class: "run-steps" }, [
      el("div", { class: "run-sub-k", text: "STEPS" }),
      ...steps.map(step =>
        el("div", { class: "run-step" }, [
          el("span", { class: "run-step-verb", text: step.verb }),
          el("span", { class: "run-step-arg", text: step.arg }),
          el("span", { class: "run-step-t", text: fmtDuration(step.t) })
        ])
      )
    ]);
  }
  const kinds = runEvents.map(e => e.type);
  if (!kinds.length) return null;
  const note =
    "no structured steps — " +
    kinds.map(k => k.replace("run.", "").replace("_", " ")).join(" · ");
  return el("div", { class: "run-steps" }, [
    el("div", { class: "run-sub-k", text: "EVENTS" }),
    el("div", { class: "run-step-quiet", style: { color: COLORS.muted }, text: note })
  ]);
}

// One run's factual detail: head, facts, events, changed files, result.
function renderRunPanel(taskId, run, events, accent) {
  const runEvents = eventsForRun(events, run.run);
  const detail = state.runDetails.get(taskId + ":" + run.run) ?? null;
  const steps = toSteps(
    {
      createdAt: run.startedAt ?? null,
      execution: { externalSessionId: run.externalSessionId ?? null }
    },
    runEvents,
    { base: state.base }
  );
  const files = steps.files;
  const result = (detail?.result && detail.result.trim()) || run.error || "";

  return el("div", { class: "run-panel", style: { borderLeftColor: accent } }, [
    renderRunHead(run, accent),
    el("div", { class: "run-facts" }, runFacts(run)),
    renderRunSteps(run, steps.steps, runEvents),
    files.length
      ? el("div", { class: "run-files" }, [
          el("div", { class: "run-sub-k", text: "FILES" }),
          ...files.map(f => el("div", { class: "run-file", text: f }))
        ])
      : null,
    result
      ? el("div", { class: "run-result" }, [
          el("div", { class: "run-sub-k", text: "RESULT" }),
          el("div", { class: "run-result-body" }, [richBody(result)])
        ])
      : el("div", { class: "band-pending", style: { color: COLORS.muted }, text: "no written result" })
  ]);
}

function renderRunRow(taskId, run, accent, selected) {
  return el(
    "button",
    {
      class: "run-row" + (selected ? " selected" : ""),
      onClick: () => selectRun(taskId, run.run),
      "data-focus-key": "run-" + taskId + "-" + run.run
    },
    [
      el("span", { class: "run-num", style: selected ? { color: accent } : {}, text: run.num }),
      el("span", { class: "run-provider", text: run.provider }),
      el("span", { class: "run-duration", text: run.duration ?? "—" }),
      el("span", { class: "run-state", style: { color: run.stateColor }, text: run.state })
    ]
  );
}

// The RUNS instrument inside task detail. Compact by design; selecting a run
// (or two) opens its factual detail below the strip.
function renderRunsSection(detail, row, accent) {
  const providerNames = {};
  for (const p of state.providers) providerNames[p.id] = p.displayName;
  const runs = projectRuns(detail.runs, { providers: providerNames });
  if (runs.length < 2) return null;
  const taskId = row.id;
  const events = state.eventsByTask.get(taskId) ?? [];
  const selected = state.runSelection.filter(s => s.taskId === taskId);

  const strip = el("div", { class: "runs" }, [
    el("div", { class: "runs-k", text: "RUNS" }),
    ...runs.map(run =>
      renderRunRow(taskId, run, accent, selected.some(s => s.run === run.run))
    )
  ]);

  let panel = null;
  if (selected.length === 2) {
    panel = el(
      "div",
      { class: "compare" },
      selected.map(sel => {
        const run = runs.find(r => r.run === sel.run);
        return run ? renderRunPanel(taskId, run, events, accent) : null;
      })
    );
  } else if (selected.length === 1) {
    const run = runs.find(r => r.run === selected[0].run);
    if (run) panel = renderRunPanel(taskId, run, events, accent);
  }

  return el("div", { class: "runs-section" }, [strip, panel].filter(Boolean));
}

// --- ledger rendering ------------------------------------------------------

// A provider that emits more than it declared is not hidden (facts still
// render — see ledger.mjs `sections()`), it is flagged: a console warning,
// once per task+dimension-set, never a UI element. This is the one place
// `row.capabilityDrift` is read.
const warnedDrift = new Set();
function warnCapabilityDrift(row) {
  if (!row.capabilityDrift?.length) return;
  const key = row.id + ":" + row.capabilityDrift.join(",");
  if (warnedDrift.has(key)) return;
  warnedDrift.add(key);
  console.warn(
    `0x2F: task ${row.num} (${row.providerId ?? "?"}) reported ${row.capabilityDrift.join(", ")} ` +
      "without declaring the capability — the ledger shows it anyway."
  );
}

// One mark per real event: `cell.cls` is the mark's class (change/command/
// tool/human), never a phase. The halt tear and the live head are POSITIONS
// (see ledger.mjs trace()), not units — they get their own shapes instead of
// a fill. `cell.ambient` is the coarse provider's single elapsed-time bar: it
// is deliberately never shaped like a reported mark.
function trackCell(cell, accent) {
  const parts = [];
  if (cell.isHead) {
    parts.push(
      el("div", {
        class: "track-head",
        style: { width: cell.w, background: accent, boxShadow: "0 0 9px " + accent + "70" }
      })
    );
    return el("div", { class: "track-cell", style: { width: cell.w } }, parts);
  }
  if (cell.isHalt) {
    parts.push(
      el(
        "div",
        {
          class: "track-halt",
          style: { background: accent, boxShadow: "0 0 10px " + accent + "70" }
        },
        [el("span", { style: { color: accent }, text: "!" })]
      )
    );
    return el("div", { class: "track-cell", style: { width: cell.w } }, parts);
  }
  parts.push(
    el("div", {
      class: "fill" + (cell.ambient ? " ambient" : ""),
      style: { height: cell.h, background: cell.c }
    })
  );
  return el("div", { class: "track-cell", style: { width: cell.w }, title: cell.arg || null }, parts);
}

function renderTrack(row, accent) {
  const t = row.trace;
  if (!t) return null; // answer-primary rows (ready/failed/done) carry no trace

  const wash = el("div", {
    class: "track-wash",
    style: {
      width: t.doneW,
      background: "linear-gradient(180deg, rgba(47,95,168,0) 40%, " + accent + "1f 100%)"
    }
  });

  const track = el("div", { class: "track" }, t.cells.map(cell => trackCell(cell, accent)));

  // CHANGES is the one bracket the projection can ever draw (VERIFY/INSPECT
  // are intentionally unreachable — see ledger.mjs brackets()).
  const brackets = el(
    "div",
    { class: "track-brackets" },
    t.brackets.map(b =>
      el("div", { class: "track-bracket", style: { left: b.x, width: b.w } }, [
        el("span", { class: "track-bracket-label", text: b.label })
      ])
    )
  );

  return el("div", { class: "track-wrap" }, [wash, track, el("div", { class: "track-axis" }), brackets]);
}

// A small, unlabelled version of the trace for the collapsed row — never
// phase-grouped, just marks (or the coarse ambient bar).
function renderMini(row) {
  return el(
    "div",
    { class: "compact-mini" },
    row.mini.map(cell => el("span", { style: { width: cell.w, height: cell.h, background: cell.c, flex: "none" } }))
  );
}

// READY/FAILED close with a small provenance trace instead of the live one:
// what actually happened, at a glance, after the run is over. FAILED labels
// it "BEFORE THE STOP" rather than "PROVENANCE" — the same shape, an honest
// different name for what it is showing.
function renderProvenance(row, accent) {
  const p = row.provenance;
  if (!p) return null;
  const track = el("div", { class: "track provenance" }, p.cells.map(cell => trackCell(cell, accent)));
  const brackets = el(
    "div",
    { class: "track-brackets" },
    p.brackets.map(b =>
      el("div", { class: "track-bracket", style: { left: b.x, width: b.w } }, [
        el("span", { class: "track-bracket-label", text: b.label })
      ])
    )
  );
  return el("div", { class: "provenance-wrap" }, [
    el("div", { class: "provenance-k", text: p.heading }),
    el("div", { class: "track-wrap provenance" }, [track, el("div", { class: "track-axis" }), brackets])
  ]);
}

function actionButton(label, key, cls, onClick, focusKey) {
  return el(
    "button",
    { class: "act " + cls, onClick, "data-focus-key": focusKey },
    [label + " ", el("span", { class: "key", text: key })]
  );
}

// CLOSE: tell 0x2F this Work is no longer active (the existing closeWork
// action — never a provider call, never a new execution attempt).
function closeButton(id) {
  return actionButton("CLOSE", "X", "act-quiet", e => {
    e.stopPropagation();
    close(id);
  }, "close-" + id);
}

// A needs_you/decision block: the agent cannot continue without the human's
// judgment. The question is shown and the human ANSWERS — there is no
// ALLOW/REJECT here, those verbs belong to permissions. When the provider
// cannot resume sessions the limitation is stated plainly instead of faking
// a continuation; CLOSE remains the way to remove the Work from attention.
function renderDecisionCard(row, accent) {
  const provider = state.providers.find(p => p.id === row.providerId);
  const resumable = provider?.capabilities?.supportsResume === true;
  const value = state.answers.get(row.id) ?? "";

  const input = el("textarea", {
    class: "decision-answer",
    rows: 3,
    placeholder: "your answer to the decision…"
  });
  input.value = value;

  const submit = el("button", {
    class: "act act-primary",
    "data-focus-key": "answer-" + row.id,
    text: "ANSWER"
  });
  submit.disabled = value.trim().length === 0;
  submit.addEventListener("click", e => {
    e.stopPropagation();
    answerDecision(row.id);
  });
  input.addEventListener("input", () => {
    state.answers.set(row.id, input.value);
    submit.disabled = input.value.trim().length === 0;
  });

  const acts = [submit];
  if (row.permDetail) {
    acts.push(
      actionButton("INSPECT", "I", "act-outline", e => {
        e.stopPropagation();
        toggleInspect(row.id);
      }, "inspect-" + row.id)
    );
  }
  // ANSWER records the decision in Task context; SEND BACK reruns the task so
  // the next run continues with the answer in context.
  acts.push(
    actionButton("SEND BACK", "S", "act-outline", e => {
      e.stopPropagation();
      e.currentTarget.disabled = true;
      sendBack(row.id).finally(() => render());
    }, "sendback-" + row.id)
  );
  acts.push(closeButton(row.id));

  return el(
    "div",
    { class: "halt-card decision", style: { border: "1px solid " + accent } },
    [
      el("div", { class: "halt-kind", style: { color: accent }, text: "DECISION REQUIRED" }),
      el("div", { class: "halt-verb", text: "the agent cannot continue without your answer" }),
      row.permWhy
        ? el("div", { class: "halt-path decision-question" }, inlineEls(parseInline(row.permWhy)))
        : null,
      !resumable
        ? el("div", {
            class: "decision-limitation",
            text:
              (provider?.displayName ?? "This provider") +
              " cannot resume sessions — answering records your decision in this run's history. The task stays NEEDS YOU; close it to remove it from attention."
          })
        : null,
      state.inspectId === row.id && row.permDetail
        ? el("div", { class: "halt-detail", text: row.permDetail })
        : null,
      el("div", { class: "decision-answer-wrap" }, [input]),
      el("div", { class: "acts" }, acts)
    ]
  );
}

function renderHalt(row, accent) {
  if (row.permType === "decision") {
    return renderDecisionCard(row, accent);
  }

  const acts = [];
  // Interactive ACP permissions may expose choices that cannot safely map to
  // ALLOW/REJECT; only offer an action when the mapping is unambiguous.
  if (row.permAllowable) {
    acts.push(
      actionButton("ALLOW", "A", "act-primary", e => {
        e.stopPropagation();
        allow(row.id);
      }, "allow-" + row.id)
    );
  }
  if (row.permDetail) {
    acts.push(
      actionButton("INSPECT", "I", "act-outline", e => {
        e.stopPropagation();
        toggleInspect(row.id);
      }, "inspect-" + row.id)
    );
  }
  if (row.permRejectable) {
    acts.push(
      actionButton("REJECT", "R", "act-quiet", e => {
        e.stopPropagation();
        reject(row.id);
      }, "reject-" + row.id)
    );
  }
  // CLOSE is always available: removing a Work from active attention is not
  // an answer to the agent, it is a statement about the Work.
  acts.push(closeButton(row.id));

  const options =
    row.permOptions.length && (!row.permAllowable || !row.permRejectable)
      ? el(
          "div",
          { class: "halt-why", style: { color: COLORS.muted } },
          ["choices: " + row.permOptions.map(o => o.name).join(" · ")]
        )
      : null;

  return el(
    "div",
    { class: "halt-card", style: { border: "1px solid " + accent } },
    [
      el("div", { class: "halt-kind", style: { color: accent }, text: row.permTitle }),
      row.permLive
        ? el("div", { class: "halt-verb", text: "agent requested permission" })
        : row.permPath
          ? el("div", { class: "halt-verb", text: "wants to modify" })
          : null,
      row.permPath ? el("div", { class: "halt-path", text: row.permPath }) : null,
      row.permWhy ? el("div", { class: "halt-why", text: row.permWhy }) : null,
      options,
      state.inspectId === row.id && row.permDetail
        ? el("div", { class: "halt-detail", text: row.permDetail })
        : null,
      el("div", { class: "acts" }, acts)
    ]
  );
}

// A section is declared ∩ observed (see ledger.mjs `sections()`): app.js
// never decides whether ACTIVITY/FILES/COMMANDS exist, it only renders the
// object it is handed, or nothing when that object is null. No section here
// ever renders empty, and no section renders a status string in place of
// data — an absent dimension is silence, not a placeholder.
function sectionRow(label, meta, content) {
  return el("div", { class: "band" }, [
    el("div", { class: "band-left" }, [
      el("div", { class: "band-label", text: label }),
      meta ? el("div", { class: "band-meta", text: meta }) : null
    ].filter(Boolean)),
    el("div", { class: "band-right" }, content)
  ]);
}

function renderActivitySection(row) {
  const a = row.activitySection;
  if (!a) return null;
  const items = a.recent.map(step =>
    el("div", { class: "band-item" }, [
      el("span", {
        class: "band-verb",
        style: { color: step.human ? COLORS.accent : COLORS.inkSoft },
        text: step.verb
      }),
      el("span", {
        class: "band-arg" + (step.human ? " human" : ""),
        style: { color: step.human ? COLORS.accent : COLORS.ink },
        text: step.arg
      }),
      el("span", { class: "band-t", text: fmtDuration(step.t) })
    ])
  );
  return sectionRow("ACTIVITY", a.earlier ? a.earlier + " earlier events" : null, items);
}

function renderFilesSection(row) {
  const f = row.filesSection;
  if (!f) return null;
  const items = f.paths.map(path => el("div", { class: "band-item" }, [el("span", { class: "band-arg", text: path })]));
  return sectionRow("FILES", f.paths.length + (f.paths.length === 1 ? " file" : " files"), items);
}

function renderCommandsSection(row) {
  const c = row.commandsSection;
  if (!c) return null;
  const items = c.commands.map(cmd => el("div", { class: "band-item" }, [el("span", { class: "band-arg", text: cmd })]));
  return sectionRow("COMMANDS", c.commands.length + (c.commands.length === 1 ? " command" : " commands"), items);
}

// The DOM layer never asks "is this status allowed to show ACTIVITY" — that
// gate already happened in ledger.mjs (SECTION_KEYS_BY_STATUS). Each of
// these three is independently null-or-not.
function renderSections(row) {
  const parts = [renderActivitySection(row), renderFilesSection(row), renderCommandsSection(row)].filter(Boolean);
  return parts.length ? el("div", { class: "bands" }, parts) : null;
}

function renderResult(row, detail) {
  const body = detail && detail.result && detail.result.trim()
    ? el("div", { class: "result-body" }, [richBody(detail.result.trim())])
    : row.error
      ? el("div", { class: "result-body", style: { color: COLORS.fail } }, [richBody(row.error)])
      : el("div", { class: "band-pending", style: { color: COLORS.muted }, text: "no written result" });

  // SEND BACK: rerun through the shared action — the next run is rebuilt from
  // current Task state, so a correction recorded with NOTE reaches the agent.
  // The button disables itself while the request is in flight so a double tap
  // cannot start two runs; the request id dedupe covers network retries.
  const sendBackBtn = row.ready || row.failed
    ? actionButton("SEND BACK", "S", "act-outline", e => {
        e.stopPropagation();
        e.currentTarget.disabled = true;
        sendBack(row.id).finally(() => render());
      }, "sendback-" + row.id)
    : null;

  const acts = row.ready
    ? el("div", { class: "acts" }, [
        actionButton("ACCEPT", "A", "act-primary", e => {
          e.stopPropagation();
          accept(row.id);
        }, "accept-" + row.id),
        sendBackBtn,
        closeButton(row.id)
      ])
    : row.failed
      ? el("div", { class: "acts" }, [sendBackBtn, closeButton(row.id)])
      : null;

  return el("div", { class: "result" }, [
    el("div", {}, [el("div", { class: "result-k", text: row.failed ? "FAILURE" : "RESULT" })]),
    el("div", { class: "band-right" }, [body, acts].filter(Boolean))
  ]);
}

// The one capability-driven sentence the ledger ever shows (§09): either it
// is null, or it is exactly one of the two constant strings ledger.mjs
// produces. No dynamic composition happens here.
function renderCapabilityNote(row) {
  if (!row.note) return null;
  return el("div", { class: "capability-note", text: row.note });
}

// --- note: a free-form constraint/correction recorded on the task -----------
// Uses the shared noteWork action: Task context only, no execution started.
// The task's next run (SEND BACK) rebuilds its input from Task state, so the
// note reaches the agent automatically. Kept across re-renders exactly like
// half-typed decision answers.

const noteInputs = new Map(); // taskId -> half-typed note

function renderNoteLine(row) {
  const input = el("input", {
    class: "note-input",
    placeholder: "correction / constraint for the next run…",
    autocomplete: "off",
    spellcheck: "false"
  });
  const saved = noteInputs.get(row.id) ?? "";
  input.value = saved;

  const btn = el("button", { class: "act act-quiet", text: "NOTE" });
  btn.disabled = saved.trim().length === 0;

  async function submit() {
    if (remoteBlocked()) return;
    const note = (noteInputs.get(row.id) ?? "").trim();
    if (!note) return;
    btn.disabled = true;
    try {
      await api("/api/tasks/" + row.id + "/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note })
      });
      noteInputs.delete(row.id);
    } catch (error) {
      flash(error.message);
      return;
    }
    await reloadTasks();
  }

  btn.addEventListener("click", e => {
    e.stopPropagation();
    submit();
  });
  input.addEventListener("input", () => {
    noteInputs.set(row.id, input.value);
    btn.disabled = input.value.trim().length === 0;
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  return el("div", { class: "note-line" }, [
    el("span", { class: "note-k", text: "NOTE" }),
    input,
    btn
  ]);
}

// Task ids already on screen. A row only plays its entrance animation the
// first time it appears; re-renders (a progress event, the elapsed clock)
// must leave it alone.
const onScreen = new Set();

function renderRow(row, accent) {
  const entering = !onScreen.has(row.id);
  onScreen.add(row.id);
  const gutter = el("div", { class: "row-gutter", style: { padding: row.gutterPad } }, [
    row.selected ? el("span", { class: "row-tick", style: { background: accent } }) : null,
    el("span", { class: "row-num", style: { color: row.numColor }, text: row.num })
  ]);

  let body;
  if (row.compact) {
    body = el(
      "div",
      { class: "compact", style: { padding: row.pad }, onClick: () => toggleOpen(row.id) },
      [
        el("span", {
          class: "compact-title",
          style: { fontSize: row.titleSize, fontWeight: row.titleWeight, color: row.titleColor }
        }, inlineEls(parseInline(row.title))),
        el("span", { class: "compact-sub", style: { color: row.subColor }, text: row.sub }),
        renderMini(row),
        el("span", { class: "compact-state", style: { color: row.stateColor }, text: row.stateLabel })
      ]
    );
  } else {
    const detail = state.details?.get(row.id);
    warnCapabilityDrift(row);
    // One content order covers every status: each piece gates itself to
    // null when the lifecycle stage does not carry it (§10) — a working row
    // has a trace and no RESULT, a ready row has RESULT/PROVENANCE and no
    // trace, a done row has only RESULT. No per-status branching is needed
    // here because ledger.mjs already decided what exists.
    body = el("div", { style: { padding: row.pad } }, [
      el("div", { class: "detail-head", onClick: () => toggleOpen(row.id) }, [
        el("h1", { class: "detail-title", style: { fontSize: row.titleSize } }, inlineEls(parseInline(row.title))),
        el("span", { class: "detail-state", style: { color: row.stateColor }, text: row.stateLabel })
      ]),
      renderTrack(row, accent),
      el("div", { class: "status-line" }, [
        el("span", { class: "status-phase", text: row.phaseLabel }),
        el("span", { class: "status-arg", text: row.arg }),
        el("span", { class: "status-node", text: row.node }),
        el("span", { class: "status-div" }),
        el("span", { class: "status-elapsed", text: row.elapsed })
      ]),
      // The AUTO routing decision, quietly: why 0x2F ran this task here.
      row.routed
        ? el("div", { class: "routed-line" }, [
            el("span", { class: "routed-k", text: "ROUTED" }),
            el("span", { class: "routed-v", text: row.routed.provider + " / " + (row.node.split(" / ")[0] || "local") }),
            el("span", { class: "routed-why", text: row.routed.reason })
          ])
        : null,
      renderCapabilityNote(row),
      row.halted ? renderHalt(row, accent) : null,
      row.ready || row.failed || row.done ? renderResult(row, detail) : null,
      renderSections(row),
      renderProvenance(row, accent),
      renderNoteLine(row),
      // Run history lives inside task detail: a compact RUNS strip, with
      // per-run facts and side-by-side comparison behind selection.
      detail && detail.runs ? renderRunsSection(detail, row, accent) : null
    ]);
  }

  return el(
    "div",
    {
      class: "row" + (entering ? " enter" : ""),
      style: {
        background: row.bg,
        borderTop: row.borderT,
        borderBottom: row.borderB
      }
    },
    [gutter, el("div", { class: "row-body", style: { borderLeftColor: row.gutterRule } }, [body])]
  );
}

// --- chrome ----------------------------------------------------------------

function counter(value, label, color, extraClass = "") {
  return el("div", { class: "counter " + extraClass }, [
    el("div", { class: "counter-n", style: { color }, text: value }),
    el("div", { class: "counter-k", style: { color }, text: label })
  ]);
}

function renderChrome(ledger, accent) {
  const now = new Date();
  const clock = [now.getHours(), now.getMinutes(), now.getSeconds()].map(two).join(":");
  const needsColor = ledger.counts.needs_you ? accent : "#a8b3bc";
  const clockCounter = counter(clock, "TODAY", "#c3ccd3", "clock");
  clockNode = clockCounter.querySelector(".counter-n");

  // The "/" mark pulses with the sound: one fade for READY, a split fade for
  // NEEDS YOU. The negative animation delay resumes a pulse across re-renders
  // instead of restarting it mid-flight.
  let slashClass = "brand-slash";
  let slashDelay = null;
  if (state.pulse) {
    const elapsed = Date.now() - state.pulse.at;
    if (elapsed < PULSE_MS[state.pulse.type]) {
      slashClass += state.pulse.type === "needs_you" ? " slash-split" : " slash";
      slashDelay = "-" + elapsed + "ms";
    } else {
      state.pulse = null;
    }
  }

  return el("div", { class: "chrome" }, [
    el("div", { class: "chrome-inner" }, [
      el("div", { class: "brand" }, [
        el("span", { class: "brand-mark", text: "0x2F" }),
        el("span", { class: slashClass, style: slashDelay ? { animationDelay: slashDelay } : {}, text: "/" }),
        el("span", { class: "brand-scope", text: state.remote ? "REMOTE" : "LOCAL" }),
        el("span", { class: "chrome-div" }),
        el("span", { class: "runtime" }, [
          el("span", { class: "runtime-label", text: "RUNTIME" }),
          el("span", { class: "runtime-dot" + (state.connected ? "" : " off") }),
          el("span", { class: "runtime-host", text: location.host })
        ])
      ]),
      el("div", { class: "chrome-settings" }, [
        el("button", {
          class: "setting",
          onClick: toggleSound,
          text: state.soundOn ? "SOUND ON" : "SOUND OFF",
          title: state.soundOn ? "the slash is on" : "silent — no audio at all"
        }),
        renderNotifyControl()
      ]),
      el("div", { class: "counters" }, [
        counter(ledger.countNeeds, "NEEDS YOU", needsColor),
        counter(ledger.countWorking, "WORKING", "#f2f5f7"),
        counter(ledger.countReady, "READY", "#f2f5f7"),
        clockCounter
      ])
    ])
  ]);
}

let composerInput = null;
let composerNode = null;
let adapterNode = null;
let providerSelect = null;
let composerHint = null;
let refineButton = null;
let startButton = null;
let syncComposerFn = null; // width-dependent visuals (font size) refresh on resize
let cancelRefineFn = null; // lets global ESC cancel BRIEF even when focus left the textarea

// Refinement in flight: buttons are disabled and the hint reads REVISING…
// while the model call is running, so the user cannot double-fire BRIEF or
// submit a task mid-refinement. ESC (or CANCEL) aborts the in-flight call.
// On failure the composer is left untouched — the user retries BRIEF or
// presses START with their original text.
let refining = false;
// The pre-BRIEF note, kept only while that revision stands untouched — this
// is what REVERT TO NOTE (or ⌘Z) restores. Cleared on edit-past-revision,
// revert, or a fresh START.
let refineOriginal = null;
let dirtySinceRefine = false;
let refineError = null;
let refineElapsedSec = 0;
let refineTimer = null;
let refineAbort = null;

// The composer is built ONCE and kept across renders: re-creating it would
// reset the caret and drop a half-typed task every time an event lands.
function buildComposer() {
  // A textarea, not a single-line input: BRIEF produces a longer, structured
  // brief and the user must be able to review/edit it in place before START.
  // A single-line note still submits on Enter; a multi-line brief only
  // submits on the mod key (see the keydown handler below) so Enter can add
  // a line to it.
  const input = el("textarea", {
    placeholder: "what needs doing?",
    autocomplete: "off",
    spellcheck: "false",
    rows: 1
  });
  composerHint = el("span", { class: "composer-hint", text: "BACKGROUND JOB" });
  const composerMeta = el("span", { class: "composer-meta" });
  const composerMetaDivider = el("span", { class: "composer-meta-divider" });
  const composerCaret = el("span", { class: "composer-caret" });

  // Provider selection is deliberately secondary: tasks are first. The
  // select defaults to the runtime default provider and is populated from
  // /api/providers, so adding a provider needs no client change.
  const select = el("select", {
    class: "composer-provider",
    "aria-label": "execution provider",
    title: "execution provider"
  });
  providerSelect = select;

  const refineKey = el("span", { class: "composer-key", text: "⌥↵" });
  const refineLabel = el("span", { text: "BRIEF" });
  const startKeyEl = el("span", { class: "composer-key", text: "↵" });

  const revertButton = el(
    "button",
    { class: "composer-revert", title: "restore the note this brief replaced (⌘Z)" },
    ["REVERT TO NOTE", el("span", { class: "composer-key", text: "⌘Z" })]
  );

  function two(n) {
    return String(n).padStart(2, "0");
  }

  function mac() {
    return typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "");
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height =
      Math.min(input.scrollHeight, Math.min(320, Math.round(window.innerHeight * 0.4))) + "px";
  }

  // Every visual in the composer is a pure function of {text, refining,
  // refineOriginal, dirtySinceRefine, refineError, viewport width} -- this
  // recomputes all of it. Called after every state change instead of each
  // caller patching the DOM piecemeal, so no state combination is missed.
  function syncComposer() {
    const text = input.value;
    const multiline = text.includes("\n");
    const armed = text.trim().length > 0;
    const revised = refineOriginal !== null;
    const narrow = window.innerWidth <= 640;
    const startKey = multiline ? (mac() ? "⌘↵" : "^↵") : "↵";
    startKeyEl.textContent = startKey;

    let hintText = "BACKGROUND JOB";
    let hintClass = "composer-hint";
    if (refining) {
      hintText = "REVISING… 0:" + two(refineElapsedSec) + "   ESC CANCEL";
      hintClass = "composer-hint refining";
    } else if (refineError) {
      hintText = refineError;
      hintClass = "composer-hint error";
    } else if (revised && !dirtySinceRefine) {
      hintText = "REVISED · REVIEW AND START";
    } else if (armed) {
      hintText = startKey + " START";
      hintClass = "composer-hint armed";
    }
    composerHint.textContent = hintText;
    composerHint.className = hintClass;

    const showMeta = !refining && multiline && !narrow;
    composerMetaDivider.style.display = showMeta ? "" : "none";
    composerMeta.style.display = showMeta ? "" : "none";
    if (showMeta) {
      const lines = text ? text.split("\n").length : 0;
      composerMeta.textContent =
        lines + (lines === 1 ? " LINE" : " LINES") +
        (revised ? " · FROM " + refineOriginal.split("\n").length + " LINE NOTE" : "");
    }

    revertButton.style.display = revised && !refining && !narrow ? "" : "none";
    refineLabel.textContent = refineError ? "RETRY" : "BRIEF";
    if (refineButton) refineButton.disabled = refining;
    if (startButton) startButton.disabled = refining;

    input.style.fontSize = narrow ? "16px" : multiline ? "15px" : "18px";
    input.style.color = refining ? "#7d8892" : "#f2f5f7";

    const caretBg = refining ? "#2f5fa8" : armed ? "#2f5fa8" : "#4b545c";
    composerCaret.style.background = caretBg;
    composerCaret.style.boxShadow = armed || refining ? "0 0 8px #2f5fa870" : "none";
    composerCaret.style.animation = refining ? "wk-scan 1.1s ease-in-out infinite" : "none";
  }
  syncComposerFn = syncComposer;

  function markEdited() {
    dirtySinceRefine = refineOriginal !== null;
    refineError = null;
    autosize();
    syncComposer();
  }

  // START / Enter: submit the composer's CURRENT text exactly as today -- the
  // brief if BRIEF ran, the rough note otherwise. This is the only path that
  // creates a task; BRIEF never does.
  async function submit() {
    if (refining) return;
    if (remoteBlocked()) return;
    const title = input.value.trim();
    if (!title) return;
    const provider = providerSelect?.value || undefined;
    // Convenience guard only -- the action boundary (and therefore the API)
    // enforces availability itself, so a stale select can never submit an
    // unavailable provider. Refuse before clearing the field.
    if (provider && provider !== "auto") {
      const picked = state.providers.find(p => p.id === provider);
      if (picked && !picked.available) {
        flash(
          `Execution provider "${provider}" is unavailable -- install or configure it, then retry.`
        );
        return;
      }
    }
    input.value = "";
    refineOriginal = null;
    dirtySinceRefine = false;
    refineError = null;
    autosize();
    syncComposer();
    try {
      const task = await api("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, ...(provider ? { provider } : {}) })
      });
      state.openId = task.id;
      state.selectedId = task.id;
    } catch (error) {
      flash(error.message);
      return;
    }
    await reloadTasks();
  }

  // BRIEF: send the composer's current text to the refinement service and
  // replace it with the refined brief IN THE SAME composer. The result stays
  // fully editable and START is never triggered -- BRIEF only rewrites text.
  // The pre-brief note is kept so REVERT TO NOTE (or the mod key + Z) can
  // restore it, and the call is cancelable (ESC) while it is in flight.
  async function refine() {
    if (refining) return;
    const text = input.value.trim();
    if (!text) {
      flash("Nothing to brief -- write your task first.");
      return;
    }
    refineError = null;
    refineElapsedSec = 0;
    refineAbort = new AbortController();
    refining = true;
    syncComposer();
    refineTimer = setInterval(() => {
      refineElapsedSec += 1;
      syncComposer();
    }, 1000);
    try {
      const res = await api("/api/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: refineAbort.signal
      });
      if (!res.refined) {
        throw new Error("The model returned an empty brief -- try again.");
      }
      refineOriginal = text;
      dirtySinceRefine = false;
      input.value = res.refined;
      autosize();
      input.style.animation = "none";
      void input.offsetHeight;
      input.style.animation = "wk-reveal .3s ease both";
      input.focus();
      input.setSelectionRange(0, 0);
    } catch (error) {
      // A deliberate cancel (ESC) leaves no error -- retry BRIEF or press
      // START with what is already in the composer. A real failure leaves
      // the original text untouched and surfaces inline.
      if (error.name !== "AbortError") refineError = error.message;
    } finally {
      clearInterval(refineTimer);
      refineTimer = null;
      refining = false;
      syncComposer();
    }
  }

  function cancelRefine() {
    if (!refining) return;
    refineAbort?.abort();
  }
  cancelRefineFn = cancelRefine;

  // Restore the note a brief replaced. Only reachable while that revision
  // stands: any edit past it clears the option (see markEdited).
  function revert() {
    if (refineOriginal === null) return;
    input.value = refineOriginal;
    refineOriginal = null;
    dirtySinceRefine = false;
    refineError = null;
    autosize();
    syncComposer();
    input.focus();
  }

  input.addEventListener("input", markEdited);

  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (refining) {
        event.preventDefault();
        cancelRefine();
      } else {
        input.blur();
      }
      return;
    }
    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      refine();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    // A single-line note still submits on Enter; once BRIEF has grown it
    // into a multi-line brief, Enter is a plain newline -- only the mod key
    // (or the button) submits, or the brief could never be edited past line
    // one.
    if (event.key === "Enter" && !event.shiftKey && !input.value.includes("\n")) {
      event.preventDefault();
      submit();
      return;
    }
    if (
      event.key.toLowerCase() === "z" &&
      (event.metaKey || event.ctrlKey) &&
      refineOriginal !== null &&
      !dirtySinceRefine
    ) {
      event.preventDefault();
      revert();
    }
  });

  refineButton = el(
    "button",
    {
      class: "composer-btn composer-refine",
      title: "turn this rough note into a clear execution brief (uses a model)"
    },
    [refineLabel, refineKey]
  );
  refineButton.addEventListener("click", refine);

  revertButton.addEventListener("click", revert);

  startButton = el(
    "button",
    { class: "composer-btn composer-start", title: "start this task" },
    ["START", startKeyEl]
  );
  startButton.addEventListener("click", submit);

  composerInput = input;
  adapterNode = el("span", { class: "legend-adapter" });
  syncComposer();

  return el("div", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [
      el("div", { class: "composer-row" }, [
        el("span", { class: "composer-k", text: "SUBMIT" }),
        composerCaret,
        select,
        input
      ]),
      el("div", { class: "composer-acts" }, [
        el("div", { class: "composer-hint-group" }, [composerHint, composerMetaDivider, composerMeta]),
        revertButton,
        refineButton,
        el("span", { class: "composer-divider" }),
        startButton
      ])
    ]),

    el("div", { class: "legend" }, [
      el("div", { class: "legend-inner" }, [
        el("span", { text: "J K SELECT" }),
        el("span", { text: "\u21b5 OPEN" }),
        el("span", { text: "A ALLOW / ACCEPT" }),
        el("span", { text: "R REJECT" }),
        el("span", { text: "S SEND BACK" }),
        el("span", { text: "I INSPECT" }),
        el("span", { text: "X CLOSE" }),
        el("span", { text: "/ SUBMIT" }),
        el("span", { text: "ESC COLLAPSE" }),
        adapterNode
      ])
    ])
  ]);
}

// Populate the composer's provider select. AUTO is the first option (the
// primary choice when routing is configured); the selected default follows
// /api/routing (AUTO when configured, else the runtime default provider).
// Providers that cannot run on this machine are shown as unavailable and
// disabled — they cannot be submitted here, and the server enforces the same
// fact at the action boundary. A failure leaves the select empty and submits
// fall back to the server default, so provider choice never blocks a task.
async function loadProviders() {
  try {
    const providers = await api("/api/providers");
    state.providers = providers;
    // Declared capabilities drive progressive fidelity everywhere (desktop
    // AND mobile) — re-render once they land, or every row stays classified
    // "coarse" (the fidelity() default for an undeclared provider) until the
    // next unrelated re-render happens to pick state.providers up.
    render();
    // The provider <select> only exists on desktop — the mobile Attention
    // Stack never mounts the composer (task creation is out of scope for
    // Remote Control v1).
    if (!providerSelect) return;
    let routing = null;
    try {
      routing = await api("/api/routing");
    } catch {
      /* server default applies */
    }
    providerSelect.replaceChildren(
      el("option", { value: "auto", text: "AUTO" }),
      ...providers.map(p =>
        el("option", {
          value: p.id,
          text: p.id.toUpperCase() + (p.available ? "" : " — UNAVAILABLE"),
          disabled: p.available ? undefined : true
        })
      )
    );
    // Select the configured default when it can actually run; otherwise the
    // first available provider — or AUTO when none can run. Never preselect
    // a provider the server would refuse (the select must not look armed
    // when its value cannot be submitted).
    const configured = routing?.default;
    if (configured === "auto") {
      providerSelect.value = "auto";
    } else if (configured && providers.some(p => p.id === configured && p.available)) {
      providerSelect.value = configured;
    } else {
      const firstAvailable = providers.find(p => p.available);
      providerSelect.value = firstAvailable ? firstAvailable.id : "auto";
    }
  } catch {
    /* server default applies */
  }
}

// Which harness, on which machine — secondary metadata, read off the tasks
// themselves so a second provider or node needs no client change.
function updateAdapter() {
  if (!adapterNode) return;
  const providers = [...new Set(state.tasks.map(t => t.execution?.provider).filter(Boolean))];
  const nodes = [...new Set(state.tasks.map(t => t.execution?.node).filter(Boolean))];
  adapterNode.textContent =
    "0x2F / NODES " +
    two(nodes.length || 1) +
    (providers.length ? " \u00b7 " + providers.join(" + ").toUpperCase() : "");
}

// --- sound demo (dev only) --------------------------------------------------
// `?sound-demo=1` in the URL shows two audition buttons so the two gestures
// can be compared while tuning. Never rendered in the normal UI.
const SOUND_DEMO = new URLSearchParams(location.search).has("sound-demo");

function renderSoundDemo() {
  if (!SOUND_DEMO) return null;
  return el("div", { class: "sound-demo" }, [
    el("span", { class: "sound-demo-k", text: "SOUND DEMO" }),
    el("button", {
      class: "sound-demo-btn",
      onClick: () => {
        slash.ready();
        pulse("ready");
      },
      text: "READY"
    }),
    el("button", {
      class: "sound-demo-btn",
      onClick: () => {
        slash.needsYou();
        pulse("needs_you");
      },
      text: "NEEDS YOU"
    })
  ]);
}

// --- render loop -----------------------------------------------------------

let scrollTop = 0;
let clockNode = null;

function currentLedger(now = Date.now()) {
  return projectLedger(state.tasks, Object.fromEntries(state.eventsByTask), {
    now,
    openId: state.openId,
    selectedId: state.selectedId,
    wide: state.width >= 1180,
    mid: state.width >= 900,
    accent: COLORS.accent,
    base: state.base,
    // Declared provider capabilities drive progressive fidelity. Keyed by
    // id so a new provider needs no client change.
    providers: Object.fromEntries(state.providers.map(p => [p.id, p]))
  });
}

function render() {
  // Below 640px this is the Attention Stack, not the desktop ledger narrowed
  // — a different code path entirely (see "--- mobile: the Attention Stack
  // ---" below). Desktop rendering below this line is untouched by it.
  if (isMobileWidth()) {
    renderMobile();
    return;
  }

  const shell = document.getElementById("shell");
  const accent = COLORS.accent;
  const ledger = currentLedger();
  const live = new Set(ledger.rows.map(r => r.id));
  for (const id of onScreen) if (!live.has(id)) onScreen.delete(id);

  const previousScroll = document.querySelector(".scroll");
  if (previousScroll) scrollTop = previousScroll.scrollTop;
  const focusKey = document.activeElement?.getAttribute?.("data-focus-key") ?? null;

  const head = el("div", { class: "head" }, [
    el("div", { class: "head-gutter", text: "/" }),
    el("div", { class: "head-cols" }, [
      el("span", { text: "TASK" }),
      el("div", { class: "head-right" }, [
        el("span", { class: "head-exec", text: "EXECUTION" }),
        el("span", { class: "head-state", text: "STATE" })
      ])
    ])
  ]);

  const sheet = el("div", { class: "sheet" }, [
    head,
    ...(ledger.rows.length
      ? ledger.rows.map(row => renderRow(row, accent))
      : [el("div", { class: "empty", text: "no tasks in this workspace — submit one below" })]),
    el("div", { style: { height: "56px" } })
  ]);

  const scroll = el("div", { class: "scroll" }, [sheet]);

  if (!composerNode) composerNode = buildComposer();
  updateAdapter();
  // Re-derive composer visuals that depend on viewport width (font size, the
  // narrow-screen chrome it hides) — the composer itself is never rebuilt.
  syncComposerFn?.();

  // Remote + Mac offline: a top banner, and the offline class dims every
  // control that requires the Mac (the guards in the action wrappers are the
  // backstop; this is the visible signal).
  shell.className = state.remote && !state.macOnline ? "offline" : "";
  const parts = [];
  if (state.remote && !state.macOnline) {
    parts.push(
      el("div", {
        class: "mac-offline-bar",
        text: "MAC OFFLINE — showing last known state. Actions are disabled until the Mac reconnects."
      })
    );
  }
  parts.push(
    renderChrome(ledger, accent),
    scroll,
    composerNode,
    ...(SOUND_DEMO ? [renderSoundDemo()] : []),
    ...(state.flash ? [el("div", { class: "flash", text: state.flash })] : [])
  );
  shell.replaceChildren(...parts);

  scroll.scrollTop = scrollTop;
  if (focusKey) document.querySelector('[data-focus-key="' + focusKey + '"]')?.focus();
}

function renderClock() {
  const now = new Date();
  if (clockNode) {
    clockNode.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map(two).join(":");
  }
}

// The expanded row shows the task's written result, which lives outside the
// event log (getWork reads result.md). Fetch it lazily for the open task.
state.details = new Map();
async function ensureDetail(id) {
  if (id === null || id === undefined) return;
  try {
    const detail = await api("/api/tasks/" + id);
    state.details.set(id, detail);
    render();
  } catch {
    /* the task may have been closed underneath us */
  }
}

// --- keyboard --------------------------------------------------------------

function visibleRows() {
  return currentLedger().rows;
}

function onKeyDown(event) {
  // ESC cancels an in-flight BRIEF regardless of where focus landed (a click
  // on the BRIEF button itself moves focus off the textarea, whose own
  // keydown handler would otherwise be the only thing listening for this).
  if (event.key === "Escape" && refining) {
    event.preventDefault();
    cancelRefineFn?.();
    return;
  }
  const target = event.target;
  const inField =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");
  if (inField) {
    if (event.key === "Escape") {
      target.blur();
      state.openId = null;
      render();
    }
    return;
  }

  const rows = visibleRows();
  const index = Math.max(0, rows.findIndex(r => r.id === state.selectedId));
  const row = rows[index];

  if (event.key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    const next = rows[Math.min(rows.length - 1, index + 1)];
    if (next) {
      state.selectedId = next.id;
      render();
    }
  } else if (event.key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = rows[Math.max(0, index - 1)];
    if (next) {
      state.selectedId = next.id;
      render();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (state.selectedId !== null) toggleOpen(state.selectedId);
  } else if (event.key === "/") {
    event.preventDefault();
    composerInput?.focus();
  } else if (event.key === "Escape") {
    state.openId = null;
    render();
  } else if (event.key === "i" || event.key === "I") {
    if (row?.halted && row.permDetail) toggleInspect(row.id);
  } else if (event.key === "a" || event.key === "A") {
    // ALLOW/ACCEPT are permission and ready semantics — a decision is
    // answered (in its card), never allowed.
    if (row?.halted && row.permType !== "decision") allow(row.id);
    else if (row?.ready) accept(row.id);
  } else if (event.key === "r" || event.key === "R") {
    if (row?.halted && row.permType !== "decision") reject(row.id);
  } else if (event.key === "s" || event.key === "S") {
    if (row?.ready || row?.failed) sendBack(row.id);
  } else if (event.key === "x" || event.key === "X") {
    // CLOSE: remove the Work from active attention — never a provider call.
    if (row?.halted || row?.ready || row?.failed) accept(row.id);
  }
}

// --- live stream -----------------------------------------------------------

function connect() {
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    state.connected = true;
    // Reconnects re-read state: a dropped stream may have lost deltas, and
    // the tailer never replays. Current state + live deltas, never guesses.
    loadAll().catch(error => flash(error.message));
  });

  source.addEventListener("error", () => {
    state.connected = false;
    render();
  });

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, message => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      const added = recordEvent(event);
      policy.observe(event);
      if (STATE_EVENTS.has(event.type)) {
        reloadTasks()
          .then(() => ensureDetail(state.openId))
          .catch(() => {});
      } else if (added) {
        render();
      }
    });
  }
}

// --- mobile: the Attention Stack --------------------------------------------
//
// Below 640px this is not the desktop ledger narrowed — it is a different
// surface (see the "Remote — Mobile Pass" handoff): a remote control for
// work that is already running, used ten to thirty seconds at a time. One
// Overview (glance -> understand -> intervene) and one Task Detail (context
// you did not need) — no third screen. It reuses the same row projection
// ledger.mjs already computes and the same actions the desktop ledger calls;
// it only lays them out differently. Task creation is out of scope for
// Remote Control v1 — the composer never mounts at this width.

function isMobileWidth() {
  return state.width <= 640;
}

const mobile = {
  screen: "overview", // "overview" | "detail"
  detailId: null,
  closing: false, // Task Detail is mid slide-out (see closeMobileDetail)
  correctionId: null, // task id whose CORRECTION / ADD A CONSTRAINT sheet is open
  offlineSince: null, // Date.now() captured the moment the Mac went unreachable
  resultExpanded: new Set() // task ids whose READY result is shown in full
};

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function hhmm(ts) {
  const d = new Date(ts);
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

// Task Detail is a real navigation, not a toggle: it plays its 220ms push
// enter animation once per visit. `mobileDetailMounted` remembers which task
// id already played it so a live re-render (the elapsed clock, an incoming
// event) never replays it — the same problem `onScreen` solves for row entry.
let mobileDetailMounted = null;

function openMobileDetail(id) {
  mobile.screen = "detail";
  mobile.detailId = id;
  ensureDetail(id);
  render();
}

// Back is an edge swipe or the ‹ ALL WORK line — both call this. It plays a
// real 180ms slide-out before the Overview takes over. The timer runs
// independent of the DOM node itself (`mobile.closing` drives the class in
// renderMobileDetail): the elapsed clock's 1s tick re-renders the whole tree
// while a task is working, which would otherwise replace the mid-animation
// node and strand an `animationend` listener on a detached element. Reduced
// motion skips straight there.
function closeMobileDetail() {
  if (mobile.screen !== "detail" || mobile.closing) return;
  mobileDetailMounted = null;
  if (prefersReducedMotion()) {
    mobile.screen = "overview";
    mobile.detailId = null;
    render();
    return;
  }
  mobile.closing = true;
  render();
  setTimeout(() => {
    mobile.screen = "overview";
    mobile.detailId = null;
    mobile.closing = false;
    render();
  }, 180);
}

function openCorrection(id) {
  mobile.correctionId = id;
  render();
}
function closeCorrection() {
  mobile.correctionId = null;
  render();
}

// ANSWER & CONTINUE composes the two existing actions: persist the answer
// (the same /answer call SAVE ONLY makes), then rerun through SEND BACK so
// the next run carries it in context — a decision is not resumable in
// place, so "continue" genuinely means starting the next run.
async function answerAndContinue(id) {
  if (remoteBlocked()) return;
  const answer = (state.answers.get(id) ?? "").trim();
  if (!answer) return;
  await answerDecision(id);
  await sendBack(id);
}

// The CORRECTION / ADD A CONSTRAINT sheet shares the desktop NOTE action and
// its half-typed-text map: the constraint sticks to the Task, not the run.
// `rerun` mirrors CORRECTION's SEND BACK (a new run starts with it in
// context); its absence mirrors ADD A CONSTRAINT (recorded without stopping
// the live run).
async function submitCorrection(id, { rerun } = {}) {
  if (remoteBlocked()) return;
  const note = (noteInputs.get(id) ?? "").trim();
  if (!note) return;
  try {
    await api("/api/tasks/" + id + "/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note })
    });
    noteInputs.delete(id);
  } catch (error) {
    flash(error.message);
    return;
  }
  closeCorrection();
  if (rerun) await sendBack(id);
  else await reloadTasks();
}

// A small static trace: the same cells ledger.mjs already computed for this
// row (mini/trace/provenance geometry, ambient marks included), just laid
// out inline. `frozen` (Mac unreachable) strips the live head/halt-tear
// treatment and mutes every mark to graphite — nothing here is awaiting you.
function mobileTraceEls(cells, frozen) {
  return (cells ?? []).map(cell => {
    if (frozen) {
      const h = cell.isHead || cell.isTear ? "6px" : cell.h;
      return el("span", { style: { width: cell.w, height: h, background: "#b3bcc4", flex: "none" } });
    }
    if (cell.isHead) {
      return el("span", {
        class: "m-thead",
        style: { width: cell.w, height: "12px", background: COLORS.accent, flex: "none" }
      });
    }
    if (cell.isHalt) {
      return el("span", {
        style: { width: cell.w, height: "13px", background: COLORS.accent, flex: "none" }
      });
    }
    return el("span", { style: { width: cell.w, height: cell.h, background: cell.c, flex: "none" } });
  });
}

// --- mobile chrome -----------------------------------------------------------

function renderMobileBar(frozen) {
  return el("div", { class: "m-bar" }, [
    el("div", { class: "m-bar-inner" }, [
      el("span", { class: "m-mark", text: "0x2F" }),
      el("span", { class: "m-slash", text: "/" }),
      el("span", { class: "m-bar-spacer" }),
      el("span", { class: "m-dot" + (frozen ? " off" : "") }),
      el("span", { class: "m-host" + (frozen ? " dim" : ""), text: location.host })
    ])
  ]);
}

function renderMobileOfflineBar() {
  if (!(state.remote && !state.macOnline)) return null;
  const since = mobile.offlineSince;
  const label = since
    ? "MAC OFFLINE · LAST KNOWN " + hhmm(since) + " · " + Math.max(0, Math.round((Date.now() - since) / 60000)) + " MIN AGO"
    : "MAC OFFLINE · LAST KNOWN STATE";
  return el("div", { class: "m-offline-bar", text: label });
}

function renderMobileOverviewToolbar(ledger, frozen) {
  const c = ledger.counts;
  const items = [];
  if (c.needs_you) {
    items.push(el("span", { class: "m-count-needs" + (frozen ? " frozen" : ""), text: "NEEDS YOU " + c.needs_you }));
  }
  if (c.working) items.push(el("span", { class: "m-count", text: "WORKING " + c.working }));
  if (c.ready) items.push(el("span", { class: "m-count", text: "READY " + c.ready }));
  if (c.failed) items.push(el("span", { class: "m-count", text: "FAILED " + c.failed }));
  const children = [...items];
  if (frozen) {
    children.push(el("span", { class: "m-toolbar-fill" }));
    children.push(el("span", { class: "m-toolbar-asof", text: "AS OF " + hhmm(mobile.offlineSince ?? Date.now()) }));
  }
  return el("div", { class: "m-toolbar" }, children);
}

// The Task Detail nav bar: back on the left, a quiet "N NEEDS YOU" badge on
// the right when something else needs you (never on the ask's own screen —
// there the tint carries that fact already).
function renderMobileDetailToolbar(row, ledger, frozen) {
  const blue = row.halted;
  const children = [
    el("span", { class: "m-back", onClick: closeMobileDetail, text: "‹ ALL WORK" })
  ];
  if (!blue && ledger.counts.needs_you) {
    children.push(
      el("span", { class: "m-back-badge", text: ledger.counts.needs_you + " NEEDS YOU" })
    );
  }
  const cls = "m-toolbar " + (blue ? "blue" : "quiet") + (frozen ? "" : "");
  return el("div", { class: cls }, children);
}

// --- Overview rows -------------------------------------------------------

// The oldest ask, when it is a permission: answerable in place. "The ask is
// answerable where it appears" — opening the Task is for context you did
// not need, not a step on the way to ALLOW.
function renderMobileAskCard(row, frozen) {
  const acts = [];
  if (row.permAllowable) {
    const btn = el("button", { class: "m-btn m-btn-primary", text: "ALLOW" });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      allow(row.id);
    });
    acts.push(btn);
  }
  if (row.permRejectable) {
    const btn = el("button", { class: "m-btn m-btn-secondary", text: "REJECT" });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      reject(row.id);
    });
    acts.push(btn);
  }

  return el("div", { class: "m-ask" + (frozen ? " frozen" : "") }, [
    el("div", { class: "m-ask-head" }, [
      el("span", { class: "m-ask-kind", text: "NEEDS YOU" }),
      el("span", { class: "m-ask-t", text: "held " + row.elapsed })
    ]),
    el("div", { class: "m-ask-title" }, inlineEls(parseInline(row.title))),
    row.permLive
      ? el("div", { class: "m-ask-verb", text: "agent requested permission" })
      : row.permPath
        ? el("div", { class: "m-ask-verb", text: "wants to modify" })
        : null,
    row.permPath ? el("div", { class: "m-ask-path", text: row.permPath }) : null,
    !row.permPath && row.permWhy ? el("div", { class: "m-ask-why" }, inlineEls(parseInline(row.permWhy))) : null,
    acts.length ? el("div", { class: "m-ask-acts" }, acts) : null,
    el("div", {
      class: "m-ask-hint" + (frozen ? " offline" : ""),
      onClick: frozen ? null : () => openMobileDetail(row.id),
      text: frozen
        ? "the answer has to reach the Mac · it will still be waiting when it reconnects"
        : "the run continues where it stopped · open for context"
    })
  ]);
}

// Any ask that is not the one expanded card: a single blue line carrying its
// own state and (for a decision) a preview of the question, so two open
// decisions never compete for the same thumb. A decision-type ask always
// renders this way, even when it is the only one — answering it needs more
// room than a line, so it opens Task Detail rather than expanding in place.
function renderMobileAskLine(row, frozen) {
  const kind = row.permType === "decision" ? "NEEDS YOU · DECISION" : "NEEDS YOU";
  const preview = row.permType === "decision" ? row.permWhy : row.permPath ? "wants to modify " + row.permPath : row.permWhy;
  return el(
    "div",
    { class: "m-ask-line", onClick: frozen ? null : () => openMobileDetail(row.id) },
    [
      el("div", { class: "m-ask-line-body" }, [
        el("span", { class: "m-ask-line-kind", text: kind }),
        el("div", { class: "m-ask-line-title" }, inlineEls(parseInline(row.title))),
        preview ? el("div", { class: "m-ask-line-preview", text: preview }) : null
      ]),
      el("span", { class: "m-ask-line-t", text: row.elapsed }),
      el("span", { class: "m-ask-line-chev", text: "›" })
    ]
  );
}

function renderMobileWorkingRow(row, frozen) {
  const a = row.activitySection;
  const last = a?.recent?.at(-1);
  let caption;
  if (last) caption = last.verb + " · " + last.arg;
  else if (row.note) caption = row.note;
  else caption = row.arg || "starting execution";

  return el("div", { class: "m-row-tap", onClick: () => openMobileDetail(row.id) }, [
    el("div", { class: "m-row-head" }, [
      el("span", { class: "m-row-state", text: "WORKING" }),
      el("span", { class: "m-row-t", text: row.elapsed })
    ]),
    el("div", { class: "m-row-title" }, inlineEls(parseInline(row.title))),
    el("div", { class: "m-row-trace-line" }, [
      el("div", { class: "m-row-trace" }, mobileTraceEls(row.mini, frozen)),
      el("span", { class: "m-row-caption", text: caption })
    ])
  ]);
}

function renderMobileReadyRow(row) {
  return el("div", { class: "m-row-tap", onClick: () => openMobileDetail(row.id) }, [
    el("div", { class: "m-row-head" }, [
      el("span", { class: "m-row-state", text: "READY" }),
      el("span", { class: "m-row-t", text: row.elapsed })
    ]),
    el("div", { class: "m-row-title" }, inlineEls(parseInline(row.title))),
    el("div", { class: "m-row-sub-muted", style: { marginTop: "9px" }, text: row.sub })
  ]);
}

function renderMobileFailedRow(row) {
  return el("div", { class: "m-row-tap", onClick: () => openMobileDetail(row.id) }, [
    el("div", { class: "m-row-head" }, [
      el("span", { class: "m-row-state", text: "FAILED" }),
      el("span", { class: "m-row-t", text: row.elapsed })
    ]),
    el("div", { class: "m-row-title" }, inlineEls(parseInline(row.title))),
    el("div", { class: "m-row-sub-muted", style: { marginTop: "9px" }, text: row.sub || "execution failed" })
  ]);
}

// The Overview: counts in priority order, the one ask open and answerable in
// place, every running task as one line with a live trace, each finished
// task's single most decision-relevant fact. Closed work is always one line
// — "the screen's emptiest state is its best news" applies to NEEDS YOU
// dropping out entirely, not to hiding what is still open.
function renderMobileOverview(ledger, frozen) {
  const rows = ledger.rows;
  // ledger.mjs orders rows newest-task-first (desktop's own priority order);
  // the Attention Stack needs the OLDEST ask primary — the one that has been
  // waiting on you longest — so needs_you rows are re-sorted by id ascending
  // (the best proxy available: the row projection does not expose a raw
  // halted-since timestamp, only the formatted "held" string).
  const needs = rows.filter(r => r.halted).slice().sort((a, b) => a.id - b.id);
  const rest = rows.filter(r => !r.halted && !r.done);
  const closed = rows.filter(r => r.done);

  const items = [];
  if (needs.length) {
    const oldest = needs[0];
    if (oldest.permType === "decision") items.push(renderMobileAskLine(oldest, frozen));
    else items.push(renderMobileAskCard(oldest, frozen));
    for (const row of needs.slice(1)) items.push(renderMobileAskLine(row, frozen));
  }
  for (const row of rest) {
    if (row.running) items.push(renderMobileWorkingRow(row, frozen));
    else if (row.ready) items.push(renderMobileReadyRow(row));
    else if (row.failed) items.push(renderMobileFailedRow(row));
  }
  if (closed.length) {
    items.push(
      el("div", { class: "m-closed-line", text: closed.length + " CLOSED TODAY" })
    );
  }

  if (!items.length) {
    return el("div", { class: "m-empty", text: "no tasks in this workspace" });
  }
  return el("div", {}, items);
}

// --- Task Detail content ---------------------------------------------------

// The tool step running when the halt landed — "HELD AT EDIT", not the path
// the halt itself carries. Derived from the same activity units the WHAT IT
// WAS DOING box below already shows; never a second source of truth.
function heldAtVerb(row) {
  const recent = row.activitySection?.recent ?? [];
  const haltIndex = recent.findIndex(u => u.kind === "halt");
  const before = haltIndex > 0 ? recent[haltIndex - 1] : haltIndex === -1 ? recent.at(-1) : null;
  return before?.verb ?? null;
}

function providerDisplayName(id) {
  const p = state.providers.find(p => p.id === id);
  return (p?.displayName ?? id ?? "").toUpperCase();
}

function renderMobileHeldMeta(row) {
  const verb = heldAtVerb(row);
  const detail = state.details.get(row.id);
  const runNum = detail?.runs?.length;
  const parts = [];
  if (verb) parts.push("HELD AT " + verb);
  else parts.push("HELD");
  if (row.providerId) parts.push(providerDisplayName(row.providerId));
  if (runNum) parts.push("RUN " + runNum);
  return el("div", { class: "m-dmeta", text: parts.join(" · ") });
}

// WHAT IT WAS DOING / the WORKING detail's LATEST — the same recent activity
// units the desktop ACTIVITY band shows, in a single mobile-width column
// (the two-column band grid is desktop-only — see the handoff's "NOT ON
// MOBILE"). The "N earlier events" line is informational, matching the
// desktop band's own meta text: neither surface has data beyond the last 5.
function renderMobileActivityBox(row, heading, first) {
  const a = row.activitySection;
  if (!a?.recent?.length) return null;
  return el("div", { class: "m-dsection" + (first ? " first" : "") }, [
    el("div", { class: "m-dsection-k strong", text: heading }),
    ...a.recent.map(unit =>
      el("div", { class: "m-devent" }, [
        el("span", { class: "m-devent-verb", text: unit.verb }),
        el("span", { class: "m-devent-arg", text: unit.arg }),
        el("span", { class: "m-devent-t", text: fmtDuration(unit.t) })
      ])
    ),
    a.earlier ? el("div", { class: "m-disclosure", text: a.earlier + " earlier events ›" }) : null
  ]);
}

function renderMobileFilesBox(row, first) {
  const f = row.filesSection;
  if (!f) return null;
  return el("div", { class: "m-dsection" + (first ? " first" : "") }, [
    el("div", { class: "m-dsection-k", text: "FILES · " + f.paths.length + (f.paths.length === 1 ? " TOUCHED" : " TOUCHED") }),
    ...f.paths.map(path => el("div", { class: "m-dfile" }, [el("span", { class: "m-dfile-path", text: path })]))
  ]);
}

function renderMobileCommandsBox(row, first) {
  const c = row.commandsSection;
  if (!c) return null;
  return el("div", { class: "m-dsection" + (first ? " first" : "") }, [
    el("div", { class: "m-dsection-k", text: "COMMANDS" }),
    ...c.commands.map(cmd => el("div", { class: "m-dfile" }, [el("span", { class: "m-dfile-path", text: cmd })]))
  ]);
}

// Real result text, paragraph-truncated to the first three with a disclosure
// that expands to the rest — never a fade, always a rule and a count.
function renderMobileResult(row, detail) {
  const text = (detail?.result && detail.result.trim()) || (row.error ? row.error : "");
  if (!text) return el("div", { class: "band-pending", style: { color: COLORS.muted, marginTop: "11px" }, text: "no written result" });
  const blocks = parseRich(text);
  const expanded = mobile.resultExpanded.has(row.id);
  const shown = expanded ? blocks : blocks.slice(0, 3);
  const hiddenCount = blocks.length - shown.length;
  const body = el("div", { class: "m-dresult" }, shown.map(richBlock));
  const disclosure =
    hiddenCount > 0
      ? el("div", {
          class: "m-disclosure",
          onClick: () => {
            mobile.resultExpanded.add(row.id);
            render();
          },
          text: "full result · " + hiddenCount + (hiddenCount === 1 ? " more paragraph ›" : " more paragraphs ›")
        })
      : null;
  return el("div", {}, [body, disclosure].filter(Boolean));
}

// THIS TASK SO FAR — a multi-run Task's own history as lines, each earlier
// run opening its own result/files/trace on tap (reuses the same
// selectRun/renderRunPanel the desktop RUNS strip uses). Side-by-side
// comparison stays on the desktop; the phone opens one run at a time.
function renderMobileRunHistory(row, detail, accent) {
  if (!detail?.runs || detail.runs.length < 2) return null;
  const providerNames = {};
  for (const p of state.providers) providerNames[p.id] = p.displayName;
  const runs = projectRuns(detail.runs, { providers: providerNames });
  const taskId = row.id;
  const events = state.eventsByTask.get(taskId) ?? [];
  const selected = state.runSelection.filter(s => s.taskId === taskId);

  const items = runs.map(run => {
    // The run already shown at the top of this screen (working or held on
    // this ask) is never also a clickable history entry — it has nothing to
    // add that isn't already on screen.
    const isNow = run.run === runs.at(-1).run && (row.running || row.halted);
    const isSelected = selected.some(s => s.run === run.run);
    const head = el(
      "div",
      { class: "m-drun-head", onClick: isNow ? null : () => selectRun(taskId, run.run) },
      [
        el("span", { class: "m-drun-num" + (isNow ? " now" : ""), text: run.num }),
        el("span", { class: "m-drun-provider" + (isNow ? " now" : ""), text: run.provider }),
        el("span", { class: "m-drun-t", text: run.duration ?? "—" }),
        el("span", { class: "m-drun-state" + (isNow ? " now" : ""), style: { color: run.stateColor }, text: isNow ? "NOW" : run.state })
      ]
    );
    const note = isNow
      ? null
      : el("div", {
          class: "m-drun-note",
          text: run.error || (run.state === "READY" ? "completed · " + (run.duration ?? "") : run.state.toLowerCase())
        });
    const panel = !isNow && isSelected ? el("div", { class: "m-drun-panel" }, [renderRunPanel(taskId, run, events, accent)]) : null;
    return el("div", { class: "m-drun" }, [head, note, panel].filter(Boolean));
  });

  return el("div", { class: "m-dsection" }, [el("div", { class: "m-dsection-k strong", text: "THIS TASK SO FAR" }), ...items]);
}

function renderMobileDecisionContent(row) {
  const provider = state.providers.find(p => p.id === row.providerId);
  const resumable = provider?.capabilities?.supportsResume === true;
  const value = state.answers.get(row.id) ?? "";
  const textarea = el("textarea", {
    class: "m-danswer",
    rows: 3,
    placeholder: "your answer…",
    "data-focus-key": "m-answer-" + row.id
  });
  textarea.value = value;
  // ANSWER & CONTINUE / SAVE ONLY live in the fixed bottom bar, a sibling
  // subtree built separately (renderMobileActionBar) — toggle them by the
  // marker they share rather than threading a callback through both.
  textarea.addEventListener("input", () => {
    state.answers.set(row.id, textarea.value);
    const has = textarea.value.trim().length > 0;
    document.querySelectorAll("[data-mobile-answer-gate]").forEach(btn => {
      btn.disabled = !has;
    });
  });

  return el("div", {}, [
    row.permWhy ? el("div", { class: "m-dquestion" }, inlineEls(parseInline(row.permWhy))) : null,
    !resumable
      ? el("div", {
          class: "m-dlimit",
          text:
            (provider?.displayName ?? "This provider") +
            " cannot resume sessions — answering records your decision in this run's history."
        })
      : null,
    textarea,
    el("div", { class: "m-danswer-note", text: "Your answer is recorded on the Task, so it survives this run and every run after it." })
  ]);
}

// One content order for every status: the Task's identity, then what it is
// doing or what it produced, then the operational detail on demand. Each
// piece gates itself to null when the status does not carry it — the same
// §10 discipline the desktop ledger already follows.
function renderMobileDetailContent(row, detail, accent, frozen) {
  const parts = [];

  const stateCls = row.halted ? "blue" : row.done ? "dim" : "";
  const stateLabel = row.halted ? row.stateLabel + (row.permType === "decision" ? " · DECISION" : " · PERMISSION") : row.stateLabel;
  parts.push(
    el("div", { class: "m-dtitle-row" }, [
      el("span", { class: "m-dstate " + stateCls, text: stateLabel }),
      el("span", { class: "m-dt", text: row.elapsed })
    ])
  );
  parts.push(el("h1", { class: "m-dtitle" }, inlineEls(parseInline(row.title))));

  if (row.trace) {
    parts.push(el("div", { class: "m-dtrace-wrap" }, [renderTrack(row, accent)]));
  }

  if (row.halted) {
    parts.push(renderMobileHeldMeta(row));
    if (row.permType === "decision") {
      parts.push(renderMobileDecisionContent(row));
    } else {
      parts.push(
        row.permLive
          ? el("div", { class: "m-dmeta", style: { marginTop: "20px" }, text: "agent requested permission" })
          : null
      );
      if (row.permPath) {
        parts.push(
          el("div", { class: "m-dsection first" }, [
            el("div", { class: "m-dresult", style: { marginTop: 0 }, text: "wants to modify" }),
            el("div", { class: "m-dtitle", style: { fontSize: "19px", marginTop: "8px" }, text: row.permPath }),
            row.permWhy ? el("div", { class: "m-dlimit", text: row.permWhy }) : null
          ])
        );
      }
    }
    parts.push(renderMobileActivityBox(row, "WHAT IT WAS DOING", !row.permPath && row.permType !== "decision"));
    parts.push(renderMobileRunHistory(row, detail, accent));
  } else if (row.running) {
    if (row.coarse) {
      parts.push(el("div", { class: "m-dmeta", style: { marginTop: "16px" }, text: "process alive" }));
      parts.push(
        el("div", {
          class: "m-dmeta",
          text: providerDisplayName(row.providerId) + (row.note ? " · " + row.note : "")
        })
      );
    } else {
      const last = row.activitySection?.recent?.at(-1);
      if (last) parts.push(el("div", { class: "m-dmeta", style: { marginTop: "16px", fontSize: "14.5px", letterSpacing: "-.008em", color: COLORS.ink }, text: last.verb + " · " + last.arg }));
      const total = (row.activitySection?.earlier ?? 0) + (row.activitySection?.recent?.length ?? 0);
      parts.push(el("div", { class: "m-dmeta", text: providerDisplayName(row.providerId) + (total ? " · " + total + " EVENTS" : "") }));
    }
    parts.push(renderMobileActivityBox(row, "LATEST", true));
    parts.push(renderMobileFilesBox(row, !row.activitySection?.recent?.length));
    parts.push(renderMobileCommandsBox(row));
    parts.push(renderMobileRunHistory(row, detail, accent));
  } else if (row.ready) {
    parts.push(el("div", { class: "m-dsection first" }, [el("div", { class: "m-dsection-k strong", text: "RESULT" }), renderMobileResult(row, detail)]));
    parts.push(renderMobileFilesBox(row));
    parts.push(renderMobileCommandsBox(row));
    // PROVENANCE / BEFORE THE STOP: renderProvenance already labels itself
    // (the same desktop component); an empty trace (nothing happened before
    // the stop) is silence, not an empty box — matching "no empty or
    // not-reported state to render".
    if (row.provenance?.total > 0) {
      parts.push(el("div", { class: "m-dsection" }, [renderProvenance(row, accent)]));
    }
    parts.push(renderMobileRunHistory(row, detail, accent));
  } else if (row.failed) {
    parts.push(el("div", { class: "m-dmeta", style: { marginTop: "14px", fontSize: "12.5px" }, text: "Run stopped. The Task is still open — nothing was reverted." }));
    parts.push(
      el("div", { class: "m-dsection first" }, [
        el("div", { class: "m-dsection-k strong", text: "STOPPED AT" }),
        el("div", { class: "m-dpre", text: row.error || "Execution failed" })
      ])
    );
    parts.push(renderMobileFilesBox(row));
    // PROVENANCE / BEFORE THE STOP: renderProvenance already labels itself
    // (the same desktop component); an empty trace (nothing happened before
    // the stop) is silence, not an empty box — matching "no empty or
    // not-reported state to render".
    if (row.provenance?.total > 0) {
      parts.push(el("div", { class: "m-dsection" }, [renderProvenance(row, accent)]));
    }
    parts.push(renderMobileRunHistory(row, detail, accent));
  } else if (row.done) {
    parts.push(el("div", { class: "m-dsection first" }, [el("div", { class: "m-dsection-k strong", text: "RESULT" }), renderMobileResult(row, detail)]));
  }

  return parts.filter(Boolean);
}

// Every detail screen ends in a fixed bar: one 52px primary, one secondary.
// Reading scrolls; deciding never does.
function renderMobileActionBar(row, frozen) {
  if (row.halted && row.permType !== "decision") {
    const allowBtn = el("button", { class: "m-abar-btn m-abar-primary", text: "ALLOW", disabled: !row.permAllowable ? true : undefined });
    allowBtn.addEventListener("click", () => {
      allowBtn.disabled = true;
      allow(row.id);
    });
    const rejectBtn = el("button", { class: "m-abar-btn m-abar-secondary", text: "REJECT", disabled: !row.permRejectable ? true : undefined });
    rejectBtn.addEventListener("click", () => {
      rejectBtn.disabled = true;
      reject(row.id);
    });
    return el("div", { class: "m-abar" }, [el("div", { class: "m-abar-row" }, [allowBtn, rejectBtn])]);
  }
  if (row.halted && row.permType === "decision") {
    const value = (state.answers.get(row.id) ?? "").trim();
    const continueBtn = el("button", {
      class: "m-abar-btn m-abar-primary",
      text: "ANSWER & CONTINUE",
      "data-mobile-answer-gate": true,
      disabled: !value ? true : undefined
    });
    continueBtn.addEventListener("click", () => {
      continueBtn.disabled = true;
      answerAndContinue(row.id).finally(() => render());
    });
    const saveBtn = el("button", {
      class: "m-abar-btn m-abar-secondary quiet",
      text: "SAVE ONLY",
      "data-mobile-answer-gate": true,
      disabled: !value ? true : undefined
    });
    saveBtn.addEventListener("click", () => {
      saveBtn.disabled = true;
      answerDecision(row.id).finally(() => render());
    });
    return el("div", { class: "m-abar" }, [
      el("div", { class: "m-abar-row" }, [continueBtn, saveBtn]),
      el("div", { class: "m-abar-hint", text: "a decision is not resumable in place — continuing starts a new run of this Task with your answer in context" })
    ]);
  }
  if (row.running) {
    const btn = el("button", { class: "m-abar-btn m-abar-single", style: { flex: "1" }, text: "ADD A CONSTRAINT" });
    btn.addEventListener("click", () => openCorrection(row.id));
    return el("div", { class: "m-abar" }, [el("div", { class: "m-abar-row" }, [btn])]);
  }
  if (row.ready) {
    const acceptBtn = el("button", { class: "m-abar-btn m-abar-primary", text: "ACCEPT" });
    acceptBtn.addEventListener("click", () => {
      acceptBtn.disabled = true;
      accept(row.id);
    });
    const correctBtn = el("button", { class: "m-abar-btn m-abar-secondary", text: "CORRECT" });
    correctBtn.addEventListener("click", () => openCorrection(row.id));
    return el("div", { class: "m-abar" }, [el("div", { class: "m-abar-row" }, [acceptBtn, correctBtn])]);
  }
  if (row.failed) {
    const runBtn = el("button", { class: "m-abar-btn m-abar-primary", text: "RUN AGAIN" });
    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      sendBack(row.id).finally(() => render());
    });
    const correctBtn = el("button", { class: "m-abar-btn m-abar-secondary", text: "CORRECT" });
    correctBtn.addEventListener("click", () => openCorrection(row.id));
    return el("div", { class: "m-abar" }, [el("div", { class: "m-abar-row" }, [runBtn, correctBtn])]);
  }
  return null;
}

// CORRECTION / ADD A CONSTRAINT: one field, one button. The sheet's own
// sentence is the whole mental model — the note sticks to the Task, and (for
// READY/FAILED) a new run continues it; for a live WORKING task it applies
// without stopping the run.
function renderMobileCorrectionSheet(row) {
  if (mobile.correctionId !== row.id) return null;
  const rerunable = row.ready || row.failed;
  const saved = noteInputs.get(row.id) ?? "";
  const textarea = el("textarea", {
    class: "m-sheet-input",
    rows: 3,
    placeholder: rerunable ? "the approach is right, but…" : "a constraint for the rest of this run…",
    "data-focus-key": "m-correction-" + row.id
  });
  textarea.value = saved;
  const submitBtn = el("button", {
    class: "m-abar-btn m-abar-primary",
    text: rerunable ? "SEND BACK" : "SAVE",
    disabled: !saved.trim() ? true : undefined
  });
  textarea.addEventListener("input", () => {
    noteInputs.set(row.id, textarea.value);
    submitBtn.disabled = textarea.value.trim().length === 0;
  });
  submitBtn.addEventListener("click", () => {
    submitBtn.disabled = true;
    submitCorrection(row.id, { rerun: rerunable }).finally(() => render());
  });
  const acts = [submitBtn];
  if (rerunable) {
    const saveOnlyBtn = el("button", { class: "m-abar-btn m-abar-secondary quiet", text: "SAVE ONLY" });
    saveOnlyBtn.addEventListener("click", () => {
      saveOnlyBtn.disabled = true;
      submitCorrection(row.id, { rerun: false }).finally(() => render());
    });
    acts.push(saveOnlyBtn);
  }

  return el("div", {}, [
    el("div", { class: "m-sheet-overlay", onClick: closeCorrection }),
    el("div", { class: "m-sheet" }, [
      el("div", { class: "m-sheet-head" }, [
        el("span", { class: "m-sheet-kind", text: rerunable ? "CORRECTION" : "CONSTRAINT" }),
        el("span", { class: "m-sheet-cancel", onClick: closeCorrection, text: "CANCEL" })
      ]),
      textarea,
      el("div", {
        class: "m-sheet-note",
        text: rerunable
          ? "Kept on the Task, not on this run. The next run starts from the same task with the correction in context."
          : "Recorded on the Task — applies from here without stopping this run."
      }),
      el("div", { class: "m-sheet-acts" }, acts)
    ])
  ]);
}

function renderMobileDetail(ledger, accent, frozen) {
  const row = ledger.rows.find(r => r.id === mobile.detailId);
  if (!row) return null;
  const detail = state.details?.get(row.id) ?? null;

  const entering = !mobile.closing && mobileDetailMounted !== row.id;
  mobileDetailMounted = row.id;

  const content = renderMobileDetailContent(row, detail, accent, frozen);

  const stickyStrip = el("div", { class: "m-sticky" }, [
    el("div", { class: "m-sticky-inner" }, [
      el("span", { class: "m-sticky-state", text: row.stateLabel }),
      el("span", { class: "m-sticky-title", text: row.title }),
      el("span", { class: "m-sticky-t", text: row.elapsed })
    ])
  ]);

  const dcontent = el("div", { class: "m-dcontent" }, [stickyStrip, ...content]);

  return el(
    "div",
    {
      class:
        "m-detail" +
        (row.halted ? " blue" : "") +
        (entering ? " m-detail-enter" : "") +
        (mobile.closing ? " m-detail-exit" : "")
    },
    [
      renderMobileDetailToolbar(row, ledger, frozen),
      dcontent,
      renderMobileActionBar(row, frozen),
      renderMobileCorrectionSheet(row)
    ]
  );
}

// --- mobile root -------------------------------------------------------------

let mobileOverviewScroll = 0;
let mobileDetailScroll = new Map(); // task id -> scrollTop, so re-opening a screen mid-render keeps its position

function renderMobile() {
  const shell = document.getElementById("shell");
  shell.className = "mobile";
  const frozen = state.remote && !state.macOnline;
  const now = frozen && mobile.offlineSince ? mobile.offlineSince : Date.now();
  const ledger = currentLedger(now);

  const prevScroll = document.querySelector(".m-scroll");
  if (prevScroll) mobileOverviewScroll = prevScroll.scrollTop;
  const prevDcontent = document.querySelector(".m-dcontent");
  if (prevDcontent && mobile.detailId !== null) mobileDetailScroll.set(mobile.detailId, prevDcontent.scrollTop);

  // The Overview stays mounted underneath a pushed Task Detail — "the list
  // holds still underneath" — Task Detail is simply layered over it via
  // position:absolute (see .m-detail).
  const overview = el("div", { class: "m-scroll" }, [renderMobileOverview(ledger, frozen)]);
  const overviewToolbar = renderMobileOverviewToolbar(ledger, frozen);
  const detail = mobile.detailId !== null ? renderMobileDetail(ledger, COLORS.accent, frozen) : null;

  shell.replaceChildren(
    el("div", { class: "m-app" }, [
      renderMobileOfflineBar(),
      renderMobileBar(frozen),
      overviewToolbar,
      overview,
      detail,
      state.flash ? el("div", { class: "flash", text: state.flash }) : null
    ].filter(Boolean))
  );

  const scrollEl = document.querySelector(".m-scroll");
  if (scrollEl) scrollEl.scrollTop = mobileOverviewScroll;
  const dcontentEl = document.querySelector(".m-dcontent");
  if (dcontentEl && mobile.detailId !== null) {
    dcontentEl.scrollTop = mobileDetailScroll.get(mobile.detailId) ?? 0;
    wireMobileStickyDetail(dcontentEl);
  }
}

// The sticky identity strip is the only sticky element inside the scroller.
// It is always present (so its 40px never causes a layout jump), and shown
// only once the real title has scrolled out from under it.
function wireMobileStickyDetail(scrollEl) {
  const sticky = scrollEl.querySelector(".m-sticky");
  const title = scrollEl.querySelector(".m-dtitle");
  if (!sticky || !title) return;
  function update() {
    const hidden = title.getBoundingClientRect().bottom <= scrollEl.getBoundingClientRect().top + 4;
    sticky.classList.toggle("shown", hidden);
  }
  scrollEl.addEventListener("scroll", update, { passive: true });
  update();
}

// Back is an edge swipe (from the left 24px) or the ‹ ALL WORK line. This is
// a lightweight gesture detector, not a live-follow-the-finger drag: it
// fires the same closeMobileDetail() the nav line calls once the swipe
// clears a distance-and-directness threshold.
let mobileEdgeSwipe = null;
window.addEventListener("pointerdown", event => {
  if (!isMobileWidth() || mobile.screen !== "detail" || event.pointerType === "mouse") return;
  if (event.clientX > 24) return;
  mobileEdgeSwipe = { x: event.clientX, y: event.clientY };
});
window.addEventListener("pointerup", event => {
  if (!mobileEdgeSwipe) return;
  const dx = event.clientX - mobileEdgeSwipe.x;
  const dy = Math.abs(event.clientY - mobileEdgeSwipe.y);
  mobileEdgeSwipe = null;
  if (dx > 60 && dy < 60) closeMobileDetail();
});

// --- boot ------------------------------------------------------------------

window.addEventListener("keydown", onKeyDown);
window.addEventListener("resize", () => {
  state.width = window.innerWidth;
  render();
});
// Prime audio after the first real interaction (autoplay policy): a context
// starts suspended until the page has user activation, and only after that
// can background-tab signals sound.
window.addEventListener("pointerdown", () => slash.unlock(), { once: true });
window.addEventListener("keydown", () => slash.unlock(), { once: true });

// The chrome clock ticks every second. A full re-render happens only while
// something is actually running, so an idle ledger stays still.
setInterval(() => {
  if (state.tasks.some(t => t.status === "working")) render();
  else renderClock();
}, 1000);

render();
// Remote mode (the relay serves this page) polls /api/status so the Mac's
// presence is live: MAC OFFLINE banner + disabled actions while it is gone.
checkStatus().then(() => {
  if (state.remote) setInterval(checkStatus, 4000);
});
loadAll()
  .then(() => connect())
  .catch(error => {
    flash(error.message);
    connect();
  });
loadProviders();
