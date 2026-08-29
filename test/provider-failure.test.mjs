// Provider failure classification (dogfood review §01) — "PROVIDER NOT
// AUTHENTICATED".
//
// Dogfooding found a FAILED task presenting a vendor 401 as if it were the
// task's own breakage: "Failed to authenticate. API Error: 401 OAuth access
// token has expired. Re-authenticate to continue." was shown in the FAILED
// AT slot verbatim, which reads as "your work broke" when the actual state
// is "the provider is signed out, the task is intact, and the fix is four
// words in a terminal".
//
// The fix classifies the failure at the provider boundary — the only place
// vendor vocabulary is legal to read — and adds an optional `failure: {
// kind, remedy? }` to the normalized outcome (core/lifecycle.mjs). Only
// "auth" is classified today; anything else renders exactly as before.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyClaudeFailure,
  normalizeOutcome,
  claudeCodeProvider,
  claudeBin
} from "../src/providers/claude-code.mjs";
import { applyOutcome, FAILURE_KINDS } from "../src/core/lifecycle.mjs";
import { withEnv } from "./helpers.mjs";

// --- classification (pure) --------------------------------------------------

test("classifyClaudeFailure: the exact dogfooding 401 message is classified as auth", () => {
  const failure = classifyClaudeFailure(
    "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."
  );
  assert.deepEqual(failure, { kind: "auth", remedy: "claude /login" });
});

test("classifyClaudeFailure: an ordinary execution failure is not classified", () => {
  assert.equal(classifyClaudeFailure("TypeError: cannot read property 'x' of undefined"), null);
  assert.equal(classifyClaudeFailure("npm test failed with 3 failing specs"), null);
});

test("classifyClaudeFailure: other common auth phrasings are also recognized", () => {
  for (const text of [
    "Error: not authenticated. Run `claude login`.",
    "invalid api key provided",
    "authentication_error: invalid x-api-key",
    "Please re-authenticate to continue."
  ]) {
    assert.equal(classifyClaudeFailure(text)?.kind, "auth", text);
  }
});

// --- normalizeOutcome integration ------------------------------------------

test("normalizeOutcome: an is_error result with an auth message carries failure.kind=auth", () => {
  const outcome = normalizeOutcome({
    type: "result",
    is_error: true,
    session_id: "sess-1",
    errors: ["Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."]
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.");
  assert.deepEqual(outcome.failure, { kind: "auth", remedy: "claude /login" });
});

test("normalizeOutcome: an ordinary is_error result carries no failure classification", () => {
  const outcome = normalizeOutcome({
    type: "result",
    is_error: true,
    session_id: "sess-1",
    errors: ["command exited 1"]
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure, undefined);
});

// --- applyOutcome (core/lifecycle.mjs) --------------------------------------

test("applyOutcome persists a recognized failure.kind onto the task", () => {
  const task = { id: 1, status: "working" };
  const next = applyOutcome(task, {
    status: "failed",
    error: "401 OAuth access token has expired.",
    failure: { kind: "auth", remedy: "claude /login" }
  });
  assert.deepEqual(next.failure, { kind: "auth", remedy: "claude /login" });
  assert.equal(next.error, "401 OAuth access token has expired.");
});

test("applyOutcome drops an unrecognized failure.kind — no unvetted string reaches the UI", () => {
  const task = { id: 1, status: "working" };
  const next = applyOutcome(task, {
    status: "failed",
    error: "boom",
    failure: { kind: "not-a-real-kind" }
  });
  assert.equal(next.failure, undefined);
  assert.deepEqual(FAILURE_KINDS, ["auth", "unavailable", "crashed", "blocked"]);
});

test("applyOutcome clears a stale failure once the task recovers (needs_you / ready)", () => {
  const failed = { id: 1, status: "failed", failure: { kind: "auth", remedy: "claude /login" } };
  const resumed = applyOutcome(failed, { status: "needs_you", blockedOn: { type: "permission" } });
  assert.equal(resumed.failure, undefined);
  const readied = applyOutcome(failed, { status: "ready", result: "done" });
  assert.equal(readied.failure, undefined);
});

// --- the process-exit path (a real spawn, not just the structured result) --
//
// The dogfooding failure actually surfaced through a non-JSON stderr exit
// (the CLI refused to even start a session), not through a stream-json
// `result` event — so the classification must also run on that path.

async function fakeClaudeBin({ stderr, code }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-claude-"));
  const bin = path.join(dir, "claude");
  await fs.writeFile(
    bin,
    `#!/usr/bin/env node\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\n` +
      `process.exit(${code});\n`
  );
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

test("a real process exit on a 401 stderr message classifies as auth", async () => {
  const { bin, dir } = await fakeClaudeBin({
    stderr: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    code: 1
  });
  try {
    await withEnv("CLAUDE_BIN", bin, async () => {
      assert.equal(claudeBin(), bin);
      const outcome = await claudeCodeProvider.start({ cwd: dir, prompt: "do the thing" });
      assert.equal(outcome.status, "failed");
      assert.deepEqual(outcome.failure, { kind: "auth", remedy: "claude /login" });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a real process exit on an unrelated crash is not classified", async () => {
  const { bin, dir } = await fakeClaudeBin({ stderr: "segmentation fault", code: 139 });
  try {
    await withEnv("CLAUDE_BIN", bin, async () => {
      const outcome = await claudeCodeProvider.start({ cwd: dir, prompt: "do the thing" });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.failure, undefined);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
