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
import { launchUi } from "./ui.mjs";
import { runTui } from "./tui/index.mjs";
import { pairDevice, pairOff } from "./relay/pair.mjs";
import { formatCode } from "./web/e2e.mjs";
import { unavailableMessage } from "./providers/index.mjs";

function help() {
  console.log(`2f — task-native coding-agent wrapper

Commands:
  2f                list today's tasks
  2f init
  2f new <task> [--provider <id>]   provider: auto | <id> (default from routing)
  2f status
  2f open <id> [--run <n>]
  2f rerun <id> [--provider <id>]   run the same task again as a new run
  2f note <id> <text>    record a constraint/correction on the task; the next
                          run's context includes it (no execution is started)
  2f allow <id>     grant the permission a task is blocked on
  2f reject <id>    decline the requested change
  2f answer <id> <answer>   answer a NEEDS YOU decision (not allow/reject)
  2f close <id>      stop working on a task; moves it to DONE
  2f pair [--relay <url>] [--client <url>] [--lan]   pair this Mac for phone control over
                          the same Wi-Fi: prints a phone-openable URL + one-time code
                          (default; --relay/--client or 0X2F_RELAY_URL/0X2F_CLIENT_ORIGIN
                          pair through a hosted relay instead; --lan forces LAN;
                          --off revokes remote access and disables the connection)
  2f providers      list execution providers (native + configured)
  2f ui [port]      open the Web UI (start the runtime if needed; --no-browser
                    starts it without opening a browser)
  2f tui [--light]  open the terminal client: the whole ledger, one task in
                    full, and the action it is waiting for — the same runtime
                    the Web UI and the phone speak to

Providers: auto (routing), claude-code (default), codex, deepseek-harness, gemini
Configured: ACP/command providers from .work/providers/*.json
Routing:    .work/routing.json (default: auto | <id>, prefer: [<ids>])
`);
}

// Parse `--provider <id>` / `--run <n>` / `--no-browser` (and `=value`
// forms) out of command args; the rest is positional. Provider selection is
// secondary — tasks are first.
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
    } else if (arg === "--relay") {
      flags.relay = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--relay=")) {
      flags.relay = arg.slice("--relay=".length);
    } else if (arg === "--client") {
      flags.client = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--client=")) {
      flags.client = arg.slice("--client=".length);
    } else if (arg === "--run") {
      flags.run = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--run=")) {
      flags.run = arg.slice("--run=".length);
    } else if (arg === "--port") {
      flags.port = args[i + 1];
      i++;
    } else if (typeof arg === "string" && arg.startsWith("--port=")) {
      flags.port = arg.slice("--port=".length);
    } else if (arg === "--off") {
      flags.off = true;
    } else if (arg === "--lan") {
      flags.lan = true;
    } else if (arg === "--no-browser") {
      flags.noBrowser = true;
    } else if (arg === "--light") {
      flags.light = true;
    } else {
      rest.push(arg);
    }
  }
  return { rest, flags };
}

function parseNewArgs(args) {
  const { rest, flags } = parseFlags(args);
  return { brief: rest.join(" ").trim(), provider: flags.provider };
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
    console.log(`\n[2f allow ${detail.id}]  [2f reject ${detail.id}]  [2f close ${detail.id}]`);
    return;
  }
  if (blocked?.type === "decision") {
    console.log(`NEEDS YOU — Decision\n`);
    if (blocked.text) console.log(`${blocked.text}\n`);
    // A decision is answered, not allowed/rejected — and CLOSE is always the
    // way to remove a Work from active attention.
    console.log(`[2f answer ${detail.id} "<your answer>"]  [2f close ${detail.id}]`);
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
    console.log("  project.md     describe the project once — every task prompt starts from it");
    console.log("  rules.md       working rules for every run");
    console.log("  knowledge.md   results you promote from finished tasks");
    console.log("  decisions.md   past decisions, carried into future runs");
    console.log("  providers/     manifests for extra ACP/command providers");
    console.log("");
    console.log('Next: 2f new "<your first task>"  ·  2f ui to open the Web UI');

    // First use: say which provider will actually run, or what to install.
    // The availability fact is the same cheap executable resolution the
    // router and the action boundary use — never a spawn.
    const runtime = createRuntime(base);
    const available = runtime.providers
      .listProviders()
      .filter(p => runtime.providers.available(p.id))
      .map(p => p.id);
    if (available.length) {
      console.log(`Provider: ${available.join(", ")} detected and ready.`);
    } else {
      console.log("No coding harness detected on PATH — install Claude Code (`claude`), Codex (`codex`),");
      console.log("DeepSeek Harness (`dsh`), or Gemini CLI (`gemini`), or add a manifest to .work/providers/.");
      console.log("(2f providers lists what 0x2F sees and whether each is available.)");
    }
    return;
  }

  if (command === "new") {
    await requireProject(base);
    const { brief, provider } = parseNewArgs(args);
    if (!brief) throw new Error('Usage: 2f new "Investigate ..." [--provider <id>]');

    const runtime = createRuntime(base);
    // First-use preflight: when the user did not pick a provider, the
    // configured/runtime default must be runnable on this machine, or the
    // refusal is printed HERE instead of creating a task that is doomed to
    // fail in the background with an opaque spawn error. Explicit selections
    // are refused by the shared action with the same message.
    if (!provider) {
      const effective = runtime.router.defaultRequestedProvider();
      if (effective !== "auto" && !runtime.providers.available(effective)) {
        throw new Error(unavailableMessage(effective, runtime.providers));
      }
    }

    const task = await runtime.actions.createWork({ brief, provider });

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

  // `2f answer <id> "<text>"` — respond to a NEEDS YOU decision. A decision
  // is answered, never allowed/rejected; the answer is persisted with the
  // task. It does not continue the run in place (no provider supports
  // free-text decision continuation yet); the task stays NEEDS YOU until the
  // user closes it or reruns it.
  if (command === "answer") {
    await requireProject(base);
    const id = Number(args[0]);
    const answer = args.slice(1).join(" ").trim();
    if (!Number.isFinite(id) || !answer) {
      throw new Error('Usage: 2f answer <id> "<your answer>"');
    }

    const task = await createRuntime(base).actions.answerWork(id, { answer });
    console.log(`#${String(task.id).padStart(3, "0")} ${task.title}`);
    console.log("Answer recorded — it is now part of this task's context.");
    console.log("The task stays NEEDS YOU — rerun it to continue with the answer in context, or close it.");
    return;
  }

  // `2f note <id> "<constraint>"` — record a user constraint/correction as
  // Task context. It never starts or resumes an execution: the note becomes
  // part of the task's next run's input (2f rerun rebuilds the prompt from
  // Task state). Unlike answer, it is not gated on a needs_you/decision block
  // — add it to a READY or FAILED task before rerunning.
  if (command === "note") {
    await requireProject(base);
    const id = Number(args[0]);
    const note = args.slice(1).join(" ").trim();
    if (!Number.isFinite(id) || !note) {
      throw new Error('Usage: 2f note <id> "<constraint or correction>"');
    }

    const task = await createRuntime(base).actions.noteWork(id, { note });
    console.log(`#${String(task.id).padStart(3, "0")} ${task.title}`);
    console.log("Note recorded on the task — it will be included in the next run's context.");
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
    const { rest, flags } = parseFlags(args);
    // Port comes from --port <n> or the positional form `2f ui <port>` —
    // both are accepted; the default is the canonical 4242.
    const port =
      flags.port !== undefined
        ? Number(flags.port)
        : rest[0]
          ? Number(rest[0])
          : 4242;
    if (!Number.isFinite(port)) {
      throw new Error('Usage: 2f ui [port] [--no-browser]');
    }
    // App launcher: reuse a running 0x2F runtime, otherwise start it in the
    // background, wait until healthy, and open the UI in the default browser.
    // --no-browser keeps the server-only path for development/automation.
    const result = await launchUi({
      base,
      port,
      open: !flags.noBrowser
    });
    console.log(
      `0x2F UI: ${result.url}${result.status === "reused" ? " (already running)" : ""}`
    );
    if (!result.opened) {
      console.log(`Open ${result.url} in your browser.`);
    }
    return;
  }

  // `2f tui` — the terminal client. Another CLIENT of the same runtime, not
  // another runtime: it builds `createRuntime(base)` exactly as every other
  // command here does, calls the SAME shared actions, and tails the same
  // event logs the Web server tails. Nothing about task semantics is decided
  // in src/tui. The default `2f` behavior is unchanged — this is opt-in.
  if (command === "tui") {
    await requireProject(base);
    const { flags } = parseFlags(args);
    await runTui({ base, theme: flags.light ? "light" : "dark" });
    return;
  }

  // `2f pair [--relay <url>] [--client <url>] [--lan] [--port <n>]` — one-time
  // pairing for remote control from a phone. 0x2F pairs over the local
  // network by default (same Wi-Fi); `--relay` / `--client` (or the
  // 0X2F_RELAY_URL / 0X2F_CLIENT_ORIGIN env vars) pair through a hosted
  // relay. Prints a phone-openable URL and the E2E pairing code; the phone
  // opens the URL once and types the code into the trusted client page.
  // `--off` revokes remote access.
  if (command === "pair") {
    await requireProject(base);
    const { flags } = parseFlags(args);
    if (flags.off) {
      await pairOff({ base });
      console.log("Remote control revoked at the relay and disabled locally.");
      console.log('Re-enable with: 2f pair');
      return;
    }
    const port = flags.port ? Number(flags.port) : 4242;
    if (!Number.isFinite(port)) {
      throw new Error('Usage: 2f pair [--relay <url>] [--client <url>] [--lan] [--port <n>]');
    }
    const result = await pairDevice({
      base,
      url: flags.relay,
      client: flags.client,
      port,
      lan: flags.lan
    });
    if (result.transport === "lan") {
      console.log("0x2F PAIR");
      console.log("");
      console.log("same Wi-Fi required");
      console.log("");
      console.log(`  ${result.url}`);
      console.log("");
      console.log(`code  ${formatCode(result.code)}`);
    } else {
      console.log("Open this URL on your phone (the pairing page is served by the");
      console.log("client origin — never by the relay):");
      console.log(`  ${result.url}`);
      console.log("");
      console.log(`Pairing code:  ${formatCode(result.code)}`);
    }
    console.log(`It expires ${result.expiresAt} and is one-time — a second phone re-pairs with 2f pair again.`);
    if (!result.registered) {
      console.log("The relay has not confirmed the token yet — it will register as soon as the agent connects.");
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
