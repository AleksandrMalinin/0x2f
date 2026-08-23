// Detached background worker: runs one execution on behalf of a task and
// applies the normalized outcome to the task state.
//
//   node worker.mjs <base> <slug>                -> provider.start
//   node worker.mjs <base> <slug> resume <grant> -> provider.resume
//
// The worker is execution-node infrastructure: the local node spawns it, and
// a future remote node would run the same entrypoint on another machine. It
// consumes normalized provider outcomes (core/lifecycle.mjs) and appends
// normalized Work events (core/events.mjs) to the task's event log so any
// connected client can observe the run. Provider behavior stays inside the
// provider; state meaning stays inside the core; this file only wires them.

import fs from "node:fs/promises";
import path from "node:path";
import { createStore } from "./core/store.mjs";
import { applyOutcome, beginResume } from "./core/lifecycle.mjs";
import { workEvent } from "./core/events.mjs";
import { getProvider, defaultProviderId } from "./providers/index.mjs";

const [, , base, slug, mode, grant] = process.argv;

if (!base || !slug) {
  console.error("worker requires <cwd> <slug> [resume <allow|reject|continue>]");
  process.exit(1);
}

const store = createStore(base);
const dir = store.taskDir(slug);
const metaPath = path.join(dir, "task.json");
const promptPath = path.join(dir, "prompt.md");
const resultPath = path.join(dir, "result.md");

const task = await store.readJson(metaPath);

function log(line) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

// Record a normalized Work event to the task's event log. Live clients
// (Web UI today, TUI tomorrow) receive these through the runtime/API.
function record(type, data = {}) {
  return store.appendEvent(slug, workEvent(type, task.id, data));
}

const onEvent = event => {
  switch (event.type) {
    case "run.started":
      record("run.started", { sessionId: event.sessionId ?? null });
      log(`session started: ${event.sessionId ?? "unknown"}`);
      break;
    case "tool.started": {
      const input = event.input ?? {};
      const target =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.command === "string"
            ? input.command.slice(0, 80)
            : "";
      record("tool.started", { name: event.name, input: event.input ?? {} });
      if (typeof input.file_path === "string") {
        record("file.changed", { path: input.file_path });
      }
      log(`tool: ${event.name}${target ? ` ${target}` : ""}`);
      break;
    }
    case "progress":
      if (event.text) {
        record("progress", { text: event.text });
        log(event.text.replace(/\s+/g, " ").trim().slice(0, 160));
      }
      break;
    case "needs_user":
      record("needs_user", {
        reason: event.reason,
        detail: event.detail ?? {}
      });
      log(`needs user (${event.reason}): ${event.detail?.message ?? ""}`);
      break;
  }
};

// Record the terminal run events + the resulting task state.
async function finish(current, outcome) {
  await store.writeJson(metaPath, current);

  if (outcome.status === "failed") {
    await record("run.failed", { error: outcome.error ?? "Execution failed" });
  } else if (outcome.status === "needs_you") {
    await record("needs_user", {
      reason: outcome.reason,
      blockedOn: outcome.blockedOn ?? {}
    });
  } else {
    await record("run.completed", { status: outcome.status });
  }
  await record("task.updated", { status: current.status });
  log(
    `outcome: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`
  );
}

try {
  const provider = getProvider(task.execution?.provider ?? defaultProviderId);
  if (!provider) {
    const failed = applyOutcome(task, {
      status: "failed",
      error: `No execution provider found for "${task.execution?.provider}".`
    });
    await store.writeJson(metaPath, failed);
    await record("run.failed", { error: failed.error });
    await record("task.updated", { status: failed.status });
    log("outcome: failed (no execution provider)");
    process.exit(1);
  }

  let current = task;
  let outcome;

  if (mode === "resume") {
    if (task.status !== "needs_you") {
      log(`outcome: skipped — task is ${task.status}, not needs_you`);
      process.exit(0);
    }
    current = beginResume(task, grant);
    await store.writeJson(metaPath, current);
    // Carry the grant on the normalized event: `beginResume` already records
    // it as execution.lastAction, so clients can show who unblocked the task
    // without inferring it from a status change.
    await record("task.updated", { status: current.status, grant });
    log(`resuming session ${current.execution?.externalSessionId ?? "?"} (${grant})`);

    outcome = await provider.resume({
      cwd: base,
      externalSessionId: current.execution?.externalSessionId,
      grant,
      onEvent
    });
  } else {
    if (task.status !== "working") {
      log(`outcome: skipped — task is ${task.status}, not working`);
      process.exit(0);
    }
    const prompt = await fs.readFile(promptPath, "utf8");
    log(`launching ${provider.displayName} (${provider.id})`);
    outcome = await provider.start({ cwd: base, prompt, onEvent });
  }

  current = applyOutcome(current, outcome);

  if (outcome.externalSessionId) {
    current.execution = {
      ...(current.execution ?? {}),
      provider: provider.id,
      externalSessionId: outcome.externalSessionId
    };
  }

  if (outcome.status === "ready" || outcome.status === "needs_you") {
    await fs.writeFile(resultPath, outcome.result ?? "", "utf8");
  }

  await finish(current, outcome);
} catch (error) {
  const failed = applyOutcome(task, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
  await store.writeJson(metaPath, failed);
  await record("run.failed", { error: failed.error });
  await record("task.updated", { status: failed.status });
  log(`outcome: failed (${failed.error})`);
  process.exitCode = 1;
}
