// Task prompt refinement — the pure text transform behind the composer's
// REFINE action.
//
// These tests pin the refinement boundary with tiny fake `claude` / `dsh`
// executables (exactly like the provider tests do), and prove refinement is
// independent of the Task lifecycle: no task is created, no execution is
// started, and nothing is persisted by REFINE. The persisted artifact stays
// the final prompt the user submits with START (POST /api/tasks).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import {
  createRefiner,
  buildRefineInstruction,
  cleanRefinedText,
  MAX_RAW_LENGTH
} from "../src/refine.mjs";
import { createProviderRegistry } from "../src/providers/index.mjs";
import { WorkError } from "../src/core/errors.mjs";
import { withEnv } from "./helpers.mjs";

// Write a fake model CLI that records its argv + cwd to `recordFile`, writes
// `stderr`/`stdout`, and exits with `code` after `delayMs`. Returns the bin
// path (and its dir for cleanup).
async function fakeModelBin({ stdout = "refined text", stderr = "", code = 0, recordFile, delayMs = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-fake-model-"));
  const bin = path.join(dir, "bin");
  const record = recordFile
    ? `require("node:fs").writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv, cwd: process.cwd() }));`
    : "";
  const body = `#!/usr/bin/env node
${record}
setTimeout(() => {
  if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${code});
}, ${delayMs});
`;
  await fs.writeFile(bin, body);
  await fs.chmod(bin, 0o755);
  return { bin, dir };
}

async function readRecord(recordFile) {
  return JSON.parse(await fs.readFile(recordFile, "utf8"));
}

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) {
      calls.push(["start", task.slug]);
      return 111;
    },
    async resumeExecution({ task, grant }) {
      calls.push(["resume", task.slug, grant]);
      return 222;
    },
    async cancelExecution() {},
    calls
  };
}

async function startTestServer() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-api-"));
  const node = fakeNode();
  const runtime = createRuntime(base, { node });
  const handle = await startServer(base, 0, { runtime, interval: 20 });
  return { base, node, runtime, handle };
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
}

// --- the instruction ---------------------------------------------------------

test("buildRefineInstruction embeds the note and the refinement rules", () => {
  const instruction = buildRefineInstruction("  check mobile remote architecture  ");
  assert.match(instruction, /check mobile remote architecture/);
  // Every required refinement behavior is in the instruction.
  assert.match(instruction, /Preserve the user's intent and every explicit constraint exactly/);
  assert.match(instruction, /never invent\s+requirements, scope, deliverables, or constraints/);
  assert.match(instruction, /only where it helps/);
  assert.match(instruction, /Keep it concise/);
  assert.match(instruction, /coding\/research agent/);
  assert.match(instruction, /only the refined task text/);
  assert.match(instruction, /Do not ask the user clarifying questions/);
});

test("cleanRefinedText trims and unwraps a single code fence", () => {
  assert.equal(cleanRefinedText("  \nplain brief\n  "), "plain brief");
  assert.equal(
    cleanRefinedText("```text\nInvestigate the architecture.\n```"),
    "Investigate the architecture."
  );
  assert.equal(cleanRefinedText("```\nline one\nline two\n```"), "line one\nline two");
  assert.equal(cleanRefinedText("no fence here"), "no fence here");
  assert.equal(cleanRefinedText(""), "");
});

// --- the service ------------------------------------------------------------

test("raw text is sent to the refinement service: claude print mode with tools denied", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const recordFile = path.join(base, "record.json");
  const { bin, dir } = await fakeModelBin({ stdout: "Investigate the architecture.", recordFile });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    const refined = await withEnv("CLAUDE_BIN", bin, () =>
      refiner.refineTaskPrompt("check mobile remote architecture")
    );
    assert.equal(refined, "Investigate the architecture.");

    const recorded = await readRecord(recordFile);
    // argv = [node, bin, ...args] for a shebang script — the CLI args start
    // at index 2. The narrowest existing path: print mode, plain text output,
    // every tool denied, and the instruction (with the raw note inside) as
    // the prompt.
    const args = recorded.argv.slice(2);
    assert.equal(args[0], "-p");
    assert.equal(args[1], "--output-format");
    assert.equal(args[2], "text");
    assert.match(args[3], /^--disallowedTools=Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch$/);
    assert.match(args[4], /check mobile remote architecture/);
    assert.match(args[4], /never invent\s+requirements/);
    // The model runs in an empty temp cwd — never in the workspace.
    assert.match(recorded.cwd, /0x2f-refine-/);
    assert.ok(!recorded.cwd.includes(base), "cwd must not be the workspace");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("falls back to dsh headless when claude is unavailable", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const recordFile = path.join(base, "record.json");
  const { bin: dshFake, dir } = await fakeModelBin({ stdout: "dsh brief", recordFile });
  const missing = path.join(dir, "missing-claude");
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    const refined = await withEnv("CLAUDE_BIN", missing, () =>
      withEnv("DSH_BIN", dshFake, () => refiner.refineTaskPrompt("rough note"))
    );
    assert.equal(refined, "dsh brief");
    const recorded = await readRecord(recordFile);
    const args = recorded.argv.slice(2);
    // The same one-shot invocation the execution provider uses.
    assert.equal(args[0], "--profile");
    assert.equal(args[1], "headless");
    assert.match(args[2], /rough note/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("prefers claude-code's text mode when both providers are available", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const claudeRecord = path.join(base, "claude-record.json");
  const dshRecord = path.join(base, "dsh-record.json");
  const { bin: claudeFake, dir: claudeDir } = await fakeModelBin({ stdout: "from claude", recordFile: claudeRecord });
  const { bin: dshFake, dir: dshDir } = await fakeModelBin({ stdout: "from dsh", recordFile: dshRecord });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    const refined = await withEnv("CLAUDE_BIN", claudeFake, () =>
      withEnv("DSH_BIN", dshFake, () => refiner.refineTaskPrompt("note"))
    );
    assert.equal(refined, "from claude");
    await assert.rejects(() => fs.access(dshRecord)); // dsh was never called
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(claudeDir, { recursive: true, force: true });
    await fs.rm(dshDir, { recursive: true, force: true });
  }
});

test("fails gracefully with a clear error when no refinement model is available", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    await withEnv("CLAUDE_BIN", "/nonexistent/claude", () =>
      withEnv("DSH_BIN", "/nonexistent/dsh", async () => {
        await assert.rejects(
          () => refiner.refineTaskPrompt("rough"),
          error => {
            assert.ok(error instanceof WorkError);
            assert.match(error.message, /No model is available to refine/);
            assert.equal(error.status, 503);
            return true;
          }
        );
      })
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("empty, whitespace-only, and over-long notes are refused before any model call", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const recordFile = path.join(base, "record.json");
  const { bin, dir } = await fakeModelBin({ recordFile });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    await withEnv("CLAUDE_BIN", bin, async () => {
      await assert.rejects(() => refiner.refineTaskPrompt("   "), /nothing to refine/);
      await assert.rejects(() => refiner.refineTaskPrompt(undefined), /nothing to refine/);
      await assert.rejects(
        () => refiner.refineTaskPrompt("x".repeat(MAX_RAW_LENGTH + 1)),
        /too long to refine/
      );
    });
    // The model CLI was never spawned.
    await assert.rejects(() => fs.access(recordFile));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failing model run rejects and leaves the caller's text untouched", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const { bin, dir } = await fakeModelBin({ stdout: "", stderr: "dsh: E_AGENT: agent failed", code: 1 });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    const original = "keep my rough idea";
    await withEnv("CLAUDE_BIN", bin, () =>
      withEnv("DSH_BIN", "/nonexistent/dsh", async () => {
        await assert.rejects(() => refiner.refineTaskPrompt(original), /E_AGENT/);
      })
    );
    // The service never mutates its input — the composer's text survives.
    assert.equal(original, "keep my rough idea");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an empty model response is a failure, never a blank brief", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const { bin, dir } = await fakeModelBin({ stdout: "", code: 0 });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    await withEnv("CLAUDE_BIN", bin, () =>
      withEnv("DSH_BIN", "/nonexistent/dsh", () =>
        assert.rejects(() => refiner.refineTaskPrompt("rough"), /empty refinement/)
      )
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a hanging refinement times out instead of leaving the composer stuck", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const { bin, dir } = await fakeModelBin({ stdout: "late", delayMs: 5000 });
  try {
    const refiner = createRefiner({
      providers: createProviderRegistry({ base }),
      timeoutMs: 200
    });
    await withEnv("CLAUDE_BIN", bin, () =>
      withEnv("DSH_BIN", "/nonexistent/dsh", () =>
        assert.rejects(() => refiner.refineTaskPrompt("rough"), /timed out/)
      )
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("falls back to the next model path when the preferred one fails", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const claudeRecord = path.join(base, "claude-record.json");
  const dshRecord = path.join(base, "dsh-record.json");
  const { bin: claudeFake, dir: claudeDir } = await fakeModelBin({
    stdout: "",
    stderr: "claude: E_AUTH: not authenticated",
    code: 1,
    recordFile: claudeRecord
  });
  const { bin: dshFake, dir: dshDir } = await fakeModelBin({ stdout: "dsh brief", recordFile: dshRecord });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    const refined = await withEnv("CLAUDE_BIN", claudeFake, () =>
      withEnv("DSH_BIN", dshFake, () => refiner.refineTaskPrompt("rough"))
    );
    assert.equal(refined, "dsh brief");
    // Both were actually tried, in preference order: claude first, then dsh.
    const claude = await readRecord(claudeRecord);
    assert.equal(claude.argv.slice(2)[0], "-p");
    const dsh = await readRecord(dshRecord);
    assert.equal(dsh.argv.slice(2)[0], "--profile");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(claudeDir, { recursive: true, force: true });
    await fs.rm(dshDir, { recursive: true, force: true });
  }
});

test("when every available path fails, the preferred path's error is reported", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-refine-svc-"));
  const { bin: claudeFake, dir: claudeDir } = await fakeModelBin({
    stdout: "",
    stderr: "claude: E_AUTH: not authenticated",
    code: 1
  });
  const { bin: dshFake, dir: dshDir } = await fakeModelBin({
    stdout: "",
    stderr: "dsh: E_AGENT: agent failed",
    code: 1
  });
  try {
    const refiner = createRefiner({ providers: createProviderRegistry({ base }) });
    await withEnv("CLAUDE_BIN", claudeFake, () =>
      withEnv("DSH_BIN", dshFake, () =>
        assert.rejects(() => refiner.refineTaskPrompt("rough"), /E_AUTH/)
      )
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(claudeDir, { recursive: true, force: true });
    await fs.rm(dshDir, { recursive: true, force: true });
  }
});

// --- the API ----------------------------------------------------------------

test("POST /api/refine returns the refined text; repeated REFINE creates no tasks and starts no execution", async () => {
  const { base, node, handle } = await startTestServer();
  const recordFile = path.join(base, "record.json");
  const { bin, dir } = await fakeModelBin({ stdout: "Refined brief", recordFile });
  try {
    const res = await withEnv("CLAUDE_BIN", bin, () =>
      postJson(handle.url + "/api/refine", { text: "rough idea" })
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).refined, "Refined brief");

    // Repeated REFINE: still no task, still no execution — refinement never
    // creates a Task or triggers the lifecycle.
    for (let i = 0; i < 2; i++) {
      await withEnv("CLAUDE_BIN", bin, () =>
        postJson(handle.url + "/api/refine", { text: "rough again" })
      );
    }
    assert.deepEqual(await (await fetch(handle.url + "/api/tasks")).json(), []);
    assert.deepEqual(node.calls, []);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("START after refinement creates the Task using the refined text", async () => {
  const { base, runtime, handle } = await startTestServer();
  const { bin, dir } = await fakeModelBin({
    stdout: "Investigate the minimum remote architecture.\n\nGoals\n- work from any network\n- keep it small"
  });
  try {
    // REFINE: the composer's rough note becomes a structured brief.
    const refinedRes = await withEnv("CLAUDE_BIN", bin, () =>
      postJson(handle.url + "/api/refine", { text: "check mobile remote architecture" })
    );
    assert.equal(refinedRes.status, 200);
    const refined = (await refinedRes.json()).refined;

    // The refined text stays in the composer (fully editable) and START
    // submits whatever the composer currently holds — here the refined brief.
    const created = await postJson(handle.url + "/api/tasks", { title: refined });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal(task.title, refined);
    const prompt = await runtime.store.readText(
      path.join(runtime.store.taskDir(task.slug), "prompt.md"),
      ""
    );
    assert.match(prompt, /Investigate the minimum remote architecture/);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("START without refinement behaves exactly as today", async () => {
  const { base, node, handle } = await startTestServer();
  try {
    const res = await postJson(handle.url + "/api/tasks", { title: "plain task" });
    assert.equal(res.status, 201);
    const task = await res.json();
    assert.equal(task.title, "plain task");
    assert.equal(task.execution.provider, "claude-code");
    assert.equal(task.execution.node, "fake-node");
    assert.deepEqual(node.calls, [["start", task.slug]]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a failed refinement does not destroy the original text: START still uses it", async () => {
  const { base, handle } = await startTestServer();
  const { bin, dir } = await fakeModelBin({ stdout: "", stderr: "claude: E_AUTH: not authenticated", code: 1 });
  try {
    const original = "my rough idea stays";
    const res = await withEnv("CLAUDE_BIN", bin, () =>
      withEnv("DSH_BIN", "/nonexistent/dsh", () =>
        postJson(handle.url + "/api/refine", { text: original })
      )
    );
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /E_AUTH/);

    // The composer was never overwritten — START with the original text works.
    const created = await postJson(handle.url + "/api/tasks", { title: original });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).title, original);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/refine refuses empty or missing input with 400 and never spawns the model", async () => {
  const { base, handle } = await startTestServer();
  const recordFile = path.join(base, "record.json");
  const { bin, dir } = await fakeModelBin({ recordFile });
  try {
    await withEnv("CLAUDE_BIN", bin, async () => {
      const blank = await postJson(handle.url + "/api/refine", { text: "   " });
      assert.equal(blank.status, 400);
      assert.match((await blank.json()).error, /nothing to refine/);

      const missing = await postJson(handle.url + "/api/refine", {});
      assert.equal(missing.status, 400);
      assert.match((await missing.json()).error, /nothing to refine/);
    });
    // The model CLI was never called.
    await assert.rejects(() => fs.access(recordFile));
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
