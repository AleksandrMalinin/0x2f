// Codex integration — real CLI, real worker, deterministic mock model.
//
// These tests exercise the REAL codex binary end to end: the CLI creates a
// task, the real detached worker spawns `codex exec --json`, and a local
// mock of the Responses API (test/fixtures/codex-responses-mock.mjs) serves
// the model stream, so the full 0x2F path is verified without network or
// credentials. The suite skips when the codex executable is not resolvable
// (CODEX_BIN override or PATH), so it stays green on machines without Codex.
//
// CODEX_SANDBOX=bypass is set because the seatbelt sandbox cannot apply
// inside this sandboxed test environment (verified: sandbox_apply EPERM);
// on a normal machine the provider defaults to `-s workspace-write`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createStore } from "../src/core/store.mjs";
import { executableAvailable } from "../src/providers/index.mjs";
import {
  startCodexResponsesMock,
  messageStream,
  commandExecutionStream
} from "./fixtures/codex-responses-mock.mjs";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;

function codexExecutable() {
  return process.env.CODEX_BIN && executableAvailable(process.env.CODEX_BIN, process.env)
    ? process.env.CODEX_BIN
    : executableAvailable("codex", process.env)
      ? "codex"
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
  const { timeout = 20000, tolerate = [] } = opts;
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

// A project with its own CODEX_HOME whose config.toml points at the mock,
// plus the environment the CLI/worker need to find codex. Returns
// { base, codexHome, codexEnv }.
async function makeCodexProject(mock) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-codex-int-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-codex-int-home-"));
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    `model = "gpt-5.1-codex"\nmodel_provider = "mock"\n\n[model_providers.mock]\nname = "Mock Responses API"\nbase_url = "${mock.url}/v1"\nwire_api = "responses"\n`
  );
  const codex = codexExecutable();
  const codexEnv = {
    CODEX_HOME: codexHome,
    CODEX_BIN: codex,
    CODEX_SANDBOX: "bypass"
  };
  return { base, codexHome, codexEnv };
}

test("E2E: `2f providers` detects codex and a task runs to READY through the real CLI", async t => {
  const codex = codexExecutable();
  if (!codex) {
    t.skip("codex executable not available (set CODEX_BIN or install Codex CLI)");
    return;
  }
  const mock = await startCodexResponsesMock([
    {
      events: messageStream(
        "## Result\nHandled by codex\n## Evidence\nran\n## Changes\nnone\n## Verification\nok\n## Needs human decision\nNone"
      )
    }
  ]);
  const { base, codexHome, codexEnv } = await makeCodexProject(mock);
  try {
    await runCli(base, ["init"], codexEnv);
    const providers = await runCli(base, ["providers"], codexEnv);
    assert.equal(providers.code, 0);
    assert.match(providers.out, /codex\s+native\s+yes/);

    const created = await runCli(base, ["new", "Run through codex", "--provider", "codex"], codexEnv);
    assert.equal(created.code, 0);
    assert.match(created.out, /Codex is running in the background\./);

    const task = await waitForStatus(base, 1, "ready");
    assert.equal(task.runs[0].provider, "codex");
    assert.equal(task.runs[0].outcome, "ready");
    // The session id (thread id) persists on the run.
    assert.match(task.runs[0].externalSessionId, /^[0-9a-f-]{36}$/);
    assert.equal(task.execution.externalSessionId, task.runs[0].externalSessionId);

    const result = await fs.readFile(
      path.join(base, ".work", "tasks", task.slug, "result.md"),
      "utf8"
    );
    assert.match(result, /Handled by codex/);

    const opened = await runCli(base, ["open", "1"], codexEnv);
    assert.match(opened.out, /codex\s+\S+\s+READY/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("E2E: a codex auth failure is normalized (failure.kind=auth) and RETRY works", async t => {
  const codex = codexExecutable();
  if (!codex) {
    t.skip("codex executable not available (set CODEX_BIN or install Codex CLI)");
    return;
  }
  // First turn: the provider returns 401 (auth). Codex retries 5x then
  // turn.failed — the provider classifies it as auth.
  const mock = await startCodexResponsesMock([
    { error: { status: 401, message: "Invalid API key provided" } }
  ]);
  const { base, codexHome, codexEnv } = await makeCodexProject(mock);
  try {
    await runCli(base, ["init"], codexEnv);
    const created = await runCli(base, ["new", "Auth fail then retry", "--provider", "codex"], codexEnv);
    assert.equal(created.code, 0);

    const failed = await waitForStatus(base, 1, "failed");
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure.kind, "auth");
    assert.equal(failed.failure.remedy, "codex login");
    assert.match(failed.error, /401|Invalid API key/);
    assert.equal(failed.runs[0].outcome, "failed");

    // The task is intact: the user authenticates (mock now works) and RETRYs
    // the SAME task through codex — run 2, same task, fresh session.
    await mock.close();
    const mock2 = await startCodexResponsesMock([
      { events: messageStream("## Result\nretry succeeded\n## Needs human decision\nNone") }
    ]);
    try {
      // Re-point the project's CODEX_HOME config at the working mock, then
      // rerun the SAME task in place.
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        `model = "gpt-5.1-codex"\nmodel_provider = "mock"\n\n[model_providers.mock]\nname = "Mock Responses API"\nbase_url = "${mock2.url}/v1"\nwire_api = "responses"\n`
      );
      const rerun = await runCli(base, ["rerun", "1", "--provider", "codex"], codexEnv);
      assert.equal(rerun.code, 0);
      const done = await waitForStatus(base, 1, "ready");
      assert.equal(done.runs.length, 2);
      assert.equal(done.runs[1].provider, "codex");
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
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("E2E: command_execution is recorded honestly as tool activity, never as file.changed", async t => {
  const codex = codexExecutable();
  if (!codex) {
    t.skip("codex executable not available (set CODEX_BIN or install Codex CLI)");
    return;
  }
  // Two turns: first the model runs a shell command (command_execution),
  // then it reports the result.
  const mock = await startCodexResponsesMock([
    {
      events: commandExecutionStream({
        command: "printf 'x' > note.txt",
        output: "x\n",
        exitCode: 0
      })
    },
    {
      events: messageStream("## Result\nwrote the file\n## Needs human decision\nNone")
    }
  ]);
  const { base, codexHome, codexEnv } = await makeCodexProject(mock);
  try {
    await runCli(base, ["init"], codexEnv);
    await runCli(base, ["new", "Tool activity", "--provider", "codex"], codexEnv);
    const task = await waitForStatus(base, 1, "ready");

    // The run's event log records the tool honestly.
    const store = createStore(base);
    const events = await store.readEvents(task.slug);
    const toolStarted = events.filter(e => e.type === "tool.started");
    assert.ok(toolStarted.length >= 1, "tool.started recorded");
    const cmd = toolStarted.find(e => e.input?.command?.includes("note.txt"));
    assert.ok(cmd, "the exact command is recorded");
    // Codex exec never emits file_change items — and this adapter must never
    // fabricate a file.changed from command text.
    assert.ok(!events.some(e => e.type === "file.changed"), "no fabricated file.changed");

    const result = await fs.readFile(
      path.join(base, ".work", "tasks", task.slug, "result.md"),
      "utf8"
    );
    assert.match(result, /wrote the file/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("E2E: a codex decision needs_you is answered, and a rerun continues the task without losing context", async t => {
  const codex = codexExecutable();
  if (!codex) {
    t.skip("codex executable not available (set CODEX_BIN or install Codex CLI)");
    return;
  }
  const mock = await startCodexResponsesMock([
    {
      events: messageStream(
        "## Result\nblocked on a choice\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend should the retry use?"
      )
    },
    {
      events: messageStream(
        "## Result\ncontinued with the answer\n## Needs human decision\nNone"
      )
    }
  ]);
  const { base, codexHome, codexEnv } = await makeCodexProject(mock);
  try {
    await runCli(base, ["init"], codexEnv);
    await runCli(base, ["new", "Decision flow", "--provider", "codex"], codexEnv);

    // The shared decision protocol -> needs_you (decision) — never a
    // permission block: Codex has no human-in-the-loop permission surface.
    const paused = await waitForStatus(base, 1, "needs_you");
    assert.equal(paused.blockedOn.type, "decision");
    assert.match(paused.blockedOn.text, /Which backend/);
    assert.equal(paused.runs[0].outcome, "needs_you");

    // Answering records the decision with the task; the task stays needs_you
    // until rerun (answer is not a resume — Codex has no permission grants).
    const answered = await runCli(base, ["answer", "1", "use backend A"], codexEnv);
    assert.equal(answered.code, 0);
    const afterAnswer = await waitForStatus(base, 1, "needs_you");

    // The NEXT run is a fresh session that continues the task WITH the
    // answer in context (the prompt is rebuilt from task state).
    const rerun = await runCli(base, ["rerun", "1", "--provider", "codex"], codexEnv);
    assert.equal(rerun.code, 0);
    const done = await waitForStatus(base, 1, "ready");
    assert.equal(done.runs.length, 2);
    assert.equal(done.runs[1].outcome, "ready");
    assert.match(done.context.notes[0].text, /use backend A/);
    // The per-run prompt for run 2 carries the accumulated context.
    const run2Prompt = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "runs", "2", "prompt.md"),
      "utf8"
    );
    assert.match(run2Prompt, /use backend A/);
    assert.match(afterAnswer.status, /needs_you/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("E2E: the same task can switch away from codex to another provider without losing task context", async t => {
  const codex = codexExecutable();
  if (!codex) {
    t.skip("codex executable not available (set CODEX_BIN or install Codex CLI)");
    return;
  }
  const mock = await startCodexResponsesMock([
    { events: messageStream("## Result\nfrom codex\n## Needs human decision\nNone") }
  ]);
  const { base, codexHome, codexEnv } = await makeCodexProject(mock);
  // A second, fake command provider in the same workspace.
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-codex-int-bins-"));
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
    await runCli(base, ["init"], codexEnv);
    await runCli(base, ["new", "Switch providers", "--provider", "codex"], codexEnv);
    const first = await waitForStatus(base, 1, "ready");
    assert.equal(first.runs[0].provider, "codex");

    // Rerun the SAME task through a different provider: run 2 under the same
    // task, codex's result preserved in history.
    const rerun = await runCli(base, ["rerun", "1", "--provider", "other"], codexEnv);
    assert.equal(rerun.code, 0);
    const done = await waitForStatus(base, 1, "ready");
    assert.equal(done.runs.length, 2);
    assert.equal(done.runs[0].provider, "codex");
    assert.equal(done.runs[0].outcome, "ready");
    assert.equal(done.runs[1].provider, "other");
    assert.equal(done.runs[1].outcome, "ready");

    const result = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "result.md"),
      "utf8"
    );
    assert.match(result, /from other provider/);
    // Codex's own result survives per-run.
    const run1Result = await fs.readFile(
      path.join(base, ".work", "tasks", done.slug, "runs", "1", "result.md"),
      "utf8"
    );
    assert.match(run1Result, /from codex/);
  } finally {
    await mock.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(bins, { recursive: true, force: true });
  }
});
