// Store: persistence under .work — the only module that touches disk layout.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/core/store.mjs";

async function tempWorkspace() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-store-"));
  return base;
}

test("createTask writes task.json/prompt.md/run.log and assigns sequential ids", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const a = await store.createTask({ title: "Fix overflow", brief: "Fix overflow", prompt: "prompt-a" }, { node: "local" });
    const b = await store.createTask({ title: "Investigate replay", brief: "Investigate replay", prompt: "prompt-b" }, { node: "local" });

    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.match(a.slug, /^001-fix-overflow$/);
    assert.equal(a.status, "working");
    assert.equal(a.execution.provider, "claude-code"); // default provider
    assert.equal(a.execution.node, "local");
    assert.equal(a.execution.workspace, "local");

    const dir = store.taskDir(b.slug);
    assert.equal(await store.readText(path.join(dir, "prompt.md")), "prompt-b");
    assert.equal(await store.readText(path.join(dir, "run.log")), "");
    assert.deepEqual(await store.readJson(path.join(dir, "task.json")), b);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("listTasks returns newest id first; findTask looks up by id", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const a = await store.createTask({ title: "One", brief: "One", prompt: "p" });
    const b = await store.createTask({ title: "Two", brief: "Two", prompt: "p" });
    const list = await store.listTasks();
    assert.deepEqual(list.map(t => t.id), [2, 1]);
    assert.equal((await store.findTask(1)).title, "One");
    await assert.rejects(() => store.findTask(99), /Task 99 not found/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("updateTask bumps updatedAt; readTaskResult/readTaskLog read back files", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const task = await store.createTask({ title: "Three", brief: "Three", prompt: "p" });
    await store.writeText(path.join(store.taskDir(task.slug), "result.md"), "all done");
    await store.writeText(path.join(store.taskDir(task.slug), "run.log"), "hello log");

    assert.equal(await store.readTaskResult(task), "all done");
    assert.equal(await store.readTaskLog(task), "hello log");

    const before = task.updatedAt;
    await new Promise(r => setTimeout(r, 5));
    const updated = await store.updateTask({ ...task, status: "ready" });
    assert.equal(updated.status, "ready");
    assert.ok(new Date(updated.updatedAt) > new Date(before));
    assert.equal((await store.findTask(task.id)).status, "ready");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("appendEvent appends normalized JSON lines to events.jsonl", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const task = await store.createTask({ title: "Four", brief: "Four", prompt: "p" });
    await store.appendEvent(task.slug, { type: "task.created", taskId: task.id, at: "t1" });
    await store.appendEvent(task.slug, { type: "run.started", taskId: task.id, at: "t2" });

    const lines = (await store.readEventLog(task.slug)).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "task.created");
    assert.equal(JSON.parse(lines[1]).type, "run.started");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("task state files are written owner-only (0600)", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const task = await store.createTask({ title: "Private", brief: "Private", prompt: "prompt with repo quotes" });
    await store.appendEvent(task.slug, { type: "run.started", taskId: task.id, at: "t" });
    await store.writeJson(path.join(store.taskDir(task.slug), "permission.json"), { grant: "allow" });

    const dir = store.taskDir(task.slug);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, "task dir must be owner-only");
    for (const rel of ["task.json", "prompt.md", "run.log", "events.jsonl", "permission.json"]) {
      const mode = (await fs.stat(path.join(dir, rel))).mode & 0o777;
      assert.equal(mode, 0o600, `${rel} must be owner-only`);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("writeJson/writeText are atomic: temp file + rename, no leftovers, 0600 preserved", async () => {
  const base = await tempWorkspace();
  try {
    const store = createStore(base);
    const dir = path.join(base, ".work", "atomic");
    const p = path.join(dir, "task.json");

    // First write creates the directory, the file, and the JSON shape
    // (indented, trailing newline) at 0600.
    await store.writeJson(p, { a: 1 });
    assert.equal((await fs.stat(p)).mode & 0o777, 0o600);
    assert.equal(await store.readText(p), JSON.stringify({ a: 1 }, null, 2) + "\n");
    assert.deepEqual(await store.readJson(p), { a: 1 });

    // Overwrite replaces the whole file atomically — no partial content.
    await store.writeJson(p, { b: 2, note: "x\n" });
    assert.deepEqual(await store.readJson(p), { b: 2, note: "x\n" });
    assert.equal((await fs.stat(p)).mode & 0o777, 0o600, "mode must survive the rename");

    // writeText behaves the same.
    const t = path.join(dir, "notes.md");
    await store.writeText(t, "hello\nworld");
    assert.equal(await store.readText(t), "hello\nworld");
    assert.equal((await fs.stat(t)).mode & 0o777, 0o600);

    // No temp files are left behind in the directory.
    const entries = (await fs.readdir(dir)).sort();
    assert.deepEqual(entries, ["notes.md", "task.json"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
