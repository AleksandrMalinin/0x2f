// Claude permission continuation — the REAL worker + shared actions + CLI,
// driven by a fake `claude` that reports a genuine permission denial and then
// either resumes the session or fails the resume the way the vendor CLI does
// ("No conversation found" — print-mode session resume is unreliable in
// Claude Code; see anthropics/claude-code#1967).
//
// Two invariants:
//   1. A SUCCESSFUL resume continues the SAME session (--resume <id>
//      --permission-mode acceptEdits) and the run completes.
//   2. A FAILED resume is classified honestly (failure.kind "resume") with a
//      clear message — the permission was recorded but the work could not be
//      continued in place — and the run FAILS rather than pretending the
//      grant silently succeeded.

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

async function waitForStatus(base, id, expected, timeout = 15000) {
  const store = createStore(base);
  const start = Date.now();
  while (true) {
    const task = await store.findTask(id);
    if (task.status === expected) return task;
    if (task.status !== "working" && task.status !== "needs_you") {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 60));
  }
}

// A fake `claude`: start mode reports a permission denial (exit 0, like the
// real headless CLI); resume mode either continues the session or fails with
// the vendor's "No conversation found" error (exit 1) based on
// FAKE_CLAUDE_RESUME=ok|fail. Every invocation's argv is appended to
// $CLAUDE_LOG so tests can assert exactly what session id was resumed.
async function fakeClaudeBin(dir, { resume = "ok" } = {}) {
  const bin = path.join(dir, "claude");
  const body =
    "#!/usr/bin/env node\n" +
    "const fs = require('fs');\n" +
    "if (process.env.CLAUDE_LOG) fs.appendFileSync(process.env.CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
    "const args = process.argv.slice(2);\n" +
    "const ri = args.indexOf('--resume');\n" +
    "if (ri >= 0) {\n" +
    "  if (process.env.FAKE_CLAUDE_RESUME === 'fail') {\n" +
    "    process.stderr.write('No conversation found with session ID: ' + args[ri + 1] + '\\n');\n" +
    "    process.exit(1);\n" +
    "  }\n" +
    "  const sid = args[ri + 1];\n" +
    "  const evs = [\n" +
    "    { type: 'system', subtype: 'init', session_id: sid },\n" +
    "    { type: 'result', is_error: false, session_id: sid, result: '## Result\\ncontinued after allow\\n## Needs human decision\\nNone' }\n" +
    "  ];\n" +
    "  for (const e of evs) process.stdout.write(JSON.stringify(e) + '\\n');\n" +
    "  process.exit(0);\n" +
    "}\n" +
    "const events = [\n" +
    "  { type: 'system', subtype: 'init', session_id: 'sess-uuid-1' },\n" +
    "  { type: 'system', subtype: 'permission_denied', tool_name: 'Edit', message: 'permission required' },\n" +
    "  { type: 'result', is_error: false, session_id: 'sess-uuid-1', result: '', permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: '/w/x.ts' } }] }\n" +
    "];\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return bin;
}

async function makeRun(t, { resume = "ok" } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-claude-resume-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-claude-resume-bin-"));
  t.after(() => fs.rm(binDir, { recursive: true, force: true }));
  const bin = await fakeClaudeBin(binDir, { resume });
  const env = { CLAUDE_BIN: bin, FAKE_CLAUDE_RESUME: resume };
  const init = await runCli(base, ["init"], env);
  assert.equal(init.code, 0);
  const created = await runCli(base, ["new", "Write a file", "--provider", "claude-code"], env);
  assert.equal(created.code, 0, created.err);
  const blocked = await waitForStatus(base, 1, "needs_you");
  assert.equal(blocked.blockedOn.type, "permission");
  assert.equal(blocked.execution.externalSessionId, "sess-uuid-1");
  return { base, env };
}

test("permission -> allow -> successful resume: the SAME session continues and the run completes", async t => {
  const { base, env } = await makeRun(t, { resume: "ok" });
  const logPath = path.join(base, "claude-args.log");
  env.CLAUDE_LOG = logPath;

  const allowed = await runCli(base, ["allow", "1"], env);
  assert.equal(allowed.code, 0, allowed.err);
  const done = await waitForStatus(base, 1, "ready");
  assert.equal(done.status, "ready");

  // The resume invoked claude with --resume <the persisted session id> and
  // the narrow file-edit grant — NOT a fresh session.
  const args = JSON.parse((await fs.readFile(logPath, "utf8")).trim().split("\n").at(-1));
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "sess-uuid-1");
  assert.ok(args.includes("--permission-mode"));
});

test("permission -> allow -> failed resume: the run FAILS honestly (kind resume), never pretends the grant continued", async t => {
  const { base, env } = await makeRun(t, { resume: "fail" });
  env.FAKE_CLAUDE_RESUME = "fail";

  const allowed = await runCli(base, ["allow", "1"], env);
  assert.equal(allowed.code, 0, allowed.err);
  const failed = await waitForStatus(base, 1, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.kind, "resume");
  // The honest message explains the limitation and the recovery path.
  assert.match(failed.error, /could not resume the session/);
  assert.match(failed.error, /Rerun the task or close it/);
  // The run record is finalized as failed — the permission grant did not
  // silently succeed.
  const run = failed.runs.find(r => r.run === 1);
  assert.equal(run.outcome, "failed");
  assert.equal(run.externalSessionId, "sess-uuid-1");
});
