#!/usr/bin/env node
// 0x2F CLI — one client of the Work Runtime.
//
// The CLI renders state and invokes the SAME shared actions the Web API
// calls (core/actions.mjs). It contains no lifecycle, provider, or session
// logic of its own; `2f allow` and `2f reject` are thin wrappers over
// actions.allowWork / actions.rejectWork.
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRuntime } from "./runtime.mjs";
import { initProject, requireProject, appendProjectKnowledge } from "./project.mjs";
import { renderTasks, providerName } from "./render.mjs";
import { startServer } from "./server.mjs";

function help() {
  console.log(`2f — task-native coding-agent wrapper

Commands:
  2f                list today's tasks
  2f init
  2f new <task> [--provider <id>]
  2f status
  2f open <id>
  2f allow <id>     grant the permission a task is blocked on
  2f reject <id>    decline the requested change
  2f close <id>
  2f ui [port]

Providers: claude-code (default), deepseek-harness
`);
}

// Parse `--provider <id>` (and `--provider=<id>`) out of `2f new` args; the
// rest is the task title. Provider selection is secondary — tasks are first.
function parseNewArgs(args) {
  const rest = [];
  let provider;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      provider = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else {
      rest.push(arg);
    }
  }
  return { title: rest.join(" ").trim(), provider };
}

async function status(base) {
  await requireProject(base);
  console.log(renderTasks(await createRuntime(base).actions.listWork()));
}

function relativeFile(base, file) {
  if (!file) return null;
  const rel = path.relative(base, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

async function openTask(id, base) {
  const runtime = createRuntime(base);
  const detail = await runtime.actions.getWork(id);
  const log = await runtime.store.readTaskLog(detail);

  console.log(`#${String(detail.id).padStart(3, "0")} ${detail.title}\n`);

  const blocked = detail.blockedOn;
  if (blocked?.type === "permission") {
    console.log("NEEDS YOU — Permission\n");
    console.log(`Agent wants to modify:\n  ${relativeFile(base, blocked.file) ?? "?"}\n`);
    if (blocked.plannedChange) {
      console.log(`Planned change:\n  ${blocked.plannedChange}\n`);
    }
    console.log(`[2f allow ${detail.id}]  [2f reject ${detail.id}]`);
    return;
  }
  if (blocked?.type === "decision") {
    console.log(`NEEDS YOU — Decision\n`);
    if (blocked.text) console.log(`${blocked.text}\n`);
    console.log(`[2f allow ${detail.id}]  [2f reject ${detail.id}]`);
    return;
  }

  console.log(`Status: ${detail.status}${detail.status === "working" ? ` · ${providerName(detail)}` : ""}\n`);

  const execution = detail.execution ?? {};
  const model = execution.model ? ` · model ${execution.model}` : "";
  console.log(`Execution: provider ${execution.provider ?? "?"} · node ${execution.node ?? "?"}${model}\n`);

  if (detail.result.trim()) {
    console.log(detail.result.trim());
  } else if (detail.error) {
    console.log(detail.error);
  } else {
    console.log("No final result yet.");
    if (log.trim()) {
      console.log("\n--- run.log ---\n");
      console.log(log.trim());
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const base = process.cwd();

  if (!command || command === "status") {
    await status(base);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    help();
    return;
  }

  if (command === "init") {
    const wd = await initProject();
    console.log(`Initialized ${wd}`);
    console.log("Edit .work/project.md and .work/rules.md, then create a task.");
    return;
  }

  if (command === "new") {
    await requireProject(base);
    const { title, provider } = parseNewArgs(args);
    if (!title) throw new Error('Usage: 2f new "Investigate ..." [--provider <id>]');

    const task = await createRuntime(base).actions.createWork({ title, provider });

    console.log(`Created #${String(task.id).padStart(3, "0")}: ${task.title}`);
    console.log(`${providerName(task)} is running in the background.`);
    return;
  }

  if (command === "open") {
    await requireProject(base);
    const id = Number(args[0]);
    if (!Number.isFinite(id)) throw new Error("Usage: 2f open <id>");
    await openTask(id, base);
    return;
  }

  if (command === "allow" || command === "reject") {
    await requireProject(base);
    const id = Number(args[0]);
    if (!Number.isFinite(id)) throw new Error(`Usage: 2f ${command} <id>`);

    const task = await createRuntime(base).actions.resumeWork(id, command);

    console.log(`#${String(task.id).padStart(3, "0")} ${task.title}`);
    console.log(
      command === "allow"
        ? "Permission granted — resuming the same session in the background."
        : "Change declined — resuming the session with the request withdrawn."
    );
    return;
  }

  if (command === "close") {
    await requireProject(base);
    const id = Number(args[0]);
    if (!Number.isFinite(id)) throw new Error("Usage: 2f close <id>");

    const runtime = createRuntime(base);
    const detail = await runtime.actions.getWork(id);

    console.log(`#${detail.id} ${detail.title}\n`);
    console.log(detail.result.trim() || detail.error || "No final result.");

    // Interactive-only: ask about knowledge/decision promotion. With piped
    // stdin (scripting, CI) readline questions can hang on EOF, so we skip.
    if (input.isTTY) {
      const rl = readline.createInterface({ input, output });
      try {
        const keepKnowledge = (
          await rl.question("\nSave this result to project knowledge? [y/N] ")
        ).trim().toLowerCase();

        if (["y", "yes"].includes(keepKnowledge)) {
          await appendProjectKnowledge(
            "knowledge",
            `Task #${detail.id}: ${detail.title}\n\n${detail.result || detail.error || "No result."}`
          );
        }

        const keepDecision = (
          await rl.question("Save this result to project decisions? [y/N] ")
        ).trim().toLowerCase();

        if (["y", "yes"].includes(keepDecision)) {
          await appendProjectKnowledge(
            "decisions",
            `Task #${detail.id}: ${detail.title}\n\n${detail.result || detail.error || "No result."}`
          );
        }
      } finally {
        rl.close();
      }
    }

    await runtime.actions.closeWork(id);
    console.log(`Closed #${id}.`);
    return;
  }

  if (command === "ui") {
    await requireProject(base);
    const port = args[0] ? Number(args[0]) : 4242;
    await startServer(base, port);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
