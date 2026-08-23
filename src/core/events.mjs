// Normalized Work events — the only event vocabulary the rest of Work knows.
//
// Provider-specific shapes stop at the provider boundary. Anything that
// reaches this module is a Work concept, so a TUI, desktop client, or a
// future execution node can observe Work state without knowing which
// provider or machine produced it.
//
// Event log = append-only JSON lines at <workspace>/.work/tasks/<slug>/events.jsonl
//   - actions append task-level events (task.created / task.updated /
//     task.closed) when they mutate state;
//   - the execution worker appends run-level events (run.started, progress,
//     tool.started, file.changed, needs_user, run.completed, run.failed);
//   - any live client (SSE today, TUI tomorrow) tails the log through the
//     runtime/API — clients never read provider output directly.
//
// Live delivery: a bus fans events out to in-process subscribers. The API
// layer runs a tailer that turns new log lines into bus events, so events
// written by OTHER processes (a CLI running `2f allow` while the Web UI is
// open) reach every connected client too.

export const EVENT_TYPES = Object.freeze([
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
]);

// Normalize any event into a Work event. `data` carries the event payload
// plus `taskId` (see workEvent below).
export function normalizeEvent(type, data = {}) {
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`Unknown Work event type: ${type}`);
  }
  return { type, at: new Date().toISOString(), ...data };
}

// Shorthand for events that belong to a task.
export function workEvent(type, taskId, data = {}) {
  return normalizeEvent(type, { taskId, ...data });
}

// In-memory fan-out for live subscribers (SSE connections today, a future
// TUI or desktop client tomorrow). One bus per runtime.
export function createBus() {
  const listeners = new Set();
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

// Turns an append-only JSON-lines event log into live bus events.
//
//   readLines() -> Promise<[{ slug, text }]>   (raw file content per task)
//   emit(event) -> called once per new complete line, in order.
//
// Tracks a byte offset per slug and only consumes lines terminated by "\n",
// so a line that is still being written is retried on the next tick instead
// of being half-parsed and skipped forever. A second subscriber (or a
// reconnect) never replays old events through this path — clients fetch
// current state on connect and only need live deltas here.
export function createTailer({ readLines, emit, interval = 250 }) {
  const seen = new Map(); // slug -> bytes consumed through the last "\n"
  let timer = null;

  async function tick() {
    let files;
    try {
      files = await readLines();
    } catch {
      return; // transient read error — retry next tick
    }
    for (const { slug, text } of files) {
      const offset = seen.get(slug) ?? 0;
      const tail = text.slice(offset);
      const lastNewline = tail.lastIndexOf("\n");
      if (lastNewline < 0) continue; // no complete line yet
      const complete = tail.slice(0, lastNewline + 1);
      for (const line of complete.split("\n")) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // not a Work event line — ignore
        }
        if (event && typeof event.type === "string") emit(event);
      }
      seen.set(slug, offset + complete.length);
    }
  }

  return {
    start() {
      if (!timer) {
        tick();
        timer = setInterval(tick, interval);
      }
      return this;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return this;
    }
  };
}
