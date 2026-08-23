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

  // getWork(id): Promise<{ ...task, result }> — task plus its final result.
  async function getWork(id) {
    const task = await store.findTask(id);
    const result = await store.readTaskResult(task);
    return { ...task, result };
  }

  // createWork({ title, provider?, model? }): create the task and start
  // execution on the node. `provider` defaults to the runtime's default
  // (claude-code); `model` is persisted only when reliably known. The task is
  // the persistent system; the node + provider + session are execution
  // infrastructure underneath it.
  async function createWork({ title, provider, model } = {}) {
    if (!title || !title.trim()) {
      throw new WorkError("Task title is required.");
    }
    const clean = title.trim();
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

    const task = await store.createTask(clean, prompt, {
      provider: provider ?? ctx.providerId,
      node: node.id,
      workspace: ctx.workspaceId,
      ...(model ? { model } : {})
    });

    const pid = await node.startExecution({ task });
    if (pid) await store.updateTask({ ...task, pid });

    await record(task, "task.created", { status: task.status });
    return { ...task, pid };
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
    createWork,
    resumeWork,
    closeWork,
    allowWork: id => resumeWork(id, "allow"),
    rejectWork: id => resumeWork(id, "reject")
  };
}
