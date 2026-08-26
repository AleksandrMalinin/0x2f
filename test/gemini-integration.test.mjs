// Gemini integration — real CLI, real worker, deterministic mock API.
//
// These tests exercise the REAL gemini binary end to end: the CLI creates a
// task, the real detached worker spawns `gemini -p --skip-trust -o
// stream-json`, and a local mock of the Gemini API
// (test/fixtures/gemini-api-mock.mjs) serves the model stream, so the full
// 0x2F path is verified without network or credentials — the same shape as
// the codex integration suite. The suite skips when the gemini executable is
// not resolvable (GEMINI_BIN override or PATH).
//
// The mock is reached through the CLI's gateway auth type
// (GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY + a gateway settings.json under
// GEMINI_CLI_HOME) — all verified against the real binary 0.57.0.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createStore } from "../src/core/store.mjs";
import { executableAvailable } from "../src/providers/index.mjs";
import { startGeminiApiMock } from "./fixtures/gemini-api-mock.mjs";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;

const RESULT_OK = "## Result\nhandled by mock gemini\n## Evidence\nran\n## Verification\nok\n## Needs human decision\nNone";

function geminiExecutable() {
  return process.env.GEMINI_BIN && executableAvailable(process.env.GEMINI_BIN, process.env)
    ? process.env.GEMINI_BIN
    : executableAvailable("gemini", process.env)
      ? "gemini"
      : null;
}

function runCli(base, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: base,
      env: { ...process.env, ...env },
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

async function waitForStatus(base, id, expected, opts = {}) {
  const store = createStore(base);
  const { timeout = 30000, tolerate = [] } = opts;
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    let task;
    try {
      task = await store.findTask(id);
    } catch {
      if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
      await new Promise(r => setTimeout(r, 60));
      continue;
    }
    if (task.status === expected) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 60));
  }
}

// A project whose gemini (GEMINI_BIN, gateway auth via GEMINI_CLI_HOME) talks
// to the mock API. Returns { base, home, geminiEnv }.
async function makeGeminiProject(mock) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-gemini-int-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "work-gemini-int-home-"));
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gemini", "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "gateway", useExternal: true } } })
  );
  const gemini = geminiExecutable();
  const geminiEnv = {
    GEMINI_BIN: gemini,
    GEMINI_CLI_HOME: home,
    GEMINI_API_KEY: "test-key",
    GOOGLE_GEMINI_BASE_URL: mock.url
  };
  return { base, home, geminiEnv };
}

test("E2E: `2f providers` detects gemini and a task runs to READY through the real CLI", async t => {
  const gemini = geminiExecutable();
  if (!gemini) {
    t.skip("gemini executable not available (set GEMINI_BIN or install Gemini CLI)");
    return;
  }
  const mock = await startGeminiApiMock({ steps: [{ text: RESULT_OK }] });
  const { base, home, geminiEnv } = await makeGeminiProject(mock);
  try {
    await runCli(base, ["init"], geminiEnv);
    const providers = await runCli(base, ["providers"], geminiEnv);
    assert.equal(providers.code, 0);
    assert.match(providers.out, /gemini\s+native\s+yes/);

    const created = await runCli(base, ["new", "Run through gemini", "--provider", "gemini"], geminiEnv);
    assert.equal(created.code, 0);
    assert.match(created.out, /Gemini CLI is running in the background\./);

    const task = await waitForStatus(base, 1, "ready");
    assert.equal(task.runs[0].provider, "gemini");
    assert.equal(task.runs[0].outcome, "ready");
    // The init event's session id persists on the run.
    assert.match(task.runs[0].externalSessionId, /^[0-9a-f-]{36}$/);
    assert.equal(task.execution.externalSessionId, task.runs[0].externalSessionId);

    const result = await fs.readFile(
      path.join(base, ".work", "tasks", task.slug, "result.md"),
      "utf8"
    );
    assert.match(result, /handled by mock gemini/);

    const opened = await runCli(base, ["open", "1"], geminiEnv);
    assert.match(opened.out, /gemini\s+\S+\s+READY/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("E2E: a gemini auth failure is normalized (failure.kind=auth) and RETRY works", async t => {
  const gemini = geminiExecutable();
  if (!gemini) {
    t.skip("gemini executable not available (set GEMINI_BIN or install Gemini CLI)");
    return;
  }
  const mock = await startGeminiApiMock({
    steps: [{ status: 401, message: "API key not valid. Please pass a valid API key." }]
  });
  const { base, home, geminiEnv } = await makeGeminiProject(mock);
  try {
    await runCli(base, ["init"], geminiEnv);
    const created = await runCli(base, ["new", "Auth fail then retry", "--provider", "gemini"], geminiEnv);
    assert.equal(created.code, 0);

    // The CLI emits a terminal `result` error event whose message carries the
    // API's 401 text — the provider classifies it as auth.
    const failed = await waitForStatus(base, 1, "failed");
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure.kind, "auth");
    assert.match(failed.error, /401|API key not valid/);
    assert.equal(failed.runs[0].outcome, "failed");

    // The task is intact: the user authenticates (mock now works) and RETRYs
    // the SAME task through gemini — run 2, same task, fresh session.
    await mock.close();
    const mock2 = await startGeminiApiMock({ steps: [{ text: "## Result\nretry succeeded\n## Needs human decision\nNone" }] });
    try {
      const rerun = await runCli(base, ["rerun", "1", "--provider", "gemini"], {
        ...geminiEnv,
        GOOGLE_GEMINI_BASE_URL: mock2.url
      });
      assert.equal(rerun.code, 0);
      const done = await waitForStatus(base, 1, "ready");
      assert.equal(done.runs.length, 2);
      assert.equal(done.runs[1].provider, "gemini");
      assert.equal(done.runs[1].outcome, "ready");
      const result = await fs.readFile(
        path.join(base, ".work", "tasks", done.slug, "result.md"),
        "utf8"
      );
      assert.match(result, /retry succeeded/);
    } finally {
      await mock2.close();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("E2E: a gemini decision needs_you is answered, and a rerun continues the task without losing context", async t => {
  const gemini = geminiExecutable();
  if (!gemini) {
    t.skip("gemini executable not available (set GEMINI_BIN or install Gemini CLI)");
    return;
  }
  const mock = await startGeminiApiMock({
    steps: [
      { text: "## Result\nblocked on a choice\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend should the retry use?" },
      { text: "## Result\ncontinued with the answer\n## Needs human decision\nNone" }
    ]
  });
  const { base, home, geminiEnv } = await makeGeminiProject(mock);
  try {
    await runCli(base, ["init"], geminiEnv);
    await runCli(base, ["new", "Decision flow", "--provider", "gemini"], geminiEnv);

    // The shared decision protocol -> needs_you (decision) — never a
    // permission block: Gemini's native headless mode has no permission
    // surface.
    const paused = await waitForStatus(base, 1, "needs_you");
    assert.equal(paused.blockedOn.type, "decision");
    assert.match(paused.blockedOn.text, /Which backend/);
    assert.equal(paused.runs[0].outcome, "needs_you");

    const answered = await runCli(base, ["answer", "1", "use backend A"], geminiEnv);
    assert.equal(answered.code, 0);
    await waitForStatus(base, 1, "needs_you");

    // The NEXT run is a fresh session that continues the task WITH the
    // answer in context (the prompt is rebuilt from task state).
    const rerun = await runCli(base, ["rerun", "1", "--provider", "gemini"], geminiEnv);
    assert.equal(rerun.code, 0);
    const done = await waitForStatus(base, 1, "ready");
    assert.equal(done.runs.length, 2);
    assert.equal(done.runs[1].outcome, "ready");
    assert.match(done.context.notes[0].text, /use backend A/);
    const run2Prompt = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "runs", "2", "prompt.md"),
      "utf8"
    );
    assert.match(run2Prompt, /use backend A/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("E2E: the same task can switch away from gemini to another provider without losing task context", async t => {
  const gemini = geminiExecutable();
  if (!gemini) {
    t.skip("gemini executable not available (set GEMINI_BIN or install Gemini CLI)");
    return;
  }
  const mock = await startGeminiApiMock({ steps: [{ text: RESULT_OK }] });
  const { base, home, geminiEnv } = await makeGeminiProject(mock);
  // A second, fake command provider in the same workspace.
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-gemini-int-bins-"));
  const fakeBin = path.join(bins, "other-agent");
  await fs.writeFile(
    fakeBin,
    "#!/usr/bin/env node\n" +
      'process.stdout.write("## Result\\nfrom other provider\\n## Needs human decision\\nNone");\n' +
      "process.exit(0);\n"
  );
  await fs.chmod(fakeBin, 0o755);
  const providersDir = path.join(base, ".work", "providers");
  await fs.mkdir(providersDir, { recursive: true });
  await fs.writeFile(
    path.join(providersDir, "other.json"),
    JSON.stringify({
      id: "other",
      displayName: "Other Agent",
      transport: "command",
      command: [fakeBin, "--task", "{prompt}"]
    })
  );
  try {
    await runCli(base, ["init"], geminiEnv);
    await runCli(base, ["new", "Switch providers", "--provider", "gemini"], geminiEnv);
    const first = await waitForStatus(base, 1, "ready");
    assert.equal(first.runs[0].provider, "gemini");

    // Rerun the SAME task through a different provider: run 2 under the same
    // task, gemini's result preserved in history.
    const rerun = await runCli(base, ["rerun", "1", "--provider", "other"], geminiEnv);
    assert.equal(rerun.code, 0);
    const done = await waitForStatus(base, 1, "ready");
    assert.equal(done.runs.length, 2);
    assert.equal(done.runs[0].provider, "gemini");
    assert.equal(done.runs[0].outcome, "ready");
    assert.equal(done.runs[1].provider, "other");
    assert.equal(done.runs[1].outcome, "ready");

    const result = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "result.md"),
      "utf8"
    );
    assert.match(result, /from other provider/);
    // Gemini's own result survives per-run.
    const run1Result = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "runs", "1", "result.md"),
      "utf8"
    );
    assert.match(run1Result, /handled by mock gemini/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(bins, { recursive: true, force: true });
  }
});
