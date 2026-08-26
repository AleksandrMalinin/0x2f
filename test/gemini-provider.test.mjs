// Gemini provider — native adapter boundary tests.
//
// These tests pin the provider WITHOUT relying on the real Gemini CLI being
// authenticated: the stream-json parser is exercised with REAL fixture shapes
// captured/verified against gemini 0.57.0 (test/fixtures/gemini-*.jsonl), and
// start()/resume() are exercised end-to-end with a tiny fake `gemini` binary
// via GEMINI_BIN — the same pattern as the codex/deepseek-harness tests. The
// tests also pin the honest capability declaration (verified in
// docs/gemini-capability-map.md): resume + structured events + file changes
// from mutating tool_use, but NO human-in-the-loop permission surface.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  geminiProvider,
  geminiBin,
  geminiApprovalArgs,
  classifyGeminiFailure,
  normalizeGeminiRun,
  createGeminiParser,
  consumeGeminiLine
} from "../src/providers/gemini.mjs";
import { EVENT_TYPES } from "../src/core/events.mjs";

const FIXTURES = new URL("./fixtures/", import.meta.url);

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function parseFixture(text) {
  const events = [];
  const state = createGeminiParser(e => events.push(e));
  for (const line of text.split("\n")) consumeGeminiLine(state, line);
  return { state, events };
}

// Write a fake `gemini` executable that prints `stdout` (the JSONL event
// stream), writes `stderr`, and exits with `code`. Returns the bin path;
// callers set GEMINI_BIN to it.
async function fakeGemini({ stdout = "", stderr = "", code = 0, argsLogPath = null }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-gemini-"));
  const bin = path.join(dir, "gemini");
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

async function withGeminiBin(bin, fn) {
  const previous = process.env.GEMINI_BIN;
  process.env.GEMINI_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GEMINI_BIN;
    else process.env.GEMINI_BIN = previous;
  }
}

// ---------------------------------------------------------------------------
// capability declaration (the verified map)
// ---------------------------------------------------------------------------

test("gemini is registered with honest capabilities", () => {
  assert.equal(geminiProvider.id, "gemini");
  assert.equal(geminiProvider.displayName, "Gemini CLI");
  // Verified against gemini 0.57.0 — see docs/gemini-capability-map.md:
  // --resume <uuid> continues the same session with prior context; -o
  // stream-json emits structured events (init/message/tool_use/tool_result/
  // result); mutating tool_use events carry file_path; shell tool_use carries
  // the command; but native headless mode has NO human-in-the-loop permission
  // surface (headless policy default is deny; ask_user auto-denies with no
  // confirmation listener).
  assert.equal(geminiProvider.capabilities.supportsResume, true);
  assert.equal(geminiProvider.capabilities.supportsStructuredEvents, true);
  assert.equal(geminiProvider.capabilities.supportsFileChanges, true);
  assert.equal(geminiProvider.capabilities.supportsCommands, true);
  assert.equal(geminiProvider.capabilities.supportsPermissionRequests, false);
  assert.equal(geminiProvider.capabilities.supportsSandbox, false);
  assert.equal(geminiProvider.capabilities.supportsStreaming, true);
  assert.equal(geminiProvider.capabilities.resultOnCompletion, false);
  assert.equal(typeof geminiProvider.resume, "function");
});

test("geminiBin honors GEMINI_BIN", () => {
  const previous = process.env.GEMINI_BIN;
  process.env.GEMINI_BIN = "/some/where/gemini";
  try {
    assert.equal(geminiBin(), "/some/where/gemini");
  } finally {
    if (previous === undefined) delete process.env.GEMINI_BIN;
    else process.env.GEMINI_BIN = previous;
  }
});

test("geminiApprovalArgs: auto_edit is the default; yolo/default are explicit overrides", () => {
  const previous = process.env.GEMINI_APPROVAL_MODE;
  try {
    delete process.env.GEMINI_APPROVAL_MODE;
    assert.deepEqual(geminiApprovalArgs(), ["--approval-mode", "auto_edit"]);
    process.env.GEMINI_APPROVAL_MODE = "yolo";
    assert.deepEqual(geminiApprovalArgs(), ["--approval-mode", "yolo"]);
    process.env.GEMINI_APPROVAL_MODE = "default";
    assert.deepEqual(geminiApprovalArgs(), []);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_APPROVAL_MODE;
    else process.env.GEMINI_APPROVAL_MODE = previous;
  }
});

// ---------------------------------------------------------------------------
// failure classification (auth)
// ---------------------------------------------------------------------------

test("classifyGeminiFailure: no-auth exit 41 classifies with the settings/API-key remedy", () => {
  const failure = classifyGeminiFailure(
    "Please set an Auth method in your /tmp/gemini-home/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    41
  );
  assert.ok(failure);
  assert.equal(failure.kind, "auth");
  assert.match(failure.remedy, /gemini/);
});

test("classifyGeminiFailure: in-run API auth text classifies even with a non-auth exit code", () => {
  for (const text of [
    "API key not valid. Please pass a valid API key.",
    '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
    "unexpected status 401 Unauthorized: Invalid API key",
    "not authenticated",
    "authentication_error"
  ]) {
    const failure = classifyGeminiFailure(text, 144);
    assert.ok(failure, `classifies: ${text}`);
    assert.equal(failure.kind, "auth");
  }
});

test("classifyGeminiFailure: non-auth failures stay unclassified", () => {
  for (const text of [
    "Error resuming session: No previous sessions found for this project.",
    "Reached max session turns for this session.",
    "Tool execution denied by policy.",
    "The model returned an empty response."
  ]) {
    assert.equal(classifyGeminiFailure(text, 42), null, text);
  }
});

// ---------------------------------------------------------------------------
// outcome normalization (pure)
// ---------------------------------------------------------------------------

test("normalizeGeminiRun: successful result -> ready with the session id", () => {
  const outcome = normalizeGeminiRun({
    text: "## Result\nfixed it",
    sessionId: "s-1",
    result: { status: "success" }
  });
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.result, "## Result\nfixed it");
  assert.equal(outcome.externalSessionId, "s-1");
});

test("normalizeGeminiRun: result text with the shared decision protocol -> needs_you/decision", () => {
  const outcome = normalizeGeminiRun({
    text: "## Result\ninvestigated\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend?",
    sessionId: "s-2",
    result: { status: "success" }
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.equal(outcome.blockedOn.type, "decision");
  assert.match(outcome.blockedOn.text, /Which backend/);
  assert.equal(outcome.externalSessionId, "s-2");
});

test("normalizeGeminiRun: result error -> failed with auth classification", () => {
  const outcome = normalizeGeminiRun({
    text: "Starting...",
    sessionId: "s-3",
    result: {
      status: "error",
      error: { type: "FatalAuthenticationError", message: "API key not valid. Please pass a valid API key." }
    }
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /API key not valid/);
  assert.equal(outcome.failure.kind, "auth");
  assert.equal(outcome.externalSessionId, "s-3");
});

test("normalizeGeminiRun: no result event is failed, never ready — even on exit 0", () => {
  // A SIGTERM-cancelled gemini exits 0 WITHOUT a terminal result event.
  const outcome = normalizeGeminiRun({
    text: "## Result\nhalf done",
    sessionId: "s-4",
    sawEvent: true,
    exitCode: 0
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /without completing/);
  assert.equal(outcome.externalSessionId, "s-4");
});

test("normalizeGeminiRun: no output at all reads as the install/auth prompt", () => {
  const outcome = normalizeGeminiRun({ sawEvent: false, exitCode: 0, stderr: "" });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /no output.*installed and authenticated/);
});

test("normalizeGeminiRun: no-auth exit 41 with the settings message classifies as auth", () => {
  const outcome = normalizeGeminiRun({
    sawEvent: false,
    exitCode: 41,
    stderr:
      "Please set an Auth method in your /tmp/gemini-home/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA"
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.kind, "auth");
  assert.equal(outcome.externalSessionId, undefined);
});

// ---------------------------------------------------------------------------
// stream-json parser (deterministic fixture tests)
// ---------------------------------------------------------------------------

test("parser: a completed run maps to run.started + tool events + file.changed + ready", async () => {
  const { state, events } = parseFixture(await fixture("gemini-events.jsonl"));

  assert.equal(state.sessionId, "7943655b-c503-43dc-8b6b-3aeb23c4b3f9");
  // Assistant deltas concatenate into the final result text.
  assert.equal(
    state.assistantText,
    "## Result\ninvestigated the retry window\n## Verification\nran npm test\n"
  );
  assert.equal(state.result.status, "success");

  // Normalized event vocabulary only.
  for (const event of events) {
    assert.ok(
      EVENT_TYPES.includes(event.type) || event.type === "tool.completed",
      `event ${event.type} is Work vocabulary`
    );
  }

  assert.deepEqual(events[0], {
    type: "run.started",
    sessionId: "7943655b-c503-43dc-8b6b-3aeb23c4b3f9"
  });
  const tools = events.filter(e => e.type === "tool.started");
  // A ReadFile is tool activity, never a change.
  assert.deepEqual(tools[0], {
    type: "tool.started",
    name: "ReadFile",
    input: { file_path: "src/core/router.mjs" }
  });
  // An Edit mutates the file — file.changed is emitted, like the Claude
  // adapter's MUTATING set.
  assert.deepEqual(tools[1], {
    type: "tool.started",
    name: "Edit",
    input: {
      file_path: "src/core/router.mjs",
      old_string: "const A = 1",
      new_string: "const A = 2"
    }
  });
  assert.ok(events.some(e => e.type === "file.changed" && e.path === "src/core/router.mjs"));
  // A shell command surfaces the exact command.
  assert.deepEqual(tools[2], {
    type: "tool.started",
    name: "run_shell_command",
    input: { command: "npm test", dir_path: "." }
  });
  assert.equal(events.filter(e => e.type === "tool.completed").length, 3);
  assert.ok(events.some(e => e.type === "progress" && e.text === "## Result\n"));

  const outcome = normalizeGeminiRun({
    text: state.assistantText,
    sessionId: state.sessionId,
    result: state.result
  });
  assert.equal(outcome.status, "ready");
  assert.equal(outcome.externalSessionId, "7943655b-c503-43dc-8b6b-3aeb23c4b3f9");
});

test("parser: the shared decision protocol in the result -> needs_you/decision", async () => {
  const { state } = parseFixture(await fixture("gemini-decision.jsonl"));
  const outcome = normalizeGeminiRun({
    text: state.assistantText,
    sessionId: state.sessionId,
    result: state.result
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.match(outcome.blockedOn.text, /Which backend should the retry use/);
  assert.equal(outcome.externalSessionId, "b17f9d2e-1111-4f2a-9c33-000000000001");
});

test("parser: a handled fatal error maps to failed with auth classification", async () => {
  const { state } = parseFixture(await fixture("gemini-failed.jsonl"));
  assert.equal(state.result.status, "error");
  const outcome = normalizeGeminiRun({
    text: state.assistantText,
    sessionId: state.sessionId,
    result: state.result,
    stderr: ""
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failure.kind, "auth");
  assert.equal(outcome.externalSessionId, "c3d2a1b0-2222-4f3b-8d44-000000000002");
});

test("parser: an interrupted run (no result event) stays failed despite exit 0", async () => {
  const { state } = parseFixture(await fixture("gemini-interrupted.jsonl"));
  assert.equal(state.result, null);
  const outcome = normalizeGeminiRun({
    text: state.assistantText,
    sessionId: state.sessionId,
    sawEvent: true,
    exitCode: 0
  });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /without completing/);
});

test("parser: stray non-JSON lines are ignored without breaking the stream", () => {
  const { state } = parseFixture(
    '{"type":"init","session_id":"t-9","model":"auto"}\n' +
      "NOT_JSON\n" +
      '{"type":"message","role":"assistant","content":"ok","delta":true}\n' +
      '{"type":"result","status":"success"}\n'
  );
  assert.equal(state.sessionId, "t-9");
  assert.equal(state.assistantText, "ok");
  assert.equal(state.result.status, "success");
});

test("parser: transient error events (severity warning/error) never decide the outcome", () => {
  const { state, events } = parseFixture(
    '{"type":"init","session_id":"t-10","model":"auto"}\n' +
      '{"type":"error","severity":"warning","message":"Agent execution blocked: X"}\n' +
      '{"type":"error","severity":"error","message":"INVALID_STREAM"}\n' +
      '{"type":"message","role":"assistant","content":"done","delta":true}\n' +
      '{"type":"result","status":"success"}\n'
  );
  assert.ok(!events.some(e => e.type === "progress" && /blocked|INVALID/.test(e.text)));
  assert.equal(state.result.status, "success");
  const outcome = normalizeGeminiRun({
    text: state.assistantText,
    sessionId: state.sessionId,
    result: state.result
  });
  assert.equal(outcome.status, "ready");
});

// ---------------------------------------------------------------------------
// start()/resume() with a fake gemini binary (spawn + normalize path)
// ---------------------------------------------------------------------------

test("start() runs gemini -p stream-json and normalizes a successful run", async () => {
  const stdout = await fixture("gemini-events.jsonl");
  const { bin, dir } = await fakeGemini({ stdout });
  try {
    await withGeminiBin(bin, async () => {
      const events = [];
      const outcome = await geminiProvider.start({
        cwd: dir,
        prompt: "Inspect the retry window",
        onEvent: e => events.push(e)
      });

      assert.equal(outcome.status, "ready");
      assert.equal(outcome.result, "## Result\ninvestigated the retry window\n## Verification\nran npm test\n");
      assert.equal(outcome.externalSessionId, "7943655b-c503-43dc-8b6b-3aeb23c4b3f9");
      assert.ok(events.some(e => e.type === "run.started"));
      assert.ok(events.some(e => e.type === "tool.started"));
      assert.ok(events.some(e => e.type === "file.changed"));
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

test("start() passes -m model and the approval mode; surfaces a no-auth exit 41", async () => {
  const argsLog = path.join(os.tmpdir(), `gemini-args-${Date.now()}.json`);
  const { bin, dir } = await fakeGemini({
    stderr:
      "Please set an Auth method in your /tmp/gemini-home/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    code: 41,
    argsLogPath: argsLog
  });
  try {
    await withGeminiBin(bin, async () => {
      const outcome = await geminiProvider.start({
        cwd: dir,
        prompt: "x",
        model: "gemini-3-flash-preview"
      });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.failure.kind, "auth");

      const args = JSON.parse(await fs.readFile(argsLog, "utf8"));
      assert.equal(args[0], "-p");
      assert.equal(args[1], "x"); // the prompt follows -p
      assert.ok(args.includes("--skip-trust"));
      assert.ok(args.includes("-o"));
      assert.ok(args.includes("stream-json"));
      assert.ok(args.includes("--approval-mode"));
      assert.ok(args.includes("auto_edit"));
      assert.ok(args.includes("-m"));
      assert.ok(args.includes("gemini-3-flash-preview"));
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(argsLog, { force: true });
  }
});

test("resume() resumes the SAME session via --resume <uuid> and carries the grant prompt", async () => {
  const argsLog = path.join(os.tmpdir(), `gemini-args-${Date.now()}.json`);
  const stdout = await fixture("gemini-events.jsonl");
  const { bin, dir } = await fakeGemini({ stdout, argsLogPath: argsLog });
  try {
    await withGeminiBin(bin, async () => {
      const outcome = await geminiProvider.resume({
        cwd: dir,
        externalSessionId: "7943655b-c503-43dc-8b6b-3aeb23c4b3f9",
        grant: "continue",
        onEvent: () => {}
      });
      assert.equal(outcome.status, "ready");

      const args = JSON.parse(await fs.readFile(argsLog, "utf8"));
      assert.ok(args.includes("--resume"));
      assert.ok(args.includes("7943655b-c503-43dc-8b6b-3aeb23c4b3f9"));
      assert.ok(args.some(a => a.includes("Continue the task from where you left off")));
      // Never --resume latest: a missing session must be a real failure.
      assert.ok(!args.includes("latest"));
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(argsLog, { force: true });
  }
});

test("resume() with a missing session (exit 42) fails with the resume error, unclassified", async () => {
  const { bin, dir } = await fakeGemini({
    stderr: "Error resuming session: No previous sessions found for this project.",
    code: 42
  });
  try {
    await withGeminiBin(bin, async () => {
      const outcome = await geminiProvider.resume({
        cwd: dir,
        externalSessionId: "00000000-0000-0000-0000-000000000000",
        grant: "continue"
      });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /No previous sessions found/);
      assert.equal(outcome.failure, undefined);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resume() without a session id fails loudly", async () => {
  await assert.rejects(
    () => geminiProvider.resume({ cwd: "/tmp", externalSessionId: null }),
    /No external session id/
  );
});

test("start() fails cleanly when gemini is not installed", async () => {
  const { dir } = await fakeGemini({});
  const missing = path.join(dir, "does-not-exist");
  try {
    await withGeminiBin(missing, async () => {
      const outcome = await geminiProvider.start({ cwd: dir, prompt: "x" });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /Could not start gemini/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
