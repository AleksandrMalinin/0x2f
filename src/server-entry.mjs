#!/usr/bin/env node
// The foreground 0x2F runtime — the background process `2f ui` spawns and the
// process a supervisor (systemd / launchd) keeps alive on a dedicated host.
//
//   node server-entry.mjs <base> <port>
//
// This is the SAME server the tests start (src/server.mjs); the entry wires
// argv to serveRuntime (src/serve.mjs) and keeps the process alive as a local
// app. The launcher (src/ui.mjs) spawns it detached, waits until /api/health
// answers, and opens the browser. Its output is captured to .work/ui.log.
// The argv contract (<base> <port>) is load-bearing: `2f pair`'s LAN restart
// matches it, and the service units in deploy/ use it.
//
// A `--no-browser` 2f ui still uses this entry: starting the runtime and
// opening the browser are separate steps, and the launcher owns both.
//
// Remote control: the same process also runs the relay agent (the outbound
// link to the 0x2F relay), so "0x2F is running" and "remote control is on"
// share one lifecycle. The agent is inert until `.work/relay.json` is
// written by `2f pair`.
//
// Startup recovery + graceful shutdown live in src/serve.mjs: on start, tasks
// left "working" with a dead worker pid are marked failed/crashed (reboot
// recovery, src/recover.mjs); SIGTERM/SIGINT close the runtime cleanly
// without terminating detached workers.

import { serveRuntime } from "./serve.mjs";

const [, , base, portArg] = process.argv;
const port = portArg ? Number(portArg) : 4242;

try {
  if (!base) throw new Error("usage: node server-entry.mjs <base> <port>");
  await serveRuntime({ base, port, log: console });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
