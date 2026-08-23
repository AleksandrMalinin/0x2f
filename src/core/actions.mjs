// Shared Work actions — the SINGLE implementation of Work's business rules.
//
// Both the CLI and the HTTP API call these actions; neither implements its
// own create/allow/reject/close logic. Clients render state and invoke
// actions. Work Core owns what `ready` means, what `needs_you` means, whether
// a permission request is resolved, and how a run is resumed. The Web UI must
// not decide any of that — and neither may the CLI or a future TUI.
//
//   ctx = {
//     store,        // persistence (core/store.mjs)
//     node,         // execution node (nodes/local.mjs today)
//     events,       // live event bus (core/events.mjs)
//     providerId,   // default execution provider id
//     workspaceId,  // logical workspace id ("local" today)
//     buildPrompt   // (title) -> prompt string
//   }

import { closeTask } from "./lifecycle.mjs";
import { WorkError } from "./errors.mjs";
import { workEvent } from "./events.mjs";
import { getProvider, listProviders } from "../providers/index.mjs";
import { makeRunRecord, taskRuns, legacyRun } from "./runs.mjs";

export function createActions(ctx) {
  const { store, node } = ctx;

  // Record a normalized event to the task's event log. The API layer tails
  // this log and broadcasts to live clients, so every client observes the
  // same state regardless of which process performed the action.
  async function record(task, type, data = {}) {
    await store.appendEvent(task.slug, workEvent(type, task.id, data));
  }

  // listWork(): Promise<Task[]> — all tasks, newest first.
  async function listWork() {
    return store.listTasks();
  }

  // getWork(id): Promise<{ ...task, runs, result }> — task plus its projected
  // run history (legacy tasks read as one historical run) and final result.
  async function getWork(id) {
    const task = await store.findTask(id);
    const [result, events] = await Promise.all([
      store.readTaskResult(task),
      store.readEvents(task.slug)
    ]);
    return { ...task, runs: taskRuns(task, { events }), result };
  }

  // getRun(id, run): Promise<{ ...runRecord, result }> — one run's factual
  // detail: provider/node/model/timing/outcome plus its own written result.
  // The result text lives per-run on disk; this reads the record's file.
  async function getRun(id, runNumber) {
    const task = await store.findTask(id);
    const events = await store.readEvents(task.slug);
    const runs = taskRuns(task, { events });
    const record = runs.find(r => r.run === Number(runNumber));
    if (!record) {
      throw new WorkError(`Task #${id} has no run ${runNumber}.`, 404);
    }
    const result = await store.readRunResult(task, record);
    return { ...record, result };
  }

  // createWork({ title, provider?, model? }): create the task and start
  // execution on the node. `provider` defaults to the runtime's default
  // (claude-code); `model` is persisted only when reliably known. The task is
  // the persistent system; the node + provider + session are execution
  // infrastructure underneath it. The first run record is persisted with the
  // task — the task/run distinction is real in the data model from the start.
  async function createWork({ title, provider, model } = {}) {
    if (!title || !title.trim()) {
      throw new WorkError("Task title is required.");
    }
    const clean = title.trim();
    const providerId = provider ?? ctx.providerId;
    if (provider) {
      const found = getProvider(provider);
      if (!found) {
        throw new WorkError(
          `Unknown execution provider "${provider}". Available: ${listProviders()
            .map(p => p.id)
            .join(", ")}.`
        );
      }
    }

    const prompt = await ctx.buildPrompt(clean);
    const startedAt = new Date().toISOString();

    const task = await store.createTask(clean, prompt, {
      provider: providerId,
      node: node.id,
      workspace: ctx.workspaceId,
      ...(model ? { model } : {}),
      runs: [
        makeRunRecord({
          run: 1,
          provider: providerId,
          node: node.id,
          workspace: ctx.workspaceId,
          model,
          startedAt
        })
      ]
    });

    const pid = await node.startExecution({ task });
    if (pid) await store.updateTask({ ...task, pid });

    await record(task, "task.created", { status: task.status });
    return { ...task, pid };
  }

  // rerunWork(id, { provider?, model? }): run the SAME task again as a NEW
  // run under it. The original task intent is unchanged; the previous run's
  // result and execution metadata are preserved in history (never
  // overwritten). `provider` defaults to the task's current provider —
  // rerunning without one is a retry.
  //
  // Runs of one task are STRICTLY SEQUENTIAL: two runs of the same task would
  // race against the same working directory (no isolated worktrees/sandboxes
  // yet), so a rerun refuses while the task is working. A blocked (needs_you)
  // task may be rerun — the blocked run stays in history, and the new run
  // starts fresh.
  async function rerunWork(id, { provider, model } = {}) {
    const task = await store.findTask(id);
    if (task.status === "working") {
      throw new WorkError(
        `Task #${id} is working — its current run is still executing. Runs of one task are sequential; wait for it to finish before starting another.`
      );
    }
    const providerId = provider ?? task.execution?.provider ?? ctx.providerId;
    if (provider) {
      const found = getProvider(provider);
      if (!found) {
        throw new WorkError(
          `Unknown execution provider "${provider}". Available: ${listProviders()
            .map(p => p.id)
            .join(", ")}.`
        );
      }
    }

    // Materialize run history for legacy tasks BEFORE replacing execution:
    // the legacy run's provider would otherwise be lost when execution is
    // reset to the new run. Additive — historical fields are never rewritten.
    let current = task;
    if (!Array.isArray(current.runs) || current.runs.length === 0) {
      const events = await store.readEvents(current.slug);
      current = { ...current, runs: [legacyRun(current, events)] };
    }

    const runNumber = (current.runs.at(-1)?.run ?? 0) + 1;
    const startedAt = new Date().toISOString();

    current = {
      ...current,
      status: "working",
      runs: [
        ...current.runs,
        makeRunRecord({
          run: runNumber,
          provider: providerId,
          node: node.id,
          workspace: ctx.workspaceId,
          model,
          startedAt
        })
      ],
      // The CURRENT run's execution state — fresh for the new run. The
      // previous run keeps its own provider/node/session in its run record.
      execution: {
        provider: providerId,
        node: node.id,
        workspace: ctx.workspaceId,
        ...(model ? { model } : {})
      }
    };
    delete current.blockedOn;
    delete current.error;
    await store.updateTask(current);

    const pid = await node.startExecution({ task: current });
    if (pid) await store.updateTask({ ...current, pid });

    await record(current, "task.updated", {
      status: "working",
      run: runNumber
    });
    return { ...current, pid };
  }

  // resumeWork(id, grant): allow | reject — validate the task can be resumed,
  // then hand execution back to the node (which resumes the SAME provider
  // session). The needs_you -> working transition is applied by the worker
  // on the node, exactly as in v0.2.
  async function resumeWork(id, grant) {
    const task = await store.findTask(id);
    if (task.status !== "needs_you") {
      throw new WorkError(
        `Task #${id} is ${task.status}, not needs_you — nothing to ${grant}.`
      );
    }
    const provider = getProvider(task.execution?.provider);
    if (provider && provider.capabilities?.supportsResume === false) {
      // Real capability difference (e.g. DeepSeek Harness headless cannot
      // resume a session): refuse instead of faking a continuation.
      throw new WorkError(
        `Provider "${provider.id}" does not support resuming sessions — this task cannot be continued in place.`
      );
    }
    if (!task.execution?.externalSessionId) {
      throw new WorkError(
        `Task #${id} has no resumable execution session. Its provider run ended without a recoverable session, so it cannot be continued in place.`
      );
    }
    await node.resumeExecution({ task, grant });
    return { ...task, status: "working" };
  }

  // closeWork(id): user closes the task (any status -> done).
  async function closeWork(id) {
    const task = await store.findTask(id);
    const closed = closeTask(task);
    await store.updateTask(closed);
    await record(task, "task.closed", { status: closed.status });
    return closed;
  }

  return {
    listWork,
    getWork,
    getRun,
    createWork,
    rerunWork,
    resumeWork,
    closeWork,
    allowWork: id => resumeWork(id, "allow"),
    rejectWork: id => resumeWork(id, "reject")
  };
}
