// Work persistence — JSON files under <workspace>/.work.
//
// The store is the only module that knows where tasks live on disk. Actions,
// the CLI, the server, and the worker talk to the store — never to paths
// directly. A future execution node may keep its own store on another
// machine; this store is the local (workspace) one.

import fs from "node:fs/promises";
import path from "node:path";
import { defaultProviderId } from "../providers/index.mjs";
import { WorkError } from "./errors.mjs";

export const cwd = () => process.cwd();

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readText(p, fallback = "") {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return fallback;
  }
}

export async function writeText(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, value, "utf8");
}

export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

export async function writeJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function slugify(input) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

// A store is bound to one workspace (base directory). All paths are derived
// from it, so nothing else has to reason about `.work` layout.
export function createStore(base = process.cwd()) {
  const workDir = () => path.join(base, ".work");
  const tasksDir = () => path.join(workDir(), "tasks");
  const taskDir = slug => path.join(tasksDir(), slug);
  const eventLogPath = slug => path.join(taskDir(slug), "events.jsonl");

  async function listTasks() {
    const dir = tasksDir();
    if (!(await exists(dir))) return [];

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = path.join(dir, entry.name, "task.json");
      if (!(await exists(meta))) continue;
      try {
        out.push(await readJson(meta));
      } catch {
        // v0: ignore malformed folders
      }
    }

    return out.sort((a, b) => b.id - a.id);
  }

  async function createTask(title, prompt, opts = {}) {
    const provider = opts.provider ?? defaultProviderId;
    const node = opts.node ?? "local";
    const workspace = opts.workspace ?? "local";

    const all = await listTasks();
    const id = all.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    const slug = `${String(id).padStart(3, "0")}-${slugify(title)}`;
    const dir = taskDir(slug);
    await fs.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const task = {
      id,
      slug,
      title,
      status: "working",
      execution: { provider, node, workspace },
      createdAt: now,
      updatedAt: now
    };

    await writeJson(path.join(dir, "task.json"), task);
    await writeText(path.join(dir, "prompt.md"), prompt);
    await writeText(path.join(dir, "run.log"), "");
    return task;
  }

  async function findTask(id) {
    const all = await listTasks();
    const task = all.find(t => t.id === Number(id));
    if (!task) throw new WorkError(`Task ${id} not found.`, 404);
    return task;
  }

  async function updateTask(task) {
    task.updatedAt = new Date().toISOString();
    await writeJson(path.join(taskDir(task.slug), "task.json"), task);
    return task;
  }

  async function readTaskResult(task) {
    return readText(path.join(taskDir(task.slug), "result.md"));
  }

  async function readTaskLog(task) {
    return readText(path.join(taskDir(task.slug), "run.log"));
  }

  async function readEventLog(slug) {
    return readText(eventLogPath(slug));
  }

  // Append one normalized Work event (see core/events.mjs) to the task's
  // event log. Called by shared actions (in-process) and by the worker
  // (separate process). The API layer tails this log for live updates.
  async function appendEvent(slug, event) {
    const p = eventLogPath(slug);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(event) + "\n", "utf8");
  }

  return {
    base,
    workDir,
    tasksDir,
    taskDir,
    eventLogPath,
    exists,
    readText,
    writeText,
    readJson,
    writeJson,
    listTasks,
    createTask,
    findTask,
    updateTask,
    readTaskResult,
    readTaskLog,
    readEventLog,
    appendEvent
  };
}
