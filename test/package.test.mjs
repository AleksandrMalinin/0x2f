// Distribution boundary — what `npm pack` would actually ship.
//
// The user-facing package must contain only the local product: the `src/`
// tree plus metadata. Backend/hosted-relay implementation, operator-only
// docs, tests, fixtures, examples, state, secrets, source maps and lockfiles
// must never ship. This test inspects the REAL packed artifact (npm pack
// --dry-run), not just package.json's "files" field.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

test("the packed artifact ships only the local product", () => {
  const cache = path.join(os.tmpdir(), "0x2f-pack-cache-" + process.pid);
  let stdout;
  try {
    stdout = execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--cache", cache],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
  } finally {
    try {
      fs.rmSync(cache, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const [pkg] = JSON.parse(stdout);
  const files = pkg.files.map(f => f.path);

  // Everything is either metadata or under src/.
  for (const file of files) {
    assert.ok(
      file === "LICENSE" || file === "README.md" || file === "package.json" || file.startsWith("src/"),
      `unexpected packed file: ${file}`
    );
  }

  // Things that must NEVER ship.
  for (const file of files) {
    assert.ok(!file.startsWith("relay/"), `private relay must not ship: ${file}`);
    assert.ok(!file.startsWith("docs/"), `internal docs must not ship: ${file}`);
    assert.ok(!file.startsWith("test/"), `tests must not ship: ${file}`);
    assert.ok(!file.startsWith("examples/"), `examples must not ship: ${file}`);
    assert.ok(!/\.env/.test(file), `env files must not ship: ${file}`);
    assert.ok(!/\.map$/.test(file), `source maps must not ship: ${file}`);
    assert.ok(!file.includes("node_modules"), `dependencies must not ship: ${file}`);
    assert.ok(!file.startsWith(".work"), `runtime state must not ship: ${file}`);
    assert.ok(file !== "package-lock.json", "lockfiles are not shipped");
  }

  // The private relay server implementation specifically.
  assert.ok(!files.includes("relay/server.mjs"), "the relay server implementation must not ship");

  // The local product's client surface is complete.
  for (const needed of [
    "src/server.mjs",
    "src/cli.mjs",
    "src/tui/index.mjs",
    "src/web/app.js",
    "src/web/index.html",
    "src/web/pair.html",
    "src/web/pair.mjs",
    "src/web/e2e.mjs",
    "src/web/remote.mjs",
    "src/relay/agent.mjs",
    "src/relay/protocol.mjs"
  ]) {
    assert.ok(files.includes(needed), `missing shipped file: ${needed}`);
  }
});
