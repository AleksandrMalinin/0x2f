// Normalized event model: the shared vocabulary between Work Core, the
// Web API (SSE), the CLI, and future TUI/desktop clients.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVENT_TYPES,
  normalizeEvent,
  workEvent,
  createBus,
  createTailer
} from "../src/core/events.mjs";

test("event model exposes exactly the normalized Work event types", () => {
  assert.deepEqual(EVENT_TYPES, [
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
  ]);
});

test("normalizeEvent stamps type and timestamp; rejects unknown types", () => {
  const event = normalizeEvent("task.created", { taskId: 3 });
  assert.equal(event.type, "task.created");
  assert.equal(event.taskId, 3);
  assert.ok(Date.parse(event.at));
  assert.throws(() => normalizeEvent("claude.whatever", {}), /Unknown Work event type/);
});

test("workEvent attaches a taskId", () => {
  const event = workEvent("run.started", 7, { sessionId: "s-1" });
  assert.equal(event.type, "run.started");
  assert.equal(event.taskId, 7);
  assert.equal(event.sessionId, "s-1");
});

test("bus fans events out and supports unsubscribe", () => {
  const bus = createBus();
  const received = [];
  const off = bus.on(event => received.push(event.type));
  bus.emit({ type: "task.created", at: "x" });
  bus.emit({ type: "task.updated", at: "x" });
  assert.deepEqual(received, ["task.created", "task.updated"]);
  off();
  bus.emit({ type: "task.closed", at: "x" });
  assert.deepEqual(received, ["task.created", "task.updated"]);
});

test("tailer emits each new log line exactly once, in order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-events-"));
  const logPath = path.join(dir, "events.jsonl");

  const readLines = async () => {
    try {
      const text = await fs.readFile(logPath, "utf8");
      return [{ slug: "001-x", text }];
    } catch {
      return [];
    }
  };

  const received = [];
  const tailer = createTailer({ readLines, emit: e => received.push(e), interval: 10 });
  tailer.start();

  try {
    await fs.appendFile(
      logPath,
      JSON.stringify(workEvent("run.started", 1)) + "\n" +
        JSON.stringify(workEvent("progress", 1, { text: "hi" })) + "\n",
      "utf8"
    );
    await waitFor(() => received.length === 2);

    assert.deepEqual(received.map(e => e.type), ["run.started", "progress"]);
    assert.equal(received[0].taskId, 1);

    // Appending more only emits the NEW lines.
    await fs.appendFile(logPath, JSON.stringify(workEvent("task.updated", 1, { status: "ready" })) + "\n", "utf8");
    await waitFor(() => received.length === 3);
    assert.equal(received[2].type, "task.updated");
    assert.equal(received[2].status, "ready");
  } finally {
    tailer.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tailer does not consume a partial line until it is complete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-events-"));
  const logPath = path.join(dir, "events.jsonl");
  const readLines = async () => {
    try {
      const text = await fs.readFile(logPath, "utf8");
      return [{ slug: "001-x", text }];
    } catch {
      return [];
    }
  };
  const received = [];
  const tailer = createTailer({ readLines, emit: e => received.push(e), interval: 10 });
  tailer.start();
  try {
    // A line without a trailing newline = still being written.
    await fs.appendFile(logPath, JSON.stringify(workEvent("run.started", 1)) + "\n", "utf8");
    await waitFor(() => received.length === 1);
    assert.equal(received[0].type, "run.started");

    // Write the partial second line, then complete it — both must be delivered.
    await fs.appendFile(logPath, JSON.stringify(workEvent("progress", 1, { text: "partial" })).slice(0, 20), "utf8");
    await new Promise(r => setTimeout(r, 60));
    assert.equal(received.length, 1); // partial line NOT consumed

    await fs.appendFile(logPath, JSON.stringify(workEvent("progress", 1, { text: "partial" })).slice(20) + "\n", "utf8");
    await waitFor(() => received.length === 2);
    assert.equal(received[1].type, "progress");
    assert.equal(received[1].text, "partial");
  } finally {
    tailer.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tailer ignores malformed lines without breaking the stream", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-events-"));
  const logPath = path.join(dir, "events.jsonl");
  const readLines = async () => {
    try {
      const text = await fs.readFile(logPath, "utf8");
      return [{ slug: "001-x", text }];
    } catch {
      return [];
    }
  };
  const received = [];
  const tailer = createTailer({ readLines, emit: e => received.push(e), interval: 10 });
  tailer.start();
  try {
    await fs.appendFile(logPath, "not-json\n" + JSON.stringify(workEvent("task.created", 1)) + "\n", "utf8");
    await waitFor(() => received.length === 1);
    assert.equal(received[0].type, "task.created");
  } finally {
    tailer.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function waitFor(condition, timeout = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await new Promise(r => setTimeout(r, 10));
  }
}
