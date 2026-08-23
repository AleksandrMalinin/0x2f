// DeepSeek Harness provider — the second real execution provider.
//
// These tests pin the provider boundary WITHOUT DeepSeek Harness installed:
// DSH_BIN points at tiny fake `dsh` scripts, so the adapter's spawn +
// normalization path is exercised end-to-end. They also pin the honest
// capability declaration (headless DSH cannot resume, stream events, or ask
// permission) and the pure outcome normalizer.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepseekHarnessProvider, normalizeDshRun } from "../src/providers/deepseek-harness.mjs";
import { EVENT_TYPES } from "../src/core/events.mjs";

// Write a fake `dsh` executable that prints `stdout`, writes `stderr`, and
// exits with `code`. Returns the bin path; callers set DSH_BIN to it.
async function fakeDsh({ stdout = "", stderr = "", code = 0 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-dsh-"));
  const bin = path.join(dir, "dsh");
  const body = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`;
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

async function withDshBin(bin, fn) {
  const previous = process.env.DSH_BIN;
  process.env.DSH_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previous;
  }
}

test("deepseek-harness is registered with honest capabilities", () => {
  assert.equal(deepseekHarnessProvider.id, "deepseek-harness");
  assert.equal(deepseekHarnessProvider.displayName, "DeepSeek Harness");
  // Headless DSH (0.1.1-rc.2) creates a fresh session per run, prints only
  // the final assistant text, and runs tools without approval prompts. These
  // are declared differences, not bugs to paper over.
  assert.equal(deepseekHarnessProvider.capabilities.supportsResume, false);
  assert.equal(deepseekHarnessProvider.capabilities.supportsStructuredEvents, false);
  assert.equal(deepseekHarnessProvider.capabilities.supportsPermissionRequests, false);
  assert.equal(deepseekHarnessProvider.capabilities.supportsStreaming, false);
  assert.equal(deepseekHarnessProvider.resume, undefined);
});

test("normalizeDshRun: exit 0 -> ready with the final assistant text", () => {
  const outcome = normalizeDshRun({ code: 0, stdout: "## Result\nfixed it" });
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.result, "## Result\nfixed it");
});

test("normalizeDshRun: exit 0 + decision section -> needs_you/decision (shared Work convention)", () => {
  const outcome = normalizeDshRun({
    code: 0,
    stdout: "## Result\ninvestigated\n\n## Needs human decision\nWhich backend?"
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.equal(outcome.blockedOn.type, "decision");
  assert.match(outcome.blockedOn.text, /Which backend/);
});

test("normalizeDshRun: exit 1 -> failed with the stderr message", () => {
  const outcome = normalizeDshRun({ code: 1, stdout: "", stderr: "dsh: E_AGENT: agent failed\n" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /E_AGENT/);
});

test("normalizeDshRun: exit 1 without stderr -> failed with a code message", () => {
  const outcome = normalizeDshRun({ code: 1 });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /exited with code 1/);
});

test("start() runs dsh --profile headless and normalizes a successful run", async () => {
  const { bin, dir } = await fakeDsh({ stdout: "the fix is in" });
  try {
    await withDshBin(bin, async () => {
      const events = [];
      const outcome = await deepseekHarnessProvider.start({
        cwd: dir,
        prompt: "Please fix the bug",
        onEvent: e => events.push(e)
      });

      assert.equal(outcome.status, "ready");
      assert.equal(outcome.result, "the fix is in");
      // Only events reliably derivable from the headless CLI: run.started.
      assert.deepEqual(events, [{ type: "run.started", sessionId: null }]);
      for (const event of events) {
        assert.ok(EVENT_TYPES.includes(event.type), `event ${event.type} is Work vocabulary`);
      }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("start() maps a failing dsh run to failed", async () => {
  const { bin, dir } = await fakeDsh({ stderr: "dsh: E_TIMEOUT: timed out", code: 1 });
  try {
    await withDshBin(bin, async () => {
      const outcome = await deepseekHarnessProvider.start({ cwd: dir, prompt: "x" });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /E_TIMEOUT/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("start() fails cleanly when dsh is not installed", async () => {
  const { dir } = await fakeDsh({});
  const missing = path.join(dir, "does-not-exist");
  try {
    await withDshBin(missing, async () => {
      const outcome = await deepseekHarnessProvider.start({ cwd: dir, prompt: "x" });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /Could not start dsh/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
