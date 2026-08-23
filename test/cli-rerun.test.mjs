// CLI smoke test for run history — the real dogfooding loop, end to end:
//
//   2f init
//   2f new "…"                      (run 01 · claude-code)
//   2f rerun 1 --provider deepseek-harness   (run 02 · deepseek-harness)
//   2f open 1                        -> RUNS strip with both runs
//   2f open 1 --run 2                -> that run's factual detail
//
// The CLI spawns the real worker, which runs the real provider adapters
// against fake CLIs (CLAUDE_BIN / DSH_BIN), so this exercises the same path a
// real `2f rerun` takes — persistence, lifecycle, and rendering included.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createStore } from "../src/core/store.mjs";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;

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

async function fakeClaudeBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-cli-claude-"));
  const bin = path.join(dir, "claude");
  const events = [
    { type: "system", subtype: "init", session_id: "sess-cli" },
    {
      type: "result",
      is_error: false,
      session_id: "sess-cli",
      result:
        "## Result\nfixed by claude\n## Verification\nnpm test\n## Needs human decision\nNone"
    }
  ];
  const body =
    "#!/usr/bin/env node\n" +
    "const events = " + JSON.stringify(events) + ";\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + \"\\n\");\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return bin;
}

async function fakeDshBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-cli-dsh-"));
  const bin = path.join(dir, "dsh");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "process.stdout.write(" +
      JSON.stringify("## Result\nfixed by dsh\n## Needs human decision\nNone") +
      ");\nprocess.exit(0);\n"
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

async function waitForStatus(base, id, expected, timeout = 10000) {
  const store = createStore(base);
  const start = Date.now();
  while (true) {
    const task = await store.findTask(id);
    if (task.status === expected) return task;
    if (task.status !== "working") {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 60));
  }
}

test("CLI: the dogfooding loop — new, rerun through another provider, open, open --run", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-cli-"));
  try {
    const claudeBin = await fakeClaudeBin();
    const dshBin = await fakeDshBin();
    const env = { CLAUDE_BIN: claudeBin, DSH_BIN: dshBin };

    const init = await runCli(base, ["init"], env);
    assert.equal(init.code, 0);

    const created = await runCli(base, ["new", "Investigate why retry state is lost"], env);
    assert.equal(created.code, 0);
    assert.match(created.out, /Created #001: Investigate why retry state is lost/);
    assert.match(created.out, /Claude Code is running in the background\./);

    await waitForStatus(base, 1, "ready");

    const rerun = await runCli(base, ["rerun", "1", "--provider", "deepseek-harness"], env);
    assert.equal(rerun.code, 0);
    assert.match(rerun.out, /Run 02 started with DeepSeek Harness in the background\./);

    await waitForStatus(base, 1, "ready");

    // The same task now carries two runs, one per provider, both preserved.
    const store = createStore(base);
    const task = await store.findTask(1);
    assert.equal(task.runs.length, 2);
    assert.equal(task.runs[0].provider, "claude-code");
    assert.equal(task.runs[0].outcome, "ready");
    assert.equal(task.runs[1].provider, "deepseek-harness");
    assert.equal(task.runs[1].outcome, "ready");

    const opened = await runCli(base, ["open", "1"], env);
    assert.equal(opened.code, 0);
    assert.match(opened.out, /RUNS/);
    assert.match(opened.out, /01\s+claude-code\s+\S+\s+READY/);
    assert.match(opened.out, /02\s+deepseek-harness\s+\S+\s+READY/);

    const runDetail = await runCli(base, ["open", "1", "--run", "2"], env);
    assert.equal(runDetail.code, 0);
    assert.match(runDetail.out, /RUN 02 — DeepSeek Harness/);
    assert.match(runDetail.out, /Provider\s+DeepSeek Harness/);
    assert.match(runDetail.out, /Outcome\s+READY/);
    assert.match(runDetail.out, /fixed by dsh/);

    const missingRun = await runCli(base, ["open", "1", "--run", "9"], env);
    assert.notEqual(missingRun.code, 0);
    assert.match(missingRun.err, /has no run 9/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
