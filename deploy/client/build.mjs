// Assemble the static client bundle for the hosted client origin.
//
// The browser client imports modules at root-relative paths (/app/*,
// /relay/protocol.mjs, /core/title.mjs), so the hosted origin must serve the
// exact same layout the local runtime serves (src/server.mjs ASSETS). This
// script copies those files into a directory you upload to any static host
// (or point Caddy at with `root *`).
//
// Usage:
//   node deploy/client/build.mjs [outDir]     (default: deploy/client/dist)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = path.join(ROOT, "deploy", "client", "dist");

// [src-relative file, route, mime]. Must stay in sync with src/server.mjs
// ASSETS — the local runtime and the hosted client origin serve the same
// files at the same routes. The route is the URL path (the local server maps
// "/pair" -> web/pair.html, "/" -> web/index.html, ...).
export const CLIENT_ASSETS = [
  ["src/web/index.html", "/", "text/html; charset=utf-8"],
  ["src/web/pair.html", "/pair", "text/html; charset=utf-8"],
  ["src/web/app.css", "/app/app.css", "text/css; charset=utf-8"],
  ["src/web/app.js", "/app/app.js", "text/javascript; charset=utf-8"],
  ["src/web/e2e.mjs", "/app/e2e.mjs", "text/javascript; charset=utf-8"],
  ["src/web/pair.mjs", "/app/pair.mjs", "text/javascript; charset=utf-8"],
  ["src/web/pair.css", "/app/pair.css", "text/css; charset=utf-8"],
  ["src/web/remote.mjs", "/app/remote.mjs", "text/javascript; charset=utf-8"],
  ["src/web/ledger.mjs", "/app/ledger.mjs", "text/javascript; charset=utf-8"],
  ["src/web/sound-policy.mjs", "/app/sound-policy.mjs", "text/javascript; charset=utf-8"],
  ["src/web/sound.mjs", "/app/sound.mjs", "text/javascript; charset=utf-8"],
  ["src/relay/protocol.mjs", "/relay/protocol.mjs", "text/javascript; charset=utf-8"],
  ["src/core/title.mjs", "/core/title.mjs", "text/javascript; charset=utf-8"],
  // Pure-JS crypto fallback for plain-http LAN phones (src/web/vendor/ — see
  // scripts/vendor-crypto.mjs). The phone imports these relatively from
  // /app/e2e.mjs, so the hosted client origin must serve them too.
  ...VENDOR_CRYPTO_FILES.map(file => [
    `src/web/vendor/${file}`,
    `/app/vendor/${file}`,
    "text/javascript; charset=utf-8"
  ])
];

// The transitive file graph vendored from @noble/hashes + @noble/ciphers.
// Kept in sync with scripts/vendor-crypto.mjs and src/server.mjs.
const VENDOR_CRYPTO_FILES = [
  "@noble/hashes/pbkdf2.js",
  "@noble/hashes/sha2.js",
  "@noble/hashes/_md.js",
  "@noble/hashes/_u64.js",
  "@noble/hashes/crypto.js",
  "@noble/hashes/hmac.js",
  "@noble/hashes/utils.js",
  "@noble/ciphers/aes.js",
  "@noble/ciphers/_polyval.js",
  "@noble/ciphers/utils.js"
];

// Route -> file on disk. Two extensionless routes differ from their file
// name; every other route is exactly the file path.
const ROUTE_FILE = { "/": "index.html", "/pair": "pair.html" };

export function routeToFile(route) {
  return ROUTE_FILE[route] ?? route.slice(1);
}

export async function buildClient(outDir = DEFAULT_OUT) {
  const out = path.resolve(outDir);
  await fs.rm(out, { recursive: true, force: true });
  for (const [src, route, mime] of CLIENT_ASSETS) {
    const target = path.join(out, routeToFile(route));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, src), target);
  }
  // MIME hints for hosts that need them (Netlify _headers). Harmless elsewhere.
  const headers = CLIENT_ASSETS
    .filter(([, , mime]) => mime.startsWith("text/javascript"))
    .map(([, route]) => `  ${route}\n    Content-Type: text/javascript; charset=utf-8`)
    .join("\n");
  await fs.writeFile(path.join(out, "_headers"), headers + "\n");
  return out;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const out = await buildClient(process.argv[2]);
  console.log(`Client bundle -> ${out}`);
  console.log("Upload this directory to your static host, or point Caddy at it:");
  console.log("  app.0x2f.dev { root * " + out + "; file_server }");
}
