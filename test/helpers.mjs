// Shared test helpers.
//
// Provider availability is a runtime/execution fact resolved from the
// environment (PATH, DSH_BIN, CLAUDE_BIN, ...). Tests that select a native
// provider explicitly must make it deterministically AVAILABLE — otherwise
// the suite would depend on which vendor CLIs happen to be installed on the
// machine running it. These helpers point a provider's bin env var at a tiny
// fake executable for the duration of one test, exactly like the per-file
// helpers in deepseek-harness.test.mjs and provider-equivalence.test.mjs.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Write a tiny executable that prints `stdout` and exits with `code`.
// Returns the absolute bin path (and its dir for cleanup).
export async function fakeExecutable({ name = "bin", stdout = "", code = 0, dir } = {}) {
  const d = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-bin-")));
  const bin = path.join(d, name);
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.exit(${code});\n`
  );
  await fs.chmod(bin, 0o755);
  return { bin, dir: d };
}

// Set env[name] = value for the duration of fn(); restores afterwards.
export function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

// Run `fn` with a provider's bin env var (DSH_BIN, CLAUDE_BIN, ...) pointing
// at a real executable, so `providers.available(id)` resolves true for the
// duration — provider-selection tests behave identically on any machine.
export async function withFakeBin(envVar, name, fn) {
  const { bin, dir } = await fakeExecutable({ name });
  try {
    return await withEnv(envVar, bin, fn);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// --- local-API authentication -------------------------------------------------
//
// The local runtime API is token-gated (see src/server.mjs). Tests that start
// a real server inject a fixed token and authenticate with the x-0x2f-auth
// header (the programmatic path; the browser path is the shell cookie).

export const TEST_AUTH_TOKEN = "0x2f-test-auth-token";

export function authHeaders(token = TEST_AUTH_TOKEN) {
  return { "x-0x2f-auth": token };
}
