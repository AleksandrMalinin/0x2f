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

import { startServer } from "./server.mjs";

const [, , base, portArg] = process.argv;
const port = portArg ? Number(portArg) : 4242;

try {
  const handle = await startServer(base, port);
  console.log(`0x2F UI: ${handle.url}`);
  // The HTTP server keeps the event loop alive — this process runs until
  // it is killed (the runtime, like a local app, does not exit on its own).
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
