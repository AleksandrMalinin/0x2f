#!/usr/bin/env node
// `npm run dogfood:tui` — the same golden-path TUI journey the CI suite
// runs, but against a REAL installed provider on this machine, for
// exploratory testing before a release. It drives the real `2f tui` on a
// real PTY, watches a real agent work, and shows what the TUI showed at
// every checkpoint.
//
// This is deliberately NOT part of the regression suite (`npm test` never
// touches it): it makes real model calls and needs a real harness installed.
//
// Usage:
//   npm run dogfood:tui [-- --provider <id>] [--timeout <seconds>] [--clean]
//
//   --provider <id>  run with a specific installed provider (default: the
//                    first provider available on this machine)
//   --timeout <sec>  overall budget for the journey (default 600)
//   --clean          delete the scratch workspace afterwards (it is kept by
//                    default so you can inspect what the agent produced)

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";
import { startTui, makeWorkspace, storeOf, sleep } from "../test/tui-pty/driver.mjs";

const ESC = "\u001b";
const RESTORATION = [ESC + "[?1049l", ESC + "[?25h", ESC + "[0m"];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const wantProvider = arg("--provider", null);
const timeoutSec = Number(arg("--timeout", "600")) || 600;
const clean = process.argv.includes("--clean");

const brief = [
  "Inspect the dependency-injection wiring of the capture service",
  "Trace one event from ingest to persistence and report the actual call path",
  "Make no changes unless a defect is confirmed; then propose the narrowest fix"
];

const correction = "Keep changes scoped to the task and cite concrete files in the result.";
const answer = "Proceed with the narrowest correct option and document the tradeoff.";

const log = (step, line) => console.log(`\n── ${step} — ${line}`);

// Kill any detached worker this workspace started (pids are on the tasks),
// so an interrupted run never leaves a real agent executing in the background.
async function killWorkers(base) {
  const dir = path.join(base, ".work", "tasks");
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const task = JSON.parse(
        await fs.readFile(path.join(dir, entry, "task.json"), "utf8")
      );
      if (task.pid) {
        try {
          process.kill(task.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* mid-write */
    }
  }
}

async function pickProvider(base) {
  const runtime = createRuntime(base);
  const all = runtime.providers.listProviders();
  const available = all.filter(p => runtime.providers.available(p.id));
  if (!available.length) {
    throw new Error(
      "No execution provider is available on this machine. Install one " +
        "(claude, codex, dsh, gemini), or configure a manifest under .work/providers/."
    );
  }
  if (wantProvider) {
    const found = available.find(p => p.id === wantProvider);
    if (!found) {
      throw new Error(
        `Provider "${wantProvider}" is not available. Available: ${available.map(p => p.id).join(", ")}`
      );
    }
    return found;
  }
  return available[0];
}

// Wait for the task to leave WORKING; returns { status, task }.
async function waitOutcome(base, id, deadline, session, step) {
  const store = storeOf(base);
  let last = "";
  while (Date.now() < deadline) {
    let task = null;
    try {
      task = await store.findTask(id);
    } catch {
      /* mid-write */
    }
    if (task && task.status !== "working") return { status: task.status, task };
    if (task) {
      const started = task.runs?.at(-1)?.startedAt;
      const el = started ? Math.round((Date.now() - Date.parse(started)) / 1000) : 0;
      const line = `still ${task?.status ?? "?"} (${el}s) — screen: ${oneline(session)}`;
      if (line !== last) {
        console.log(`         ${step}: ${line}`);
        last = line;
      }
    }
    await sleep(2000);
  }
  throw new Error(
    `timed out waiting for ${step} to finish.\n--- screen ---\n${session.text()}\n` +
      `--- workspace ---\n${base}`
  );
}

function oneline(session) {
  const rows = session.text().split("\n").filter(r => r.trim());
  return (rows.find(r => /WORKING|NEEDS YOU|READY|FAILED/.test(r)) ?? rows.at(-2) ?? "").trim().slice(0, 120);
}

// Act on a NEEDS YOU halt the way the design says: ALLOW a permission,
// ANSWER & CONTINUE a decision.
async function actOnHalt(session, task, step) {
  const halt = task.blockedOn;
  if (halt?.type === "permission") {
    log(step, `the agent wants permission to ${halt.tool ?? "proceed"} (${halt.file ?? "?"}) — ALLOW`);
    session.press("enter");
    await sleep(600);
    return "allowed";
  }
  if (halt?.type === "decision") {
    const question = (halt.text ?? "").split("\n")[0].slice(0, 160);
    log(step, `the agent needs a decision: ${question}\n         ANSWER & CONTINUE with: ${answer}`);
    session.press("enter");
    await sleep(300);
    session.type(answer);
    session.press("enter");
    await sleep(600);
    return "answered";
  }
  log(step, `NEEDS YOU of kind ${halt?.type ?? "?"} — answering generically`);
  session.press("enter");
  await sleep(600);
  return "answered";
}

async function main() {
  const base = await makeWorkspace({ providerRoles: {}, routingDefault: "auto" }).then(w => w.base);
  console.log(`0x2F dogfood TUI — scratch workspace: ${base}`);
  console.log(`budget: ${timeoutSec}s · provider: ${wantProvider ?? "first available"}`);

  const provider = await pickProvider(base).catch(error => {
    // A preflight failure means nothing ran yet — leave no scratch behind.
    fs.rm(base, { recursive: true, force: true }).catch(() => {});
    throw error;
  });
  // Point the routing default at the chosen provider so the composer's chip
  // starts on it (the TUI builds its runtime at launch).
  await fs.writeFile(
    path.join(base, ".work", "routing.json"),
    JSON.stringify({ default: provider.id }, null, 2)
  );
  console.log(`provider: ${provider.displayName} (${provider.id})`);

  const session = await startTui({ workspace: base, cols: 132, rows: 38 });
  let result = "incomplete";
  try {
    const deadline = Date.now() + timeoutSec * 1000;

    // 1. launch — the workspace is active.
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
    await session.waitForText(new RegExp(path.basename(base)), { label: "the workspace label" });
    log("launch", "the TUI is up; workspace verified");
    console.log(`         ${oneline(session)}`);

    // 2. compose a multi-line brief.
    session.press("n");
    await session.waitForText(/NEW TASK/, { label: "the composer" });
    session.type(brief[0]);
    session.press("ctrl-n");
    session.type(brief[1]);
    session.press("ctrl-n");
    session.type(brief[2]);
    await session.waitForText(/Trace one event from ingest to persistence/, { label: "the typed brief" });
    console.log(`         composer: ${brief[0]} / ${brief[1]} / ${brief[2]}`);
    session.press("enter");
    await session.waitForText(/opened · run 1/, { label: "the create flash" });
    log("create", "task created; run 1 started");
    console.log(`         ${oneline(session)}`);

    // 3. the run: work it through whatever it stops on, up to 4 cycles.
    let cycles = 0;
    let state = { status: "working", task: null };
    while (cycles < 4) {
      cycles++;
      const outcome = await waitOutcome(base, 1, deadline, session, `run cycle ${cycles}`);
      state = outcome;
      if (outcome.status === "working") {
        log(`cycle ${cycles}`, "still working — skipping ahead");
        continue;
      }
      if (outcome.status === "needs_you") {
        const acted = await actOnHalt(session, outcome.task, `cycle ${cycles}`);
        log(`cycle ${cycles}`, `${acted} — the run continues`);
        continue;
      }
      if (outcome.status === "failed") {
        log(`cycle ${cycles}`, `the run FAILED: ${(outcome.task.error ?? "").split("\n")[0].slice(0, 160)}`);
        console.log(`         ${oneline(session)}`);
        console.log(`         RETRY once (the task, its notes and its runs are kept).`);
        session.press("enter");
        await sleep(800);
        continue;
      }
      break; // ready
    }

    if (state.status !== "ready") {
      throw new Error(`the journey did not reach READY (last: ${state.status}).\n--- screen ---\n${session.text()}`);
    }

    // 4. inspect the real CHANGES view.
    log("ready", "the run completed — inspecting the CHANGES view");
    session.press("d");
    await sleep(1500);
    console.log(`         ${session.text().split("\n").slice(0, 12).join("\n         ")}`);
    session.press("escape");

    // 5. send it back with a correction; work the next run.
    log("send back", `SEND BACK with: ${correction}`);
    session.press("x");
    await sleep(300);
    session.type(correction);
    session.press("enter");
    await sleep(800);
    cycles = 0;
    state = { status: "working", task: null };
    while (cycles < 4) {
      cycles++;
      const outcome = await waitOutcome(base, 1, deadline, session, `rerun cycle ${cycles}`);
      state = outcome;
      if (outcome.status === "needs_you") {
        await actOnHalt(session, outcome.task, `rerun cycle ${cycles}`);
        continue;
      }
      if (outcome.status === "failed") {
        log(`rerun cycle ${cycles}`, `failed: ${(outcome.task.error ?? "").split("\n")[0].slice(0, 160)} — stopping`);
        break;
      }
      break;
    }
    if (state.status !== "ready") {
      throw new Error(`the rerun did not reach READY (last: ${state.status}).\n--- screen ---\n${session.text()}`);
    }

    // 6. ACCEPT.
    log("accept", "the rerun is READY — ACCEPT");
    session.press("enter");
    await sleep(800);
    const task = await storeOf(base).findTask(1);
    if (task.status !== "done") {
      throw new Error(`ACCEPT did not close the task (status ${task.status}).\n--- screen ---\n${session.text()}`);
    }
    console.log(`         task #001 is DONE after ${task.runs.length} run${task.runs.length === 1 ? "" : "s"}.`);

    // 7. quit cleanly.
    log("quit", "detaching");
    session.press("q");
    await session.waitForText(/detached\./, { label: "the detach frame" });
    const outcome = await session.waitForExit();
    if (outcome.code !== 0) throw new Error(`the TUI exited ${outcome.code} on q`);
    const tail = session.rawTail(800);
    for (const seq of RESTORATION) {
      if (!tail.includes(seq)) throw new Error(`terminal restoration missing ${JSON.stringify(seq)}`);
    }
    result = "complete";
    console.log(`\n✓ DOGFOOD JOURNEY COMPLETE — ${provider.displayName} ran the whole golden path through the real TUI.`);
  } finally {
    session.kill();
    await session.waitForExit({ timeout: 3000 }).catch(() => {});
    await killWorkers(base);
    if (clean) {
      await fs.rm(base, { recursive: true, force: true });
      console.log(`scratch workspace deleted (--clean).`);
    } else if (result !== "incomplete") {
      console.log(`workspace kept for inspection: ${base}`);
    }
  }
  if (result !== "complete") process.exitCode = 1;
}

main().catch(error => {
  console.error(`\nDOGFOOD FAILED: ${error.message}`);
  process.exitCode = 1;
});
