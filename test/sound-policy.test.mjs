// Sound policy — the pure rules behind 0x2F's one sound.
//
// The policy decides WHEN a gesture is earned (a genuine ready / needs_you
// transition, deduped and batched) and when it is not (progress, working,
// replayed history, duplicates of the same transition). These tests pin the
// "events are many, interruptions are few" contract: no bursts, no replays.

import test from "node:test";
import assert from "node:assert/strict";
import { createSoundPolicy } from "../src/web/sound-policy.mjs";

// A policy whose clock and timers are fully controlled. `advance(ms)` moves
// the clock and fires any window timers that have come due, in order.
function harness(opts = {}) {
  const callbacks = [];
  let clock = 1000;
  const timers = [];
  const policy = createSoundPolicy({
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
    cancel: timer => {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    },
    onIntent: intent => callbacks.push(intent),
    windowMs: 500,
    ...opts
  });
  const at = ms => new Date(clock + ms).toISOString();
  return {
    policy,
    callbacks,
    event(type, taskId, extra = {}) {
      policy.observe({ type, taskId, at: at(0), ...extra });
    },
    advance(ms) {
      clock += ms;
      for (const timer of [...timers]) {
        if (timer.at <= clock) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      }
    },
    flush() {
      return policy.flush();
    }
  };
}

const seedTasks = (...statuses) =>
  statuses.map((status, i) => ({ id: i + 1, status }));

test("seeded tasks never sound — a task already READY at seed stays silent", () => {
  const h = harness();
  h.policy.seed(seedTasks("ready"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, []);
});

test("working -> ready via run.completed earns one READY intent", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("run.completed", 1, { status: "ready" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "ready", taskId: 1 }]);
});

test("one transition arriving as several events sounds once (dedupe)", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("run.completed", 1, { status: "ready" });
  h.event("task.updated", 1, { status: "ready" }); // same transition
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "ready", taskId: 1 }]);
});

test("needs_user plus its task.updated sounds once (dedupe)", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("needs_user", 1, { reason: "permission" });
  h.event("task.updated", 1, { status: "needs_you" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "needs_you", taskId: 1 }]);
});

test("several tasks READY within the window produce ONE gesture", () => {
  const h = harness();
  h.policy.seed(seedTasks("working", "working", "working"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(100);
  h.event("task.updated", 2, { status: "ready" });
  h.advance(100);
  h.event("task.updated", 3, { status: "ready" });
  h.advance(1000);
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.callbacks[0].type, "ready");
});

test("NEEDS YOU beats a pending READY in the same window", () => {
  const h = harness();
  h.policy.seed(seedTasks("working", "working"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(100);
  h.event("needs_user", 2, { reason: "permission" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "needs_you", taskId: 2 }]);
});

test("READY arriving while NEEDS YOU is pending stays NEEDS YOU", () => {
  const h = harness();
  h.policy.seed(seedTasks("working", "working"));
  h.event("needs_user", 1, { reason: "permission" });
  h.advance(100);
  h.event("task.updated", 2, { status: "ready" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "needs_you", taskId: 1 }]);
});

test("a re-entry after working is a NEW transition, not a replay", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("needs_user", 1, { reason: "permission" });
  h.advance(1000); // first halt: one gesture
  h.event("task.updated", 1, { status: "working" }); // human answered
  h.event("needs_user", 1, { reason: "permission" }); // halted again
  h.advance(1000);
  assert.deepEqual(h.callbacks, [
    { type: "needs_you", taskId: 1 },
    { type: "needs_you", taskId: 1 }
  ]);
});

test("separate windows stay separate gestures", () => {
  const h = harness();
  h.policy.seed(seedTasks("working", "working"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(1000); // window 1 fires
  h.event("task.updated", 2, { status: "ready" }); // well after
  h.advance(1000); // window 2 fires
  assert.equal(h.callbacks.length, 2);
});

test("stale replayed events (written before the seed) are ignored", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  // A replayed event whose `at` predates the seed, e.g. a restarted server's
  // tailer re-reading its logs after reconnect.
  const stale = new Date(500).toISOString(); // before the seed moment (1000)
  h.policy.observe({ type: "task.updated", taskId: 1, status: "ready", at: stale });
  h.advance(1000);
  assert.deepEqual(h.callbacks, []);
});

test("a genuine transition after the seed is not filtered by the replay guard", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("task.updated", 1, { status: "ready" }); // at >= seed moment
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "ready", taskId: 1 }]);
});

test("reseed (reconnect) suppresses a transition the fresh state already shows", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(1000);
  assert.equal(h.callbacks.length, 1);
  // Reconnect: the task list now shows READY; a replay of the same event must
  // stay silent.
  h.policy.seed(seedTasks("ready"));
  h.event("task.updated", 1, { status: "ready" });
  h.advance(1000);
  assert.equal(h.callbacks.length, 1);
});

test("normal execution makes no sound — and failed is tracked, not signalled", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("run.started", 1, { sessionId: "s" });
  h.event("progress", 1, { text: "looking" });
  h.event("tool.started", 1, { name: "Read" });
  h.event("file.changed", 1, { path: "a.mjs" });
  h.event("task.updated", 1, { status: "working" });
  h.event("run.failed", 1, { error: "boom" });
  h.event("task.updated", 1, { status: "failed" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, []);
  // ... but failed is tracked: a later ready is still a transition.
  h.event("task.updated", 1, { status: "ready" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, [{ type: "ready", taskId: 1 }]);
});

test("task.closed and task.created are silent", () => {
  const h = harness();
  h.policy.seed(seedTasks());
  h.event("task.created", 1, { status: "working" });
  h.advance(1000);
  h.policy.seed(seedTasks("ready"));
  h.event("task.closed", 1, { status: "done" });
  h.advance(1000);
  assert.deepEqual(h.callbacks, []);
});

test("flush fires a pending intent immediately (test seam)", () => {
  const h = harness();
  h.policy.seed(seedTasks("working"));
  h.event("task.updated", 1, { status: "ready" });
  const fired = h.flush();
  assert.deepEqual(fired, { type: "ready", taskId: 1 });
  assert.deepEqual(h.callbacks, [{ type: "ready", taskId: 1 }]);
  assert.equal(h.flush(), null); // nothing left
});
