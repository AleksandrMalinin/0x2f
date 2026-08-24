// Generic Command Provider — headless executables with no structured
// protocol. These tests pin: safe argv spawning (never a shell), the tiny
// {prompt}/{workspace} substitution, the honest outcome mapping (exit 0 ->
// ready, non-zero -> failed, decision convention -> needs_you), and the
// conservative capability declaration.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandProvider, normalizeCommandRun } from "../src/providers/command.mjs";
import { substituteCommand } from "../src/providers/manifests.mjs";

// Write a fake executable that logs its argv + cwd to a file, prints stdout,
// writes stderr, and exits with `code`.
async function fakeExecutable({ stdout = "", stderr = "", code = 0, logPath }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-cmd-"));
  const bin = path.join(dir, "fake-agent");
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
const logPath = ${JSON.stringify(logPath)};
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }) + "\\n");
if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});
if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`;
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

async function makeProvider(command, over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-cmd-"));
  const logPath = path.join(dir, "spawn.log");
  const provider = createCommandProvider({
    id: "fake-agent",
    displayName: "Fake Agent",
    transport: "command",
    command,
    ...over
  });
  return { provider, dir, logPath };
}

test("command provider: declares the conservative capabilities", () => {
  const provider = createCommandProvider({
    id: "x",
    displayName: "X",
    transport: "command",
    command: ["x", "{prompt}"]
  });
  assert.equal(provider.integrationType, "command");
  assert.deepEqual(provider.capabilities, {
    supportsResume: false,
    supportsStructuredEvents: false,
    supportsFileChanges: false,
    supportsCommands: false,
    supportsPermissionRequests: false,
    supportsSandbox: false,
    supportsStreaming: false,
    resultOnCompletion: true
  });
  assert.equal(provider.resume, undefined); // no resume seam
});

test("command provider: success maps to ready with the result and a run.started event", async () => {
  const { provider, dir, logPath } = await makeProvider(["/placeholder", "{prompt}"]);
  const exe = await fakeExecutable({
    stdout: "## Result\nfixed\n## Needs human decision\nNone",
    logPath
  });
  const providerWithExe = createCommandProvider({
    id: "fake-agent",
    displayName: "Fake Agent",
    transport: "command",
    command: [exe.bin, "run", "--task", "{prompt}", "--in", "{workspace}"]
  });
  try {
    const events = [];
    const outcome = await providerWithExe.start({
      cwd: dir,
      prompt: "Investigate the retry window",
      onEvent: e => events.push(e)
    });
    assert.equal(outcome.status, "ready");
    assert.match(outcome.result, /fixed/);
    assert.ok(events.some(e => e.type === "run.started"));

    // Safe argv spawning: distinct argv tokens, the prompt substituted in
    // place, the workspace substituted, cwd = the workspace — no shell string.
    // (argv.slice(1) drops the fake's own script path, which is argv[0].)
    const spawned = JSON.parse((await fs.readFile(logPath, "utf8")).trim().split("\n").at(-1));
    assert.deepEqual(spawned.argv.slice(1), ["run", "--task", "Investigate the retry window", "--in", dir]);
    // The spawned process resolves symlinks in its cwd (macOS /var -> /private/var).
    assert.equal(spawned.cwd, await fs.realpath(dir));
  } finally {
    await fs.rm(exe.dir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("command provider: a non-zero exit maps to failed with the stderr message", async () => {
  const { dir } = await makeProvider(["/placeholder"]);
  const exe = await fakeExecutable({ stderr: "dsh: E_AGENT: agent failed", code: 1 });
  const provider = createCommandProvider({
    id: "fake-agent",
    displayName: "Fake Agent",
    transport: "command",
    command: [exe.bin, "{prompt}"]
  });
  try {
    const outcome = await provider.start({ cwd: dir, prompt: "x" });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, /E_AGENT/);
  } finally {
    await fs.rm(exe.dir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("command provider: a missing executable fails cleanly", async () => {
  const { provider, dir } = await makeProvider(["/nonexistent/definitely-not-here", "{prompt}"]);
  try {
    const outcome = await provider.start({ cwd: dir, prompt: "x" });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, /Could not start fake-agent/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("command provider: the Work decision convention maps stdout to needs_you/decision", async () => {
  const { dir } = await makeProvider(["/placeholder"]);
  const exe = await fakeExecutable({
    stdout: "## Result\ninvestigated\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend?",
    code: 0
  });
  const provider = createCommandProvider({
    id: "fake-agent",
    displayName: "Fake Agent",
    transport: "command",
    command: [exe.bin, "{prompt}"]
  });
  try {
    const outcome = await provider.start({ cwd: dir, prompt: "x" });
    assert.equal(outcome.status, "needs_you");
    assert.equal(outcome.reason, "decision");
    assert.equal(outcome.blockedOn.type, "decision");
    assert.match(outcome.blockedOn.text, /Which backend/);
  } finally {
    await fs.rm(exe.dir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("normalizeCommandRun: exit 0 / non-zero / empty stderr", () => {
  assert.equal(normalizeCommandRun({ code: 0, stdout: "done" }).status, "ready");
  assert.equal(normalizeCommandRun({ code: 0, stdout: "done" }).result, "done");
  const failed = normalizeCommandRun({ code: 3 });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /exited with code 3/);
  const withStderr = normalizeCommandRun({ code: 1, stderr: "boom" });
  assert.match(withStderr.error, /boom/);
  const decision = normalizeCommandRun({
    code: 0,
    stdout: "## Result\nx\n## Needs human decision\nREQUIRED: yes\nQUESTION: pick"
  });
  assert.equal(decision.status, "needs_you");
});

test("substituteCommand replaces only the known placeholders", () => {
  assert.deepEqual(
    substituteCommand(["tool", "run", "--task", "{prompt}", "--in", "{workspace}"], {
      prompt: "hello world",
      workspace: "/w"
    }),
    ["tool", "run", "--task", "hello world", "--in", "/w"]
  );
  // A prompt containing braces/placeholders must survive untouched — only
  // the manifest's own tokens are substituted, and only where they appear.
  assert.deepEqual(
    substituteCommand(["echo", "{prompt}"], { prompt: "a {workspace} b", workspace: "/w" }),
    ["echo", "a /w b"]
  );
  // Repeated placeholders all substitute.
  assert.deepEqual(
    substituteCommand(["x", "{prompt}", "{prompt}"], { prompt: "p", workspace: "w" }),
    ["x", "p", "p"]
  );
});
