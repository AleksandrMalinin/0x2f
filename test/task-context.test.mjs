// Task state -> per-run context -> disposable provider session.
//
// The continuity contract: a task is persistent, provider sessions are
// disposable. Every NEW run receives the accumulated Task state — original
// request + user input (answers/constraints) + prior run results/verification
// + changed files — built into runs/<n>/prompt.md, never a raw transcript.
//
// These tests pin:
//   1. Run 1's result/verification/changed files appear in Run 2's prompt.
//   2. A user constraint added after Run 1 appears in Run 2's prompt (and
//      only there — Run 1's input is untouched).
//   3. A cross-provider rerun gets Task context but a FRESH provider session
//      (end to end through the real worker: each provider received exactly
//      its own persisted per-run prompt).
//   4. Same-provider resume still uses the existing session — no new run, no
//      new per-run prompt.
//   5. Previous run records/results/original prompt stay immutable.
//   6. The generated per-run prompt is persisted for auditability.
//   7. answerWork now lands the answer in Task context (next-run input) while
//      preserving the existing decision behavior.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.mjs";
import { createStore } from "../src/core/store.mjs";
import { applyOutcome } from "../src/core/lifecycle.mjs";
import { sectionOf } from "../src/project.mjs";
import { eventsForRun } from "../src/web/ledger.mjs";
import { withFakeBin } from "./helpers.mjs";

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return null;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return null;
    },
    async cancelExecution() {},
    calls
  };
}

async function makeRuntime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-ctx-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  return { ...runtime, node, base };
}

// Mirror what the worker does when a provider run ends (see runs.test.mjs).
async function applyWorkerOutcome(runtime, task, outcome) {
  let next = applyOutcome(task, outcome);
  if (outcome.externalSessionId) {
    next.execution = {
      ...(next.execution ?? {}),
      provider: task.execution?.provider,
      externalSessionId: outcome.externalSessionId
    };
  }
  const runNumber = next.runs?.at(-1)?.run ?? 1;
  const record = next.runs?.find(r => r.run === runNumber);
  if (record) {
    next = {
      ...next,
      runs: next.runs.map(r =>
        r.run === runNumber
          ? {
              ...r,
              outcome: next.status,
              completedAt: new Date().toISOString(),
              externalSessionId: next.execution?.externalSessionId,
              error: next.status === "failed" ? next.error : undefined,
              blockedOn: next.status === "needs_you" ? next.blockedOn : undefined
            }
          : r
      )
    };
  }
  await runtime.store.writeJson(
    path.join(runtime.store.taskDir(task.slug), "task.json"),
    next
  );
  return next;
}

// Write run 1's result files the way the worker would after a ready run.
async function writeRun1Result(runtime, task, text) {
  const dir = runtime.store.taskDir(task.slug);
  await fs.mkdir(path.join(dir, "runs", "1"), { recursive: true });
  await fs.writeFile(path.join(dir, "runs", "1", "result.md"), text);
  await fs.writeFile(path.join(dir, "result.md"), text);
}

const RUN1_RESULT =
  "## Result\nRoot cause: the capture path re-ingests its own output.\n" +
  "## Evidence\nsrc/capture.mjs:41\n" +
  "## Changes\nAdded a dedupe guard in src/capture.mjs\n" +
  "## Verification\nnpm test — 12 passing\n" +
  "## Needs human decision\nREQUIRED: no";

test("sectionOf extracts a result section up to the next heading", () => {
  assert.equal(sectionOf(RUN1_RESULT, "Result"), "Root cause: the capture path re-ingests its own output.");
  assert.equal(sectionOf(RUN1_RESULT, "Verification"), "npm test — 12 passing");
  assert.equal(sectionOf(RUN1_RESULT, "Changes"), "Added a dedupe guard in src/capture.mjs");
  assert.equal(sectionOf(RUN1_RESULT, "Evidence"), "src/capture.mjs:41");
  assert.equal(sectionOf(RUN1_RESULT, "NotThere"), "");
});

test("createWork persists run 1's input per run; the original prompt.md is untouched", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Dedupe capture" });
    const dir = runtime.store.taskDir(task.slug);
    const original = await fs.readFile(path.join(dir, "prompt.md"), "utf8");
    const run1Prompt = await fs.readFile(path.join(dir, "runs", "1", "prompt.md"), "utf8");
    assert.equal(run1Prompt, original);
    assert.match(run1Prompt, /Dedupe capture/);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("run 1's result, verification and changed files appear in run 2's prompt — but never a transcript", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Dedupe capture" });
    await applyWorkerOutcome(runtime, task, { status: "ready", result: RUN1_RESULT });
    await writeRun1Result(runtime, task, RUN1_RESULT);

    // Structured run evidence: a changed file AND raw progress chatter. The
    // context builder must include the former and exclude the latter.
    await runtime.store.appendEvent(task.slug, {
      type: "file.changed", taskId: task.id, run: 1, path: "src/capture.mjs", at: new Date().toISOString()
    });
    await runtime.store.appendEvent(task.slug, {
      type: "progress", taskId: task.id, run: 1, text: "transcript line that must not leak", at: new Date().toISOString()
    });

    const rerun = await withFakeBin("DSH_BIN", "dsh", () =>
      runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" })
    );

    const dir = runtime.store.taskDir(task.slug);
    const original = await fs.readFile(path.join(dir, "prompt.md"), "utf8");
    const run2Prompt = await fs.readFile(path.join(dir, "runs", "2", "prompt.md"), "utf8");

    // The original task request is preserved verbatim, then extended.
    assert.ok(run2Prompt.startsWith(original));
    assert.match(run2Prompt, /Dedupe capture/);
    assert.match(run2Prompt, /### Previous runs/);
    assert.match(run2Prompt, /#### Run 1 — claude-code · ready/);
    assert.match(run2Prompt, /Root cause: the capture path re-ingests its own output\./);
    assert.match(run2Prompt, /npm test — 12 passing/); // verification summary
    assert.match(run2Prompt, /- src\/capture\.mjs/); // changed files
    assert.doesNotMatch(run2Prompt, /transcript line that must not leak/); // no raw transcripts
    assert.equal(rerun.runs[1].provider, "deepseek-harness");
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("a user constraint added after run 1 appears in run 2's prompt, not run 1's", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Dedupe capture" });
    await applyWorkerOutcome(runtime, task, { status: "ready", result: RUN1_RESULT });
    await writeRun1Result(runtime, task, RUN1_RESULT);

    const noted = await runtime.actions.noteWork(task.id, {
      note: "Don't change the public capture API."
    });
    assert.equal(noted.status, "ready"); // note does not move the task
    assert.deepEqual(noted.context.notes.map(n => n.text), ["Don't change the public capture API."]);

    await withFakeBin("DSH_BIN", "dsh", () =>
      runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" })
    );

    const dir = runtime.store.taskDir(task.slug);
    const run1Prompt = await fs.readFile(path.join(dir, "runs", "1", "prompt.md"), "utf8");
    const run2Prompt = await fs.readFile(path.join(dir, "runs", "2", "prompt.md"), "utf8");
    assert.doesNotMatch(run1Prompt, /public capture API/);
    assert.match(run2Prompt, /### User input on this task/);
    assert.match(run2Prompt, /Don't change the public capture API\./);
    // The task's own record carries the note for inspection.
    const persisted = await runtime.store.findTask(task.id);
    assert.equal(persisted.context.notes.length, 1);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("noteWork records Task context without starting or resuming an execution", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Constraint" });
    await applyWorkerOutcome(runtime, task, { status: "ready", result: RUN1_RESULT });
    await writeRun1Result(runtime, task, RUN1_RESULT);
    const callsBefore = [...runtime.node.calls];

    await runtime.actions.noteWork(task.id, { note: "Keep the CLI plain." });
    assert.deepEqual(runtime.node.calls, callsBefore); // no new execution

    const events = await runtime.store.readEvents(task.slug);
    assert.ok(events.some(e => e.type === "task.note" && e.note === "Keep the CLI plain."));

    await assert.rejects(
      () => runtime.actions.noteWork(task.id, { note: "   " }),
      /A note is required\./
    );
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("answerWork keeps existing decision behavior AND lands the answer in Task context", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await withFakeBin("DSH_BIN", "dsh", () =>
      runtime.actions.createWork({ brief: "Decision", provider: "deepseek-harness" })
    );
    const blocked = applyOutcome(task, {
      status: "needs_you",
      reason: "decision",
      blockedOn: { type: "decision", text: "Keep the CLI plain?" }
    });
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      blocked
    );

    const answered = await runtime.actions.answerWork(task.id, { answer: "TTY-only glyphs" });
    assert.equal(answered.status, "needs_you"); // answering is still not a continuation
    assert.deepEqual(runtime.node.calls, [["start", task.slug]]); // provider never invoked

    // Backward-compatible records…
    const answer = await runtime.store.readJson(
      path.join(runtime.store.taskDir(task.slug), "answer.json")
    );
    assert.equal(answer.answer, "TTY-only glyphs");

    // …AND the answer is now Task context for the next run.
    const persisted = await runtime.store.findTask(task.id);
    assert.deepEqual(persisted.context.notes.map(n => n.text), ["TTY-only glyphs"]);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("same-provider resume keeps the existing session: no new run, no new per-run prompt", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Resume" });
    const blocked = applyOutcome(task, {
      status: "needs_you",
      reason: "permission",
      externalSessionId: "sess-abc",
      blockedOn: { type: "permission", tool: "Edit", file: "src/a.ts" }
    });
    blocked.execution = { ...(blocked.execution ?? {}), externalSessionId: "sess-abc" };
    // Mirror the worker: the session id also lands on the finalized run record.
    blocked.runs = blocked.runs.map(r =>
      r.run === 1 ? { ...r, externalSessionId: "sess-abc" } : r
    );
    await runtime.store.writeJson(
      path.join(runtime.store.taskDir(task.slug), "task.json"),
      blocked
    );

    const resumed = await runtime.actions.resumeWork(task.id, "allow");
    assert.equal(resumed.status, "working");
    assert.deepEqual(runtime.node.calls.at(-1), ["resume", task.slug, "allow"]);

    // Still ONE run — resume continues it; it is not a new run.
    const persisted = await runtime.store.findTask(task.id);
    assert.equal(persisted.runs.length, 1);
    assert.equal(persisted.runs[0].externalSessionId, "sess-abc");
    assert.equal(persisted.execution.externalSessionId, "sess-abc");
    assert.equal(
      await runtime.store.readRunPrompt(persisted, 2),
      null, // no run 2 was created
      "resume must not fabricate a per-run prompt for a new run"
    );
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

test("previous run records, results and the original prompt stay immutable across reruns", async () => {
  const runtime = await makeRuntime();
  try {
    const task = await runtime.actions.createWork({ brief: "Immutable" });
    const afterRun1 = await applyWorkerOutcome(runtime, task, {
      status: "ready",
      result: RUN1_RESULT,
      externalSessionId: "sess-1"
    });
    await writeRun1Result(runtime, task, RUN1_RESULT);
    const run1RecordSnapshot = JSON.stringify(afterRun1.runs[0]);
    const resultSnapshot = await fs.readFile(
      path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"),
      "utf8"
    );
    const originalSnapshot = await fs.readFile(
      path.join(runtime.store.taskDir(task.slug), "prompt.md"),
      "utf8"
    );

    await runtime.actions.noteWork(task.id, { note: "Constraint A" });
    await withFakeBin("DSH_BIN", "dsh", () =>
      runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" })
    );
    // The fake node never runs a worker, so mark each rerun ready before the
    // next (runs of one task are strictly sequential).
    const afterRerun1 = await runtime.store.findTask(task.id);
    await applyWorkerOutcome(runtime, afterRerun1, { status: "ready", result: "second" });
    await withFakeBin("DSH_BIN", "dsh", () =>
      runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" })
    );

    const persisted = await runtime.store.findTask(task.id);
    assert.equal(persisted.runs.length, 3);
    assert.equal(JSON.stringify(persisted.runs[0]), run1RecordSnapshot);
    assert.equal(
      await fs.readFile(path.join(runtime.store.taskDir(task.slug), "runs", "1", "result.md"), "utf8"),
      resultSnapshot
    );
    assert.equal(
      await fs.readFile(path.join(runtime.store.taskDir(task.slug), "prompt.md"), "utf8"),
      originalSnapshot
    );
    // Every run has its own auditable input; run 3 sees run 1's outcome too.
    const run3Prompt = await fs.readFile(
      path.join(runtime.store.taskDir(task.slug), "runs", "3", "prompt.md"),
      "utf8"
    );
    assert.match(run3Prompt, /Root cause: the capture path re-ingests its own output\./);
  } finally {
    await fs.rm(runtime.base, { recursive: true, force: true });
  }
});

// --- end to end through the real worker -------------------------------------

async function waitForStatus(runtime, id, expected, opts = {}) {
  const { timeout = 10000, tolerate = [] } = opts;
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    const task = await runtime.store.findTask(id);
    if (task.status === expected) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 50));
  }
}

// Fake Claude Code that writes the exact prompt it received to a capture file
// (the prompt is the last argv entry in `claude -p --verbose
// --output-format stream-json "<prompt>"`), then emits a ready run.
async function capturingClaudeBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-ctx-claude-"));
  const bin = path.join(dir, "claude");
  const events = [
    { type: "system", subtype: "init", session_id: "sess-ctx-claude" },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/capture.mjs" } }] }
    },
    {
      type: "result",
      is_error: false,
      session_id: "sess-ctx-claude",
      result:
        "## Result\nfixed by claude\n## Changes\nEdited src/capture.mjs\n## Verification\ntests pass\n## Needs human decision\nNone"
    }
  ];
  const body =
    "#!/usr/bin/env node\n" +
    "require('node:fs').writeFileSync(process.env.CAPTURE_CLAUDE, process.argv[process.argv.length - 1]);\n" +
    "const events = " + JSON.stringify(events) + ";\n" +
    "for (const e of events) process.stdout.write(JSON.stringify(e) + \"\\n\");\n" +
    "process.exit(0);\n";
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return bin;
}

// Fake DeepSeek Harness that writes the exact prompt it received (the last
// argv entry in `dsh --profile headless "<prompt>"`) and returns ready.
async function capturingDshBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-ctx-dsh-"));
  const bin = path.join(dir, "dsh");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "require('node:fs').writeFileSync(process.env.CAPTURE_DSH, process.argv[process.argv.length - 1]);\n" +
      "process.stdout.write(" + JSON.stringify("## Result\nfixed by dsh\n## Needs human decision\nNone") + ");\n" +
      "process.exit(0);\n"
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("DOGFOODING: Claude investigates, user constrains, Codex-class rerun continues the SAME task in a fresh session", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-ctx-e2e-"));
  try {
    const claudeBin = await capturingClaudeBin();
    const dshBin = await capturingDshBin();
    const captureClaude = path.join(base, "capture-claude.txt");
    const captureDsh = path.join(base, "capture-dsh.txt");
    const constraint = "Don't change the public capture API.";

    await withEnv("CAPTURE_CLAUDE", captureClaude, async () => {
      await withEnv("CAPTURE_DSH", captureDsh, async () => {
        await withEnv("CLAUDE_BIN", claudeBin, async () => {
          await withEnv("DSH_BIN", dshBin, async () => {
            const runtime = createRuntime(base);

            // Run 01 — Claude investigates and edits.
            const task = await runtime.actions.createWork({
              brief: "Dedupe capture ingest path"
            });
            await waitForStatus(runtime, task.id, "ready");

            const afterRun1 = await runtime.store.findTask(task.id);
            assert.equal(afterRun1.runs[0].provider, "claude-code");
            assert.equal(afterRun1.runs[0].outcome, "ready");
            assert.equal(afterRun1.runs[0].externalSessionId, "sess-ctx-claude");

            // Claude received exactly run 1's persisted input — the original
            // prompt, with no accumulated state.
            const claudeReceived = await fs.readFile(captureClaude, "utf8");
            assert.equal(
              claudeReceived,
              await fs.readFile(
                path.join(runtime.store.taskDir(task.slug), "runs", "1", "prompt.md"),
                "utf8"
              )
            );
            assert.doesNotMatch(claudeReceived, /public capture API/);

            // The user adds a constraint — Task context, no execution.
            await runtime.actions.noteWork(task.id, { note: constraint });

            // Run 02 — another provider (dsh stands in for any disposable
            // harness session) continues the same task.
            await runtime.actions.rerunWork(task.id, { provider: "deepseek-harness" });
            await waitForStatus(runtime, task.id, "ready");

            const persisted = await runtime.store.findTask(task.id);
            assert.equal(persisted.runs.length, 2);
            assert.equal(persisted.runs[1].provider, "deepseek-harness");
            assert.equal(persisted.runs[1].outcome, "ready");
            // FRESH session: DSH never resumes; run 2 has no session id and
            // the worker started (not resumed) it.
            assert.equal(persisted.runs[1].externalSessionId, undefined);
            assert.equal(persisted.runs[0].externalSessionId, "sess-ctx-claude");
            assert.equal(persisted.execution.provider, "deepseek-harness");

            const events = await runtime.store.readEvents(persisted.slug);
            assert.deepEqual(
              eventsForRun(events, 2).map(e => e.type),
              ["run.started", "run.completed"]
            );

            // The second provider received the rebuilt Task context: original
            // request + the user's constraint + run 1's outcome/verification
            // + run 1's changed files — exactly what was persisted per run.
            const dshReceived = await fs.readFile(captureDsh, "utf8");
            assert.equal(
              dshReceived,
              await fs.readFile(
                path.join(runtime.store.taskDir(task.slug), "runs", "2", "prompt.md"),
                "utf8"
              )
            );
            assert.match(dshReceived, /Dedupe capture ingest path/); // original task
            assert.match(dshReceived, /Don't change the public capture API\./); // constraint
            assert.match(dshReceived, /fixed by claude/); // run 1 outcome
            assert.match(dshReceived, /tests pass/); // run 1 verification
            assert.match(dshReceived, /- src\/capture\.mjs/); // run 1 changed files

            // Run 1's input is untouched — auditability preserved.
            const run1Prompt = await fs.readFile(
              path.join(runtime.store.taskDir(task.slug), "runs", "1", "prompt.md"),
              "utf8"
            );
            assert.doesNotMatch(run1Prompt, /public capture API/);
          });
        });
      });
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
