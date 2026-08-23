// Provider equivalence — the SAME task text run through both real providers
// (Claude Code and DeepSeek Harness) must normalize to the same Work outcome.
//
// Both providers are driven through fake CLIs (CLAUDE_BIN / DSH_BIN), so the
// test exercises the real provider contract — spawn, stream handling, outcome
// normalization — without either vendor CLI installed. This is the proof that
// the provider-neutral architecture hosts more than one harness: the second
// provider is a file plus a registry line, and Work Core never changes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeCodeProvider } from "../src/providers/claude-code.mjs";
import { deepseekHarnessProvider } from "../src/providers/deepseek-harness.mjs";
import { EVENT_TYPES } from "../src/core/events.mjs";

const TASK = "Investigate why production users are missing in Sentry";

async function fakeClaude({ result }) {
  // A minimal stream-json run: system/init carries a session id, the result
  // event carries the final text. Exactly the shape the provider parses.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-claude-"));
  const bin = path.join(dir, "claude");
  const events = [
    { type: "system", subtype: "init", session_id: "sess-equivalence" },
    { type: "result", is_error: false, session_id: "sess-equivalence", result }
  ];
  const body =
    "#!/usr/bin/env node\n" +
    "const events = " + JSON.stringify(events) + ";\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + \"\\n\");\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

async function fakeDsh({ stdout }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-dsh-"));
  const bin = path.join(dir, "dsh");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "process.stdout.write(" + JSON.stringify(stdout) + ");\n" +
      "process.exit(0);\n"
  );
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("the same task through both providers -> ready with the same result", async () => {
  const result =
    "## Result\nRoot cause confirmed: the Sentry DSN is read from a non-existent env var.\n" +
    "## Evidence\nconfig/sentry.ts\n" +
    "## Changes\nNone (investigation only)\n" +
    "## Verification\nnpm test\n" +
    "## Needs human decision\nNone";

  const claude = await fakeClaude({ result });
  const dsh = await fakeDsh({ stdout: result });
  try {
    const claudeEvents = [];
    const dshEvents = [];
    let claudeOutcome;
    let dshOutcome;

    await withEnv("CLAUDE_BIN", claude.bin, async () => {
      claudeOutcome = await claudeCodeProvider.start({
        cwd: claude.dir,
        prompt: TASK,
        onEvent: e => claudeEvents.push(e)
      });
    });
    await withEnv("DSH_BIN", dsh.bin, async () => {
      dshOutcome = await deepseekHarnessProvider.start({
        cwd: claude.dir,
        prompt: TASK,
        onEvent: e => dshEvents.push(e)
      });
    });

    // Both normalize the same engineering result to the same Work concept.
    assert.equal(claudeOutcome.status, "ready");
    assert.equal(dshOutcome.status, "ready");
    assert.equal(dshOutcome.result, claudeOutcome.result);

    // Every event either provider emitted is Work vocabulary, never vendor.
    for (const event of [...claudeEvents, ...dshEvents]) {
      assert.ok(EVENT_TYPES.includes(event.type), `event ${event.type} is Work vocabulary`);
    }
    // Both providers announce the run.
    assert.ok(claudeEvents.some(e => e.type === "run.started"));
    assert.ok(dshEvents.some(e => e.type === "run.started"));
  } finally {
    await fs.rm(claude.dir, { recursive: true, force: true });
    await fs.rm(dsh.dir, { recursive: true, force: true });
  }
});

test("a decision block normalizes identically through both providers", async () => {
  const result =
    "## Result\nInvestigated.\n" +
    "## Needs human decision\nWhich backend should we standardize on?";

  const claude = await fakeClaude({ result });
  const dsh = await fakeDsh({ stdout: result });
  try {
    let claudeOutcome;
    let dshOutcome;
    await withEnv("CLAUDE_BIN", claude.bin, async () => {
      claudeOutcome = await claudeCodeProvider.start({ cwd: claude.dir, prompt: TASK });
    });
    await withEnv("DSH_BIN", dsh.bin, async () => {
      dshOutcome = await deepseekHarnessProvider.start({ cwd: dsh.dir, prompt: TASK });
    });

    assert.equal(claudeOutcome.status, "needs_you");
    assert.equal(dshOutcome.status, "needs_you");
    assert.equal(dshOutcome.reason, claudeOutcome.reason);
    assert.equal(dshOutcome.reason, "decision");
    assert.equal(dshOutcome.blockedOn.type, claudeOutcome.blockedOn.type);
  } finally {
    await fs.rm(claude.dir, { recursive: true, force: true });
    await fs.rm(dsh.dir, { recursive: true, force: true });
  }
});
