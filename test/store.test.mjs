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
    const a = await store.createTask("Fix overflow", "prompt-a", { node: "local" });
    const b = await store.createTask("Investigate replay", "prompt-b", { node: "local" });

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
    const a = await store.createTask("One", "p");
    const b = await store.createTask("Two", "p");
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
    const task = await store.createTask("Three", "p");
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
    const task = await store.createTask("Four", "p");
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
