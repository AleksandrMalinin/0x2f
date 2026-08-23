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
  two
} from "/app/ledger.mjs";

const EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.closed",
  "run.started",
  "progress",
  "tool.started",
  "file.changed",
  "needs_user",
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
  "run.completed",
  "run.failed"
]);

const MAX_EVENTS_PER_TASK = 2000;

const state = {
  tasks: [],
  eventsByTask: new Map(),
  seen: new Map(),
  openId: null,
  selectedId: null,
  inspectId: null,
  connected: false,
  width: window.innerWidth,
  base: "",
  flash: null
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

// --- transport -------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
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

function post(path) {
  return api(path, { method: "POST" });
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
  render();
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

const allow = id => act(() => post("/api/tasks/" + id + "/allow"));
const reject = id => act(() => post("/api/tasks/" + id + "/reject"));
const accept = id =>
  act(async () => {
    await post("/api/tasks/" + id + "/close");
    if (state.openId === id) state.openId = null;
  });

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

// --- ledger rendering ------------------------------------------------------

function trackCell(cell, accent) {
  const parts = [];
  if (cell.isHead) {
    parts.push(
      el("div", {
        class: "track-head",
        style: { width: cell.w, background: accent, boxShadow: "0 0 9px " + accent + "70" }
      })
    );
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
  }
  parts.push(el("div", { class: "fill", style: { height: cell.h, background: cell.c } }));
  return el("div", { class: "track-cell", style: { width: cell.w } }, parts);
}

function renderTrack(row, accent) {
  const wash = el("div", {
    class: "track-wash",
    style: {
      width: row.doneW,
      background: "linear-gradient(180deg, rgba(47,95,168,0) 40%, " + accent + "1f 100%)"
    }
  });

  const track = el(
    "div",
    { class: "track" },
    row.groups.map(group =>
      el("div", { class: "track-group" }, group.cells.map(cell => trackCell(cell, accent)))
    )
  );

  const marks = el(
    "div",
    { class: "track-marks" },
    row.marks.map(mark => el("span", { style: { left: mark.x, background: mark.c } }))
  );

  const labels = el(
    "div",
    { class: "track-labels" },
    row.groups.map(group =>
      el("div", { class: "track-label", style: { width: group.w, color: group.lc }, text: group.label })
    )
  );

  return el("div", { class: "track-wrap" }, [
    wash,
    track,
    el("div", { class: "track-axis" }),
    marks,
    labels
  ]);
}

function renderMini(row, accent) {
  return el(
    "div",
    { class: "compact-mini" },
    row.mini.map(group =>
      el(
        "div",
        { class: "mini-group" },
        group.cells.map(cell =>
          el("span", { style: { width: cell.w, height: cell.h, background: cell.c, flex: "none" } })
        )
      )
    )
  );
}

function actionButton(label, key, cls, onClick, focusKey) {
  return el(
    "button",
    { class: "act " + cls, onClick, "data-focus-key": focusKey },
    [label + " ", el("span", { class: "key", text: key })]
  );
}

function renderHalt(row, accent) {
  const acts = [
    actionButton("ALLOW", "A", "act-primary", e => {
      e.stopPropagation();
      allow(row.id);
    }, "allow-" + row.id)
  ];
  if (row.permDetail) {
    acts.push(
      actionButton("INSPECT", "I", "act-outline", e => {
        e.stopPropagation();
        toggleInspect(row.id);
      }, "inspect-" + row.id)
    );
  }
  acts.push(
    actionButton("REJECT", "R", "act-quiet", e => {
      e.stopPropagation();
      reject(row.id);
    }, "reject-" + row.id)
  );

  return el(
    "div",
    { class: "halt-card", style: { border: "1px solid " + accent } },
    [
      el("div", { class: "halt-kind", style: { color: accent }, text: row.permTitle }),
      row.permPath ? el("div", { class: "halt-verb", text: "wants to modify" }) : null,
      row.permPath ? el("div", { class: "halt-path", text: row.permPath }) : null,
      row.permWhy ? el("div", { class: "halt-why", text: row.permWhy }) : null,
      state.inspectId === row.id && row.permDetail
        ? el("div", { class: "halt-detail", text: row.permDetail })
        : null,
      el("div", { class: "acts" }, acts)
    ]
  );
}

function renderBands(row) {
  return el(
    "div",
    { class: "bands" },
    row.bands.map(band =>
      el("div", { class: "band", style: { borderTop: band.rule } }, [
        el("div", { class: "band-left" }, [
          el("div", {
            class: "band-label",
            style: { color: band.labelColor, fontWeight: band.labelWeight },
            text: band.label
          }),
          el("div", { class: "band-meta", text: band.meta })
        ]),
        el(
          "div",
          { class: "band-right" },
          band.items
            .map(item =>
              el("div", { class: "band-item" }, [
                el("span", { class: "band-verb", style: { color: item.vc }, text: item.verb }),
                el("span", {
                  class: "band-arg" + (item.human ? " human" : ""),
                  style: { color: item.ac },
                  text: item.arg
                }),
                el("span", { class: "band-t", text: item.t })
              ])
            )
            .concat(
              band.pending
                ? [
                    el("div", {
                      class: "band-pending",
                      style: { color: band.pendingColor },
                      text: band.pendingText
                    })
                  ]
                : []
            )
        )
      ])
    )
  );
}

function renderResult(row, detail) {
  const files = row.files.map(path =>
    el("div", { class: "result-file" }, [el("span", { text: path })])
  );

  const body = detail && detail.result && detail.result.trim()
    ? el("div", { class: "result-body", text: detail.result.trim() })
    : row.error
      ? el("div", { class: "result-body", style: { color: COLORS.fail }, text: row.error })
      : el("div", { class: "band-pending", style: { color: COLORS.muted }, text: "no written result" });

  const acts = row.ready
    ? el("div", { class: "acts" }, [
        actionButton("ACCEPT", "A", "act-primary", e => {
          e.stopPropagation();
          accept(row.id);
        }, "accept-" + row.id)
      ])
    : null;

  return el("div", { class: "result" }, [
    el("div", {}, [
      el("div", { class: "result-k", text: row.failed ? "FAILURE" : "RESULT" }),
      el("div", { class: "result-n" }, [
        two(row.files.length),
        el("small", { text: row.files.length === 1 ? "FILE CHANGED" : "FILES CHANGED" })
      ])
    ]),
    el("div", { class: "band-right" }, files.concat([body, acts].filter(Boolean)))
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
          style: { fontSize: row.titleSize, fontWeight: row.titleWeight, color: row.titleColor },
          text: row.title
        }),
        el("span", { class: "compact-sub", style: { color: row.subColor }, text: row.sub }),
        renderMini(row, accent),
        el("span", { class: "compact-state", style: { color: row.stateColor }, text: row.stateLabel })
      ]
    );
  } else {
    const detail = state.details?.get(row.id);
    body = el("div", { style: { padding: row.pad } }, [
      el("div", { class: "detail-head", onClick: () => toggleOpen(row.id) }, [
        el("h1", { class: "detail-title", style: { fontSize: row.titleSize }, text: row.title }),
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
      row.halted ? renderHalt(row, accent) : null,
      renderBands(row),
      row.ready || row.failed || row.done ? renderResult(row, detail) : null
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

  return el("div", { class: "chrome" }, [
    el("div", { class: "chrome-inner" }, [
      el("div", { class: "brand" }, [
        el("span", { class: "brand-mark", text: "0x2F" }),
        el("span", { class: "brand-slash", text: "/" }),
        el("span", { class: "brand-scope", text: "LOCAL" }),
        el("span", { class: "chrome-div" }),
        el("span", { class: "runtime" }, [
          el("span", { class: "runtime-label", text: "RUNTIME" }),
          el("span", { class: "runtime-dot" + (state.connected ? "" : " off") }),
          el("span", { class: "runtime-host", text: location.host })
        ])
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

// The composer is built ONCE and kept across renders: re-creating it would
// reset the caret and drop a half-typed task every time an event lands.
function buildComposer() {
  const input = el("input", {
    placeholder: "what needs doing?",
    autocomplete: "off",
    spellcheck: "false"
  });
  const hint = el("span", { class: "composer-hint", text: "BACKGROUND JOB" });

  // Provider selection is deliberately secondary: tasks are first. The
  // select defaults to the runtime default provider and is populated from
  // /api/providers, so adding a provider needs no client change.
  const select = el("select", {
    class: "composer-provider",
    "aria-label": "execution provider",
    title: "execution provider"
  });
  providerSelect = select;

  input.addEventListener("input", () => {
    const armed = input.value.trim().length > 0;
    hint.textContent = armed ? "ENTER TO RUN" : "BACKGROUND JOB";
    hint.className = "composer-hint" + (armed ? " armed" : "");
  });

  input.addEventListener("keydown", async event => {
    if (event.key === "Escape") {
      input.blur();
      return;
    }
    if (event.key !== "Enter") return;
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    input.dispatchEvent(new Event("input"));
    const provider = providerSelect?.value || undefined;
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
  });

  composerInput = input;
  adapterNode = el("span", { class: "legend-adapter" });

  return el("div", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [
      el("span", { class: "composer-k", text: "SUBMIT" }),
      el("span", { class: "composer-caret" }),
      select,
      input,
      hint
    ]),
    el("div", { class: "legend" }, [
      el("div", { class: "legend-inner" }, [
        el("span", { text: "J K SELECT" }),
        el("span", { text: "\u21b5 OPEN" }),
        el("span", { text: "A ALLOW / ACCEPT" }),
        el("span", { text: "R REJECT" }),
        el("span", { text: "I INSPECT" }),
        el("span", { text: "/ SUBMIT" }),
        el("span", { text: "ESC COLLAPSE" }),
        adapterNode
      ])
    ])
  ]);
}

// Populate the composer's provider select. The first entry is the runtime
// default (claude-code today); a failure leaves the select empty and submits
// fall back to the server default, so provider choice never blocks a task.
async function loadProviders() {
  if (!providerSelect) return;
  try {
    const providers = await api("/api/providers");
    providerSelect.replaceChildren(
      ...providers.map(p =>
        el("option", { value: p.id, text: p.id.toUpperCase() })
      )
    );
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

// --- render loop -----------------------------------------------------------

let scrollTop = 0;
let clockNode = null;

function currentLedger() {
  return projectLedger(state.tasks, Object.fromEntries(state.eventsByTask), {
    now: Date.now(),
    openId: state.openId,
    selectedId: state.selectedId,
    wide: state.width >= 1180,
    mid: state.width >= 900,
    accent: COLORS.accent,
    base: state.base
  });
}

function render() {
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

  shell.replaceChildren(
    renderChrome(ledger, accent),
    scroll,
    composerNode,
    ...(state.flash ? [el("div", { class: "flash", text: state.flash })] : [])
  );

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
    if (row?.halted) allow(row.id);
    else if (row?.ready) accept(row.id);
  } else if (event.key === "r" || event.key === "R") {
    if (row?.halted) reject(row.id);
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

// --- boot ------------------------------------------------------------------

window.addEventListener("keydown", onKeyDown);
window.addEventListener("resize", () => {
  state.width = window.innerWidth;
  render();
});

// The chrome clock ticks every second. A full re-render happens only while
// something is actually running, so an idle ledger stays still.
setInterval(() => {
  if (state.tasks.some(t => t.status === "working")) render();
  else renderClock();
}, 1000);

render();
loadAll()
  .then(() => connect())
  .catch(error => {
    flash(error.message);
    connect();
  });
loadProviders();
