// Sound policy — WHEN 0x2F may make a sound, never HOW.
//
// The principle: events are many, interruptions are few. Normal execution
// (progress, tool calls, routing, WORKING) is silent. Only transitions that
// cross the boundary between autonomous work and human attention may signal:
//
//   ready       work finished, no immediate action required
//   needs_you   autonomous execution reached the human boundary
//
// This module is pure (no DOM, no Web Audio) so the rules are testable in
// Node, exactly like ledger.mjs. The Web client feeds it every normalized
// event it receives over SSE; it emits at most one intent per batching window
// and never replays a transition the current session already observed.
//
// Duplicate/replay sources this module absorbs:
//   - one transition arrives as several events (run.completed + task.updated,
//     or needs_user + task.updated) — deduped by (taskId, status);
//   - a reconnected SSE stream can redeliver old events (a restarted server's
//     tailer re-reads its logs) — events written before the last state seed
//     (`at` older than the seed moment) are ignored;
//   - page reload / reconnect reseeds the baseline from the task list, so a
//     task that is already READY on screen never sounds again.
//
// Batching: one gesture per window. Several tasks reaching the same boundary
// close together collapse into one gesture; needs_you always beats a pending
// ready.

export function createSoundPolicy(opts = {}) {
  const windowMs = opts.windowMs ?? 600;
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? (handle => clearTimeout(handle));
  let onIntent = opts.onIntent ?? (() => {});

  // taskId -> last status observed this session. Seeded from the task list so
  // "what changed" is judged against real state, not against an empty map.
  let statuses = new Map();
  // Events written before this moment belong to state the seed already saw.
  let baselineAt = 0;
  // The batched intent waiting out its window: one gesture per window.
  let pending = null;

  function seed(tasks) {
    statuses = new Map();
    for (const task of tasks ?? []) {
      if (task && task.id !== undefined && task.id !== null) {
        statuses.set(task.id, task.status);
      }
    }
    baselineAt = now();
  }

  // The status a normalized event implies for its task, or null.
  function statusOf(event) {
    if (event.type === "task.updated" && typeof event.status === "string") {
      return event.status;
    }
    if (event.type === "run.completed" && event.status === "ready") return "ready";
    if (event.type === "needs_user") return "needs_you";
    return null;
  }

  // A genuine boundary transition, or null. Updates the status ledger for
  // every status so a later re-entry (needs_you -> working -> needs_you) is
  // recognized as a NEW transition.
  function transitionOf(event) {
    const id = event?.taskId;
    if (id === undefined || id === null) return null;
    // Replay guard: an event written BEFORE the last seed is state the seed
    // already reflects (reconnected SSE, restarted server tailer). Server and
    // browser share one clock (localhost), so a fresh event always has
    // `at >= baselineAt`.
    const at = event.at ? Date.parse(event.at) : null;
    if (at !== null && Number.isFinite(at) && at < baselineAt) return null;
    const status = statusOf(event);
    if (status === null) return null;
    if (statuses.get(id) === status) return null; // already there — dedupe
    statuses.set(id, status);
    if (status !== "ready" && status !== "needs_you") return null;
    return { type: status, taskId: id };
  }

  // Feed one normalized event. Returns nothing; intents arrive via onIntent
  // after the batching window.
  function observe(event) {
    const transition = transitionOf(event);
    if (!transition) return;
    if (pending) {
      // Absorb into the current window. needs_you is the priority gesture —
      // it also becomes the intent's task, so a notification points at the
      // task that actually needs the human.
      if (transition.type === "needs_you") {
        pending.intent.type = "needs_you";
        pending.intent.taskId = transition.taskId;
      }
      return;
    }
    const intent = { type: transition.type, taskId: transition.taskId };
    pending = { intent, timer: null };
    pending.timer = schedule(() => {
      const fired = pending?.intent ?? null;
      pending = null;
      if (fired) onIntent(fired);
    }, windowMs);
  }

  return {
    seed,
    observe,
    // Test seam: fire any pending intent now.
    flush() {
      if (!pending) return null;
      cancel(pending.timer);
      const fired = pending.intent;
      pending = null;
      onIntent(fired);
      return fired;
    }
  };
}
