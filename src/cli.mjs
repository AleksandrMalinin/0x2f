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
import {
  renderTasks,
  providerName,
  providerLabel,
  fmtRunDuration,
  renderRuns,
  renderProviders
} from "./render.mjs";
import { startServer } from "./server.mjs";

function help() {
  console.log(`2f — task-native coding-agent wrapper

Commands:
  2f                list today's tasks
  2f init
  2f new <task> [--provider <id>]   provider: auto | <id> (default from routing)
  2f status
  2f open <id> [--run <n>]
  2f rerun <id> [--provider <id>]   run the same task again as a new run
  2f allow <id>     grant the permission a task is blocked on
  2f reject <id>    decline the requested change
  2f close <id>
  2f providers      list execution providers (native + configured)
  2f ui [port]

Providers: auto (routing), claude-code (default), deepseek-harness
Configured: ACP/command providers from .work/providers/*.json
Routing:    .work/routing.json (default: auto | <id>, prefer: [<ids>])
`);
}

// Parse `--provider <id>` / `--run <n>` (and `=value` forms) out of command
// args; the rest is positional. Provider selection is secondary — tasks are
// first.
function parseFlags(args) {
  const rest = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      flags.provider = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--provider=")) {
      flags.provider = arg.slice("--provider=".length);
    } else if (arg === "--run") {
      flags.run = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--run=")) {
      flags.run = arg.slice("--run=".length);
    } else {
      rest.push(arg);
    }
  }
  return { rest, flags };
}

function parseNewArgs(args) {
  const { rest, flags } = parseFlags(args);
  return { title: rest.join(" ").trim(), provider: flags.provider };
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
    if (blocked.live) {
      // An interactive ACP permission request: the run's session is still
      // alive, holding the request. Show only what the agent actually
      // supplied — tool/action, path, description, options.
      console.log("Agent requested permission:\n");
      if (blocked.tool) console.log(`  action: ${blocked.tool}`);
      if (blocked.file) console.log(`  path:   ${relativeFile(base, blocked.file)}`);
      if (blocked.description && blocked.description !== blocked.tool) {
        console.log(`  detail: ${blocked.description}`);
      }
      if (blocked.options?.length) {
        console.log(`  options: ${blocked.options.map(o => `${o.name} (${o.kind})`).join(" · ")}`);
      }
      if (blocked.canAllow === false || blocked.canReject === false) {
        console.log("  (some options cannot be mapped to ALLOW/REJECT — inspect above)");
      }
    } else {
      console.log(`Agent wants to modify:\n  ${relativeFile(base, blocked.file) ?? "?"}\n`);
      if (blocked.plannedChange) {
        console.log(`Planned change:\n  ${blocked.plannedChange}\n`);
      }
    }
    console.log(`\n[2f allow ${detail.id}]  [2f reject ${detail.id}]`);
    return;
  }
  if (blocked?.type === "decision") {
    console.log(`NEEDS YOU — Decision\n`);
    if (blocked.text) console.log(`${blocked.text}\n`);
    console.log(`[2f allow ${detail.id}]  [2f reject ${detail.id}]`);
    return;
  }

  console.log(`Status: ${detail.status}${detail.status === "working" ? ` · ${providerName(detail, runtime.providers.getProvider)}` : ""}\n`);

  const execution = detail.execution ?? {};
  const model = execution.model ? ` · model ${execution.model}` : "";
  console.log(`Execution: provider ${execution.provider ?? "?"} · node ${execution.node ?? "?"}${model}`);

  // The AUTO routing decision for the current run — why 0x2F ran it here.
  // Read from the persisted run record, never reconstructed from config.
  const currentRun = detail.runs?.at(-1);
  if (currentRun?.routing?.mode === "auto") {
    console.log(
      `Routing:   auto → ${currentRun.provider} (${currentRun.routing.reason})`
    );
  }
  console.log("");

  // Run history: the same task through different providers, side by side.
  // Every task has at least one run (a legacy task reads as one historical
  // run); this is inspection, never evaluation.
  console.log(renderRuns(detail.runs ?? []));

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

// `2f open <id> --run <n>`: one run's factual detail — provider, node, model,
// timing, outcome, session, attempts, and its own written result. Missing
// observability (a DeepSeek Harness run has no session id) shows as "—".
async function openRun(id, runNumber, base) {
  const runtime = createRuntime(base);
  const run = await runtime.actions.getRun(id, runNumber);
  const provider = providerLabel(run.provider, runtime.providers.getProvider);

  console.log(`#${String(id).padStart(3, "0")} · RUN ${String(run.run).padStart(2, "0")} — ${provider}\n`);

  const outcome =
    { working: "WORKING", needs_you: "NEEDS YOU", ready: "READY", failed: "FAILED" }[run.outcome] ??
    String(run.outcome ?? "?").toUpperCase();
  console.log(`Provider     ${provider}`);
  console.log(`Node         ${run.node ?? "—"}`);
  console.log(`Model        ${run.model ?? "—"}`);
  console.log(`Started      ${run.startedAt ?? "—"}`);
  console.log(`Completed    ${run.completedAt ?? "—"}`);
  console.log(`Duration     ${fmtRunDuration(run.durationMs)}`);
  console.log(`Outcome      ${outcome}`);
  console.log(`Session      ${run.externalSessionId ?? "—"}`);
  console.log(`Attempts     ${run.attempts ?? 1}`);
  if (run.requestedProvider === "auto" && run.routing) {
    console.log(`Routed       auto → ${run.provider} (${run.routing.reason})`);
  }
  console.log("");

  if (run.result?.trim()) {
    console.log(run.result.trim());
  } else if (run.error) {
    console.log(run.error);
  } else {
    console.log("No written result for this run.");
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

    const runtime = createRuntime(base);
    const task = await runtime.actions.createWork({ title, provider });

    console.log(`Created #${String(task.id).padStart(3, "0")}: ${task.title}`);
    console.log(`${providerName(task, runtime.providers.getProvider)} is running in the background.`);
    return;
  }

  if (command === "open") {
    await requireProject(base);
    const { rest, flags } = parseFlags(args);
    const id = Number(rest[0]);
    if (!Number.isFinite(id)) throw new Error("Usage: 2f open <id> [--run <n>]");
    if (flags.run !== undefined) {
      const runNumber = Number(flags.run);
      if (!Number.isFinite(runNumber)) throw new Error("Usage: 2f open <id> --run <n>");
      await openRun(id, runNumber, base);
    } else {
      await openTask(id, base);
    }
    return;
  }

  if (command === "rerun") {
    await requireProject(base);
    const { rest, flags } = parseFlags(args);
    const id = Number(rest[0]);
    if (!Number.isFinite(id)) {
      throw new Error('Usage: 2f rerun <id> [--provider <id>]');
    }

    const runtime = createRuntime(base);
    const task = await runtime.actions.rerunWork(id, {
      provider: flags.provider
    });
    const runNumber = task.runs?.at(-1)?.run ?? 1;

    console.log(`#${String(task.id).padStart(3, "0")} ${task.title}`);
    console.log(
      `Run ${String(runNumber).padStart(2, "0")} started with ${providerName(task, runtime.providers.getProvider)} in the background.`
    );
    return;
  }

  if (command === "allow" || command === "reject") {
    await requireProject(base);
    const id = Number(args[0]);
    if (!Number.isFinite(id)) throw new Error(`Usage: 2f ${command} <id>`);

    const task = await createRuntime(base).actions.resumeWork(id, command);

    console.log(`#${String(task.id).padStart(3, "0")} ${task.title}`);
    if (task.live) {
      // An interactive permission request: the run's process is still alive,
      // holding the outstanding request; the grant is delivered in place and
      // the SAME execution continues.
      console.log(
        command === "allow"
          ? "Permission granted — continuing the run in the background."
          : "Change declined — the agent continues with the request withdrawn."
      );
    } else {
      console.log(
        command === "allow"
          ? "Permission granted — resuming the same session in the background."
          : "Change declined — resuming the session with the request withdrawn."
      );
    }
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

  if (command === "providers") {
    await requireProject(base);
    const runtime = createRuntime(base);
    console.log(renderProviders(runtime.providers.listProviders(), runtime.providers));
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
