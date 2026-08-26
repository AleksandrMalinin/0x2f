// Vendor the pure-JS crypto implementation into src/web/vendor/.
//
// Why: WebCrypto's `subtle` API is only available in secure contexts (https,
// or http://localhost). A phone pairing page served over plain http on the
// Mac's LAN address is NOT a secure context, so the phone cannot derive the
// pairing key with `crypto.subtle` — the LAN-first flow needs a pure-JS
// fallback (@noble/hashes + @noble/ciphers, audited, zero-dependency, works
// identically in browser and Node).
//
// The browser also cannot resolve bare specifiers ("@noble/hashes/…"), so the
// needed modules are copied here with bare imports rewritten to relative
// paths, and the runtime server serves them (src/server.mjs ASSETS) exactly
// like the rest of the client.
//
// Usage (after bumping the @noble/* versions in package.json):
//   node scripts/vendor-crypto.mjs
// and commit src/web/vendor/.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src", "web", "vendor");

// Only what the E2E channel needs: PBKDF2-HMAC-SHA256 and AES-256-GCM.
const ENTRIES = [
  "node_modules/@noble/hashes/esm/pbkdf2.js",
  "node_modules/@noble/hashes/esm/sha2.js",
  "node_modules/@noble/ciphers/esm/aes.js"
];

function outPathFor(mod) {
  const m = mod.match(/node_modules\/(@noble\/[^/]+)\/esm\/(.+)$/);
  if (!m) throw new Error(`unexpected noble module path: ${mod}`);
  return path.join(OUT, m[1], m[2]);
}

const seen = new Set();
const copied = [];

async function walk(mod) {
  const abs = path.join(ROOT, mod);
  if (seen.has(abs)) return;
  seen.add(abs);
  let src = await fs.readFile(abs, "utf8");
  // Bare noble specifiers -> relative paths inside the vendored tree (the
  // browser cannot resolve bare specifiers; the exports map is not available).
  src = src.replace(/from ['"]@noble\/(hashes|ciphers)\/([^'"]+)['"]/g, (m, pkg, file) => {
    // The exports map ("@noble/hashes/crypto" -> esm/crypto.js) is not
    // available to the browser; rewrite to the relative vendored file.
    if (!file.endsWith(".js")) file += ".js";
    const target = path.join("node_modules", "@noble", pkg, "esm", file);
    let rel = path.relative(path.dirname(outPathFor(mod)), outPathFor(target));
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `from ${JSON.stringify(rel)}`;
  });
  const out = outPathFor(mod);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, src);
  copied.push(path.relative(OUT, out));
  for (const m of src.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
    const rel = path.resolve(path.dirname(abs), m[1]);
    if (rel.startsWith(path.join(ROOT, "node_modules", "@noble"))) {
      await walk(path.relative(ROOT, rel));
    }
  }
}

await fs.rm(OUT, { recursive: true, force: true });
for (const entry of ENTRIES) await walk(entry);
console.log(`Vendored ${copied.length} files into src/web/vendor/:`);
for (const f of copied.sort()) console.log("  " + f);
