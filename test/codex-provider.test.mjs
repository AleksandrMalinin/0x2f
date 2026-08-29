// Codex provider — native adapter boundary tests.
//
// These tests pin the provider WITHOUT relying on the real Codex CLI being
// installed: the JSONL event parser is exercised with REAL fixtures captured
// from codex-cli 0.149.1 (test/fixtures/codex-*.jsonl), and start()/resume()
// are exercised end-to-end with a tiny fake `codex` binary via CODEX_BIN —
// the same pattern as the deepseek-harness tests. The tests also pin the
// honest capability declaration (verified in docs/codex-capability-map.md):
// resume + structured events + commands, but NO file changes and NO
// human-in-the-loop permission surface.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  codexProvider,
  codexBin,
  classifyCodexFailure,
  normalizeCodexRun,
  createCodexParser,
  consumeCodexLine
} from "../src/providers/codex.mjs";
import { EVENT_TYPES } from "../src/core/events.mjs";

const FIXTURES = new URL("./fixtures/", import.meta.url);

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function parseFixture(text) {
  const events = [];
  const state = createCodexParser(e => events.push(e));
  for (const line of text.split("\n")) consumeCodexLine(state, line);
  return { state, events };
}

// Write a fake `codex` executable that prints `stdout` (the JSONL event
// stream), writes `stderr`, and exits with `code`. Returns the bin path;
// callers set CODEX_BIN to it.
async function fakeCodex({ stdout = "", stderr = "", code = 0, argsLogPath = null }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-codex-"));
  const bin = path.join(dir, "codex");
  const body = `#!/usr/bin/env node
${argsLogPath ? `require("fs").writeFileSync(${JSON.stringify(argsLogPath)}, JSON.stringify(process.argv.slice(2)));` : ""}
process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`;
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

async function withCodexBin(bin, fn) {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}

// ---------------------------------------------------------------------------
// capability declaration (the verified map)
// ---------------------------------------------------------------------------

test("codex is registered with honest capabilities", () => {
  assert.equal(codexProvider.id, "codex");
  assert.equal(codexProvider.displayName, "Codex");
  // Verified against codex-cli 0.149.1 — see docs/codex-capability-map.md:
  // exec resume continues the same thread with prior context; exec --json
  // emits structured events and command_execution items; but file_change
  // items are never emitted by exec, and there is no human-in-the-loop
  // permission surface (approval policy is Never, request_user_input is
  // Default-mode-unavailable, queue targets the daemon).
  assert.equal(codexProvider.capabilities.supportsResume, true);
  assert.equal(codexProvider.capabilities.supportsStructuredEvents, true);
  assert.equal(codexProvider.capabilities.supportsFileChanges, false);
  assert.equal(codexProvider.capabilities.supportsCommands, true);
  assert.equal(codexProvider.capabilities.supportsPermissionRequests, false);
  assert.equal(codexProvider.capabilities.supportsSandbox, false);
  assert.equal(codexProvider.capabilities.supportsStreaming, true);
  assert.equal(codexProvider.capabilities.resultOnCompletion, false);
  assert.equal(typeof codexProvider.resume, "function");
});

test("codexBin honors CODEX_BIN", () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = "/some/where/codex";
  try {
    assert.equal(codexBin(), "/some/where/codex");
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});

// ---------------------------------------------------------------------------
// failure classification (auth)
// ---------------------------------------------------------------------------

test("classifyCodexFailure: auth failures classify with the codex login remedy", () => {
  const cases = [
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    "Invalid API key provided",
    "Could not parse your authentication token. Please try signing in again.",
    "not authenticated"
  ];
  for (const text of cases) {
    const failure = classifyCodexFailure(text);
    assert.ok(failure, `classifies: ${text}`);
    assert.equal(failure.kind, "auth");
    assert.equal(failure.remedy, "codex login");
  }
});

test("classifyCodexFailure: non-auth failures stay unclassified", () => {
  for (const text of [
    "We're currently experiencing high demand, which may cause temporary errors.",
    "stream disconnected before completion",
    "tool apply_patch invoked with incompatible payload"
  ]) {
    assert.equal(classifyCodexFailure(text), null, text);
  }
});

// ---------------------------------------------------------------------------
// outcome normalization (pure)
// ---------------------------------------------------------------------------

test("normalizeCodexRun: result text -> ready with the session id", () => {
  const outcome = normalizeCodexRun({ text: "## Result\nfixed it", threadId: "t-1" });
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.result, "## Result\nfixed it");
  assert.equal(outcome.externalSessionId, "t-1");
});

test("normalizeCodexRun: result with the shared decision protocol -> needs_you/decision", () => {
  const outcome = normalizeCodexRun({
    text: "## Result\ninvestigated\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend?",
    threadId: "t-2"
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.equal(outcome.blockedOn.type, "decision");
  assert.match(outcome.blockedOn.text, /Which backend/);
  assert.equal(outcome.externalSessionId, "t-2");
});

test("normalizeCodexRun: an explicit blocker report is failed, never READY", () => {
  const outcome = normalizeCodexRun({
    text: "## Result\nI could not continue because the sandbox blocked writes to the workspace.\n## Changes\nNone",
    threadId: "t-3"
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.kind, "blocked");
  assert.match(outcome.error, /could not continue/);
  // A failed run still carries the session id it surfaced.
  assert.equal(outcome.externalSessionId, "t-3");
});

test("normalizeCodexRun: a partial limitation inside a completed result is still ready", () => {
  const outcome = normalizeCodexRun({
    text: "## Result\nThe fix is complete. I could not run the integration tests because the sandbox blocks network access.\n## Changes\n- src/fix.mjs"
  });
  assert.equal(outcome.status, "ready");
});

test("normalizeCodexRun: error -> failed with auth classification", () => {
  const outcome = normalizeCodexRun({
    error: "unexpected status 401 Unauthorized: Invalid API key provided"
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.kind, "auth");
  assert.equal(outcome.failure.remedy, "codex login");
  assert.equal(outcome.externalSessionId, undefined);
});

// ---------------------------------------------------------------------------
// JSONL event parser (deterministic fixture tests)
// ---------------------------------------------------------------------------

test("parser: a completed run maps to run.started + tool events + ready", async () => {
  const { state, events } = parseFixture(await fixture("codex-events.jsonl"));

  assert.equal(state.threadId, "01a03e5d-2ef3-7422-8f50-c49ef0edbd18");
  assert.equal(state.lastAgentText, "Done: I ran the tool.");
  assert.equal(state.turnCompleted, true);
  assert.equal(state.turnFailed, null);

  // Normalized event vocabulary only — tool.completed is part of the
  // provider→worker contract (claude-code emits it too) but is not a stored
  // log event; the worker records tool.started and drops the completion,
  // exactly as it does for claude-code.
  for (const event of events) {
    assert.ok(
      EVENT_TYPES.includes(event.type) || event.type === "tool.completed",
      `event ${event.type} is Work vocabulary`
    );
  }

  assert.deepEqual(events[0], {
    type: "run.started",
    sessionId: "01a03e5d-2ef3-7422-8f50-c49ef0edbd18"
  });
  // The command_execution item surfaces the exact command — the honest tool
  // activity signal, with no fabricated file.changed.
  assert.deepEqual(events[1], {
    type: "tool.started",
    name: "command_execution",
    input: { command: "/bin/zsh -lc 'echo TOOL_RAN_OK && pwd'" }
  });
  assert.deepEqual(events[2], { type: "tool.completed", isError: false });
  // The agent's final message is progress (and becomes the result).
  assert.deepEqual(events[3], { type: "progress", text: "Done: I ran the tool." });
  // NO file.changed was fabricated from command text.
  assert.ok(!events.some(e => e.type === "file.changed"));
});

test("parser: an auth failure maps to a failed outcome with classification", async () => {
  const { state, events } = parseFixture(await fixture("codex-failed-auth.jsonl"));
  assert.equal(state.turnFailed.message, "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.");
  const outcome = normalizeCodexRun({
    error: state.turnFailed.message,
    threadId: state.threadId
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.kind, "auth");
  assert.equal(outcome.failure.remedy, "codex login");
  assert.equal(outcome.externalSessionId, "01a03e69-836c-7dc1-932a-3eab048620d9");
});

test("parser: the shared decision protocol in the result -> needs_you/decision", async () => {
  const { state } = parseFixture(await fixture("codex-decision.jsonl"));
  const outcome = normalizeCodexRun({ text: state.lastAgentText, threadId: state.threadId });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.match(outcome.blockedOn.text, /Which backend should the retry use/);
});

test("parser: reasoning summaries surface as progress, never as the result", async () => {
  const { state, events } = parseFixture(await fixture("codex-reasoning.jsonl"));
  assert.ok(events.some(e => e.type === "progress" && e.text === "mock reasoning summary"));
  assert.equal(state.lastAgentText, "Final answer.");
  const outcome = normalizeCodexRun({ text: state.lastAgentText, threadId: state.threadId });
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.result, "Final answer.");
});

test("parser: transient reconnect notices are ignored (not task progress)", () => {
  const { events } = parseFixture(
    '{"type":"thread.started","thread_id":"t-9"}\n' +
      '{"type":"turn.started"}\n' +
      '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected)"}\n' +
      '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}\n' +
      '{"type":"turn.completed","usage":{}}\n'
  );
  assert.ok(!events.some(e => e.type === "progress"));
});

test("parser: stray non-JSON lines are ignored without breaking the stream", () => {
  const { state } = parseFixture(
    '{"type":"thread.started","thread_id":"t-10"}\n' +
      "NOT_JSON\n" +
      '{"type":"turn.completed","usage":{}}\n'
  );
  assert.equal(state.threadId, "t-10");
  assert.equal(state.turnCompleted, true);
});

// ---------------------------------------------------------------------------
// start()/resume() with a fake codex binary (spawn + normalize path)
// ---------------------------------------------------------------------------

test("start() runs codex exec --json and normalizes a successful run", async () => {
  const stdout = await fixture("codex-events.jsonl");
  const { bin, dir } = await fakeCodex({ stdout });
  try {
    await withCodexBin(bin, async () => {
      const events = [];
      const outcome = await codexProvider.start({
        cwd: dir,
        prompt: "Run a tool",
        onEvent: e => events.push(e)
      });

      assert.equal(outcome.status, "ready");
      assert.equal(outcome.result, "Done: I ran the tool.");
      assert.equal(outcome.externalSessionId, "01a03e5d-2ef3-7422-8f50-c49ef0edbd18");
      assert.ok(events.some(e => e.type === "run.started"));
      assert.ok(events.some(e => e.type === "tool.started"));
      for (const event of events) {
        assert.ok(
          EVENT_TYPES.includes(event.type) || event.type === "tool.completed"
        );
      }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("start() passes -m model when provided and surfaces a failed turn", async () => {
  const argsLog = path.join(os.tmpdir(), `codex-args-${Date.now()}.json`);
  const stdout = await fixture("codex-failed-auth.jsonl");
  const { bin, dir } = await fakeCodex({ stdout, argsLogPath: argsLog });
  try {
    await withCodexBin(bin, async () => {
      const outcome = await codexProvider.start({
        cwd: dir,
        prompt: "x",
        model: "gpt-5.6-luna"
      });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.failure.kind, "auth");

      const args = JSON.parse(await fs.readFile(argsLog, "utf8"));
      assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
      assert.ok(args.includes("-m"), "model flag present");
      assert.ok(args.includes("gpt-5.6-luna"), "model value present");
      assert.equal(args.at(-1), "x");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(argsLog, { force: true });
  }
});

test("resume() resumes the SAME thread via codex exec resume <id>", async () => {
  const argsLog = path.join(os.tmpdir(), `codex-args-${Date.now()}.json`);
  const stdout = await fixture("codex-events.jsonl");
  const { bin, dir } = await fakeCodex({ stdout, argsLogPath: argsLog });
  try {
    await withCodexBin(bin, async () => {
      const events = [];
      const outcome = await codexProvider.resume({
        cwd: dir,
        externalSessionId: "thread-abc",
        grant: "continue",
        onEvent: e => events.push(e)
      });
      assert.equal(outcome.status, "ready");
      assert.equal(outcome.externalSessionId, "01a03e5d-2ef3-7422-8f50-c49ef0edbd18");

      const args = JSON.parse(await fs.readFile(argsLog, "utf8"));
      assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-abc"]);
      assert.ok(args.includes("--json"));
      assert.ok(args.some(a => a.includes("Continue the task")));
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(argsLog, { force: true });
  }
});

test("resume() without a session id fails loudly", async () => {
  await assert.rejects(
    () => codexProvider.resume({ cwd: "/tmp", externalSessionId: null }),
    /No external session id/
  );
});

test("start() fails cleanly when codex is not installed", async () => {
  const { dir } = await fakeCodex({});
  const missing = path.join(dir, "does-not-exist");
  try {
    await withCodexBin(missing, async () => {
      const outcome = await codexProvider.start({ cwd: dir, prompt: "x" });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /Could not start codex/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
