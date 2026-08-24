#!/usr/bin/env node
// The detached 0x2F UI runtime — the background process `2f ui` spawns.
//
//   node server-entry.mjs <base> <port>
//
// This is the SAME server the tests start (src/server.mjs); the entry only
// wires argv to startServer and keeps the process alive as a local app. The
// launcher (src/ui.mjs) spawns it detached, waits until /api/providers
// answers, and opens the browser. Its output is captured to .work/ui.log.
//
// A `--no-browser` 2f ui still uses this entry: starting the runtime and
// opening the browser are separate steps, and the launcher owns both.
//
// Remote control: the same process also runs the relay agent (the outbound
// link to the 0x2F relay), so "0x2F is running" and "remote control is on"
// share one lifecycle. The agent is inert until `.work/relay.json` is
// written by `2f pair`.

import path from "node:path";
import { startServer } from "./server.mjs";
import { createRelayAgent } from "./relay/agent.mjs";

const [, , base, portArg] = process.argv;
const port = portArg ? Number(portArg) : 4242;

try {
  const handle = await startServer(base, port);
  console.log(`0x2F UI: ${handle.url}`);
  // The HTTP server keeps the event loop alive — this process runs until
  // it is killed (the runtime, like a local app, does not exit on its own).
  const agent = createRelayAgent({
    runtime: handle.runtime,
    configPath: path.join(base, ".work", "relay.json"),
    log: console
  });
  agent.start();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
