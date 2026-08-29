// The foreground 0x2F runtime — the process a supervisor (launchd/systemd)
// keeps alive on a dedicated always-on host.
//
//   serveRuntime({ base, port, lan, log })
//
// This is the single implementation behind the two entry points:
//   - `node src/server-entry.mjs <base> <port>`  — the canonical form the
//     service units and `2f pair`'s LAN restart target (the argv contract is
//     load-bearing: src/relay/pair.mjs matches it);
//   - `2f serve [port] [--port <n>]`             — the human/dev alias, the
//     same code in the foreground.
//
// On start it:
//   1. runs the crash/reboot recovery sweep (src/recover.mjs) — tasks left
//      "working" with a dead worker become failed/crashed BEFORE any client
//      can observe stale state;
//   2. starts the local HTTP/SSE server (loopback by default; the LAN surface
//      is mounted only when `.work/relay.json` enables the LAN transport,
//      exactly as before — the pairing flow is unchanged);
//   3. starts the relay agent (the outbound remote-control link, inert until
//      `.work/relay.json` exists).
//
// SIGTERM/SIGINT shut the runtime down cleanly: the relay agent stops, the
// server closes, the process exits 0. Detached workers are separate processes
// in their own sessions — they never receive this signal, keep executing, and
// write their terminal outcome to the task state on their own. A second
// signal forces an immediate exit.

import path from "node:path";
import fs from "node:fs/promises";
import { startServer } from "./server.mjs";
import { createRelayAgent } from "./relay/agent.mjs";
import { recoverInterruptedRuns } from "./recover.mjs";

// How long shutdown waits for the relay agent to flush its persisted ack
// cache before exiting. stop() fires the save without awaiting it; a short
// grace window lets the final write land so a retried remote command can
// never re-execute after a restart.
const SHUTDOWN_AGENT_GRACE_MS = 150;
// Belt-and-braces: if the server cannot close within this window, force exit.
const SHUTDOWN_FORCE_MS = 5000;

export async function serveRuntime({
  base,
  port = 4242,
  lan,
  log = console
} = {}) {
  if (!base) throw new Error("serveRuntime requires a workspace base path.");

  const info =
    typeof log?.log === "function"
      ? (...a) => log.log(...a)
      : typeof log === "function"
        ? log
        : () => {};
  const error =
    typeof log?.error === "function"
      ? (...a) => log.error(...a)
      : typeof log === "function"
        ? log
        : () => {};

  // LAN-first pairing: when `.work/relay.json` was written by `2f pair` with
  // the LAN transport, this runtime is the host's own relay — it binds the
  // LAN interface and serves the phone the pairing page + relay protocol (see
  // src/server.mjs). A loopback-only runtime cannot serve the phone, so
  // `2f pair` restarts it when needed. `lan` is an explicit override for
  // callers/tests; by default the config decides, as before.
  let lanMode = lan;
  if (lanMode === undefined) {
    lanMode = false;
    try {
      const cfg = JSON.parse(
        await fs.readFile(path.join(base, ".work", "relay.json"), "utf8")
      );
      lanMode = cfg?.enabled === true && cfg?.transport === "lan";
    } catch {
      /* no pairing config — loopback-only runtime, as before */
    }
  }

  // Crash/reboot recovery before the server accepts a single request: a
  // client must never observe a "working" task whose worker is gone.
  const recovered = await recoverInterruptedRuns(base, { log });
  for (const task of recovered) {
    info(`startup recovery: task #${task.id} (${task.slug}) interrupted run marked failed`);
  }

  const handle = await startServer(base, port, { lan: lanMode });
  info(`0x2F UI: ${handle.url}${lanMode ? " (LAN pairing on)" : ""}`);
  // The HTTP server keeps the event loop alive — this process runs until it
  // is signalled (the runtime, like a local app, does not exit on its own).
  const agent = createRelayAgent({
    runtime: handle.runtime,
    configPath: path.join(base, ".work", "relay.json"),
    log
  });
  agent.start();

  // Graceful shutdown. Workers are detached (own session/process group): they
  // never receive this signal and keep running to completion. The runtime
  // only closes its own surfaces — the relay link, the HTTP server, the
  // tailer — then exits 0 (so a supervisor treats the shutdown as clean and,
  // where configured, brings the runtime straight back up).
  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) {
      info(`repeat ${signal} — exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    info(`${signal} received — shutting down the runtime (detached workers keep running)`);
    (async () => {
      try {
        agent.stop();
        await new Promise(resolve => setTimeout(resolve, SHUTDOWN_AGENT_GRACE_MS));
      } catch (e) {
        error(`relay agent shutdown failed: ${e?.message ?? e}`);
      }
      try {
        await handle.close();
      } catch (e) {
        error(`server close failed: ${e?.message ?? e}`);
      }
      process.exit(0);
    })();
    // Force-exit guard: a stuck close must not leave the runtime half-alive.
    const force = setTimeout(() => {
      error(`shutdown timed out after ${SHUTDOWN_FORCE_MS}ms — exiting`);
      process.exit(1);
    }, SHUTDOWN_FORCE_MS);
    force.unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { handle, agent, url: handle.url, recovered };
}
