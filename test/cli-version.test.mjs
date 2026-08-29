// CLI version smoke test: `2f version` / `2f --version` / `2f -v` print the
// installed package version and nothing else.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;
const VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
).version;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (err += c));
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}

for (const flag of ["version", "--version", "-v"]) {
  test(`2f ${flag} prints the package version only`, async () => {
    const res = await runCli([flag]);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.equal(res.out.trim(), VERSION);
    assert.equal(res.err.trim(), "");
  });
}
