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

// Task state is private: it contains the user's task prompts, results and
// notes, which may quote repository code. Write with mode 0600 (owner-only)
// and re-chmod even when the file already exists, so a pre-existing file left
// world-readable by an older version is tightened.
const PRIVATE_FILE = { encoding: "utf8", mode: 0o600 };

export async function writeText(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, value, PRIVATE_FILE);
  await fs.chmod(p, 0o600);
}

export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

export async function writeJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", PRIVATE_FILE);
  await fs.chmod(p, 0o600);
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

  // createTask({ title, brief, prompt }, opts)
  //
  //   brief   the user's own words, verbatim — the task's intent
  //   title   the short label DERIVED from it (core/title.mjs)
  //   prompt  the assembled agent input (project context + the brief)
  //
  // Three artifacts, one authored by the user. `brief` is persisted on the
  // task record because every surface needs it (a detail view shows it, the
  // relay projects it); prompt.md stays the agent-facing assembly.
  async function createTask({ title, brief, prompt }, opts = {}) {
    const provider = opts.provider ?? defaultProviderId;
    const node = opts.node ?? "local";
    const workspace = opts.workspace ?? "local";
    const model = opts.model;
    // The task's initial run records (core/runs.mjs shape). Written by the
    // action, persisted here; a task created before run history simply has
    // none and is interpreted as one historical run.
    const runs = opts.runs;

    const all = await listTasks();
    const id = all.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    const slug = `${String(id).padStart(3, "0")}-${slugify(title)}`;
    const dir = taskDir(slug);
    await fs.mkdir(dir, { recursive: true });
    // The task directory is owner-only too: its listing would reveal task
    // slugs to other local users even though the files are unreadable.
    await fs.chmod(dir, 0o700).catch(() => {});

    const now = new Date().toISOString();
    const task = {
      id,
      slug,
      title,
      // The user's own words. A task written before this field existed has
      // only `title` (which WAS the full text then), so every reader falls
      // back to `task.brief ?? task.title` — correct for old tasks by
      // construction, and no migration is needed.
      brief,
      status: "working",
      execution: {
        provider,
        node,
        workspace,
        // Model is a separate concern from provider/harness. Only persisted
        // when reliably known (e.g. an explicit selection); providers that
        // don't surface their model leave it absent.
        ...(model ? { model } : {})
      },
      // Run history is persisted data, not reconstructed from UI history.
      // An existing task without this array is interpreted as one historical
      // run (core/runs.mjs) and never rewritten unnecessarily.
      ...(runs ? { runs } : {}),
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

  // One run's written result. Persisted runs keep their result in
  // runs/<n>/result.md under the task dir; the synthesized legacy run (and
  // any run without a per-run file) reads the task-level result.md, exactly
  // as before runs existed.
  async function readRunResult(task, runRecord) {
    if (!runRecord || runRecord.legacy) return readTaskResult(task);
    return readText(
      path.join(taskDir(task.slug), "runs", String(runRecord.run), "result.md")
    );
  }

  // One run's generated input, persisted at runs/<n>/prompt.md so the exact
  // prompt a provider session received is auditable per run. Written by the
  // actions when a run starts (createWork writes run 1, rerunWork builds the
  // continuation prompt from current Task state). The task-level prompt.md —
  // the ORIGINAL task request — is never overwritten.
  async function writeRunPrompt(task, run, prompt) {
    await writeText(
      path.join(taskDir(task.slug), "runs", String(run), "prompt.md"),
      prompt
    );
  }

  // Read one run's generated input; null when the run predates per-run
  // prompts (the worker then falls back to the original prompt.md).
  async function readRunPrompt(task, run) {
    const p = path.join(taskDir(task.slug), "runs", String(run), "prompt.md");
    return (await exists(p)) ? readText(p) : null;
  }

  async function readTaskLog(task) {
    return readText(path.join(taskDir(task.slug), "run.log"));
  }

  async function readEventLog(slug) {
    return readText(eventLogPath(slug));
  }

  // The task's normalized event log as parsed events (append-only JSON lines).
  // Unparseable lines are skipped exactly as the live tailer skips them.
  async function readEvents(slug) {
    const text = await readEventLog(slug);
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event.type === "string") events.push(event);
      } catch {
        // not a Work event line — ignore
      }
    }
    return events;
  }

  // Append one normalized Work event (see core/events.mjs) to the task's
  // event log. Called by shared actions (in-process) and by the worker
  // (separate process). The API layer tails this log for live updates.
  async function appendEvent(slug, event) {
    const p = eventLogPath(slug);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(event) + "\n", "utf8");
    // The event log may carry tool inputs and prose that quote repository
    // content — keep it owner-only even when created via append.
    await fs.chmod(p, 0o600).catch(() => {});
  }

  // The interactive-permission channel: the human's ALLOW/REJECT for a live
  // permission request. The running worker's provider polls this file and
  // answers the outstanding request in place (the task dir's permission.json).
  async function writePermissionDecision(task, decision) {
    await writeJson(
      path.join(taskDir(task.slug), "permission.json"),
      decision
    );
  }

  // A decision answer: the human's response to a needs_you/decision block.
  // Persisted per-task so it is part of the task's history and available to
  // any future continuation; the run itself cannot continue in place when
  // the provider does not support resuming sessions.
  async function writeDecisionAnswer(task, answer) {
    await writeJson(path.join(taskDir(task.slug), "answer.json"), answer);
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
    readRunResult,
    writeRunPrompt,
    readRunPrompt,
    readTaskLog,
    readEventLog,
    readEvents,
    appendEvent,
    writePermissionDecision,
    writeDecisionAnswer
  };
}
