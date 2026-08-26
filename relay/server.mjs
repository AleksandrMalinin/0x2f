// 0x2F Relay — private deployment entry point.
//
// The relay implementation lives in src/relay/server.mjs (the local product
// mounts it in-process for LAN pairing, so it ships with the package). This
// file is the STANDALONE hosted-relay entry: terminate TLS in front of it
// (Caddy/nginx), keep state in relay/data/state.json, and deploy from the
// repository — it is private infrastructure, never shipped in the npm
// package.
//
//   node server.mjs --port 8080 --host 127.0.0.1 --data ./data/state.json

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRelayServer } from "../src/relay/server.mjs";

export { createRelayServer };

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const opt = key => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(opt("--port") ?? 8080);
  const host = opt("--host") ?? "127.0.0.1";
  const dataFile = opt("--data") ?? path.resolve(fileURLToPath(new URL("./data/state.json", import.meta.url)));
  const relay = createRelayServer({ dataFile, host, port });
  const handle = await relay.start();
  console.log(`0x2F Relay: http://${host}:${handle.port}`);
  console.log(`  state:      ${dataFile}`);
  console.log("Terminate TLS in front of this (Caddy/nginx). The Mac connects outbound; no inbound ports are needed.");
  console.log("This relay is an opaque broker: it routes E2E-encrypted envelopes and holds no task content.");
}
