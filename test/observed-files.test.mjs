// Repository-observed file changes, end to end through the real worker.
//
// A provider that does not declare file-change reporting (DeepSeek Harness
// headless, Codex exec) still leaves its work in the working tree. The
// worker captures a git baseline before the run and records observed
// file.changed events (source "worktree") when the run ends — so the Web UI
// and the TUI can show "N files changed" without faking the provider's
// capability. This drives the REAL worker + REAL provider adapter against a
// fake `dsh` in a throwaway git repository.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
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

function git(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function waitForStatus(base, id, expected, timeout = 15000) {
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

// A fake `dsh` that creates a file in its working directory (the workspace)
// and reports a completed result — exactly what a real headless run leaves
// in the tree without any file-change reporting.
async function fakeDshThatWritesFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-observed-dsh-"));
  const bin = path.join(dir, "dsh");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "require('fs').writeFileSync('made-by-run.txt', 'produced during the run\\n');\n" +
      "process.stdout.write('## Result\\ndone');\n" +
      "process.exit(0);\n"
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

test("worker records repository-observed file.changed events for a provider without file-change reporting", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-observed-"));
  try {
    // A real git repo so the observation has a baseline; .work is ignored so
    // 0x2F's own bookkeeping never counts as a run's change.
    await git(["init"], base);
    await fs.writeFile(path.join(base, ".gitignore"), ".work/\nnode_modules/\n");
    await fs.writeFile(path.join(base, "seed.txt"), "before\n");

    const dshBin = await fakeDshThatWritesFile();
    const env = { DSH_BIN: dshBin };

    const init = await runCli(base, ["init"], env);
    assert.equal(init.code, 0);
    const created = await runCli(base, ["new", "Write a file", "--provider", "deepseek-harness"], env);
    assert.equal(created.code, 0, created.err);

    await waitForStatus(base, 1, "ready");

    const store = createStore(base);
    const task = await store.findTask(1);
    const events = await store.readEvents(task.slug);
    const observed = events.filter(e => e.type === "file.changed" && e.source === "worktree");
    assert.ok(
      observed.some(e => e.path === "made-by-run.txt"),
      "the run's file change was observed and recorded: " + JSON.stringify(events)
    );
    // The provider reported nothing (headless DSH) — so every recorded change
    // is 0x2F's own observation, never a fabricated provider event.
    const providerReported = events.filter(e => e.type === "file.changed" && e.source !== "worktree");
    assert.equal(providerReported.length, 0);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a provider that DOES declare file-change reporting is observed too (authoritative on-disk state)", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-observed-claude-"));
  try {
    await git(["init"], base);
    await fs.writeFile(path.join(base, ".gitignore"), ".work/\nnode_modules/\n");

    // Fake claude-code: emits its own file.changed event (via a mutating
    // tool_use block, exactly how the adapter maps it) AND writes the file.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-observed-claude-bin-"));
    const bin = path.join(dir, "claude");
    const events = [
      { type: "system", subtype: "init", session_id: "sess" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "made-by-claude.txt" } }
          ]
        }
      },
      {
        type: "result",
        is_error: false,
        session_id: "sess",
        result: "## Result\nfixed\n## Needs human decision\nNone"
      }
    ];
    await fs.writeFile(
      bin,
      "#!/usr/bin/env node\n" +
        "require('fs').writeFileSync('made-by-claude.txt', 'x\\n');\n" +
        "const events = " + JSON.stringify(events) + ";\n" +
        "for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');\n" +
        "process.exit(0);\n"
    );
    await fs.chmod(bin, 0o755);

    const env = { CLAUDE_BIN: bin };
    const init = await runCli(base, ["init"], env);
    assert.equal(init.code, 0);
    const created = await runCli(base, ["new", "Write a file", "--provider", "claude-code"], env);
    assert.equal(created.code, 0, created.err);

    await waitForStatus(base, 1, "ready");

    const store = createStore(base);
    const task = await store.findTask(1);
    const logEvents = await store.readEvents(task.slug);
    const observed = logEvents.filter(e => e.type === "file.changed" && e.source === "worktree");
    // The worker observes EVERY run (when git gives a baseline), so the
    // on-disk final state is authoritative even for a provider that reports
    // its own file.changed events. Both representations coexist as telemetry;
    // the aggregate ledger dedupes them by canonical path.
    assert.ok(
      observed.some(e => e.path === "made-by-claude.txt"),
      "the provider's run is also observed: " + JSON.stringify(logEvents)
    );
    const reported = logEvents.filter(e => e.type === "file.changed" && e.source !== "worktree");
    assert.ok(reported.length >= 1, "the provider's own file.changed event is recorded");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
