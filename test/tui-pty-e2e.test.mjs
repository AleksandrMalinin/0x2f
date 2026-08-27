// The TUI golden-path dogfood suite — the finalized 0x2F terminal client,
// exercised through a REAL pseudo-terminal, end to end, without a human.
//
// Every test here launches the REAL `2f tui` entry point (src/cli.mjs tui)
// on a real PTY (test/tui-pty/pty-relay.py) and drives it with the same
// bytes a user's keyboard sends — never by calling the controller or the
// view functions directly. Runs execute through the REAL detached worker
// against deterministic fake ACP providers (test/tui-pty/agents/fake-agent.mjs)
// that perform real work (they edit a real file) and pause for real
// permission/decision stops, so no network and no model credentials are
// involved and the whole journey is reproducible on any machine.
//
// Each checkpoint asserts BOTH surfaces:
//   - what the user sees (the reconstructed terminal screen), and
//   - canonical Work state on disk (task.json, events, per-run prompts),
// so a visually plausible screen can never hide a broken task state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  startTui,
  makeWorkspace,
  waitForTask,
  waitForTaskState,
  storeOf,
  git,
  sleep
} from "./tui-pty/driver.mjs";
import { applyOutcome, closeTask } from "../src/core/lifecycle.mjs";

const ESC = "\u001b";
// What a clean terminal restoration looks like on the wire: leave the
// alternate screen, show the cursor, reset the styles.
const RESTORATION = [ESC + "[?1049l", ESC + "[?25h", ESC + "[0m"];

// Kill any detached workers this workspace started (their pids are recorded
// on the tasks), so a failed assertion never leaks a provider process.
async function killWorkers(base) {
  const dir = path.join(base, ".work", "tasks");
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const task = JSON.parse(
        await fs.readFile(path.join(dir, entry, "task.json"), "utf8")
      );
      if (task.pid) {
        try {
          process.kill(task.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* mid-write or unreadable */
    }
  }
}

async function teardown(session, base) {
  try {
    session.kill();
  } catch {
    /* already gone */
  }
  try {
    await session.waitForExit({ timeout: 3000 });
  } catch {
    /* already exited */
  }
  await killWorkers(base);
  await fs.rm(base, { recursive: true, force: true });
}

// --- the golden path -----------------------------------------------------------

test("GOLDEN PATH: launch -> create (multi-line brief) -> WORKING -> permission -> ALLOW -> READY -> diff -> SEND BACK -> decision -> ANSWER & CONTINUE -> READY -> ACCEPT -> DONE -> overview -> quit", async () => {
  const { base, markers } = await makeWorkspace();
  const session = await startTui({ workspace: base, cols: 120, rows: 36 });
  try {
    // 1. launch — the chrome names the product and the checkout it serves.
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
    await session.waitForText(/work-tui-pty-/, { label: "the active workspace label" });
    await session.waitForText(/no task selected/, { label: "an empty workspace" });
    assert.equal((await storeOf(base).listTasks()).length, 0, "no tasks yet on disk");

    // 2. composer — a realistic multi-line brief, typed with ⌃n newlines.
    session.press("n");
    await session.waitForText(/NEW TASK/, { label: "the composer" });
    await session.waitForText(/ALPHA/, { label: "the default provider chip" });
    const brief = [
      "Inspect the submit path and add retry handling",
      "Use whole seconds for Retry-After.",
      "Cover the offline queue."
    ];
    session.type(brief[0]);
    session.press("ctrl-n");
    session.type(brief[1]);
    session.press("ctrl-n");
    session.type(brief[2]);
    await session.waitForText(/Use whole seconds for Retry-After\./, {
      label: "the typed brief on screen"
    });
    session.press("enter");

    // The flash names the task and the run; the disk has the task with the
    // brief VERBATIM — newlines and all (composer newline behavior).
    await session.waitForText(/#001 opened · run 1 on ALPHA/, { label: "the create flash" });
    let task = await waitForTaskState(base, 1, t => t.id === 1 && t.brief.includes("Retry-After"));
    assert.equal(
      task.brief,
      brief.join("\n"),
      "the multi-line brief is stored verbatim, newlines included"
    );
    assert.equal(task.runs.length, 1);
    assert.equal(task.runs[0].provider, "alpha");
    assert.ok(
      await fs.readFile(path.join(base, ".work", "tasks", task.slug, "runs", "1", "prompt.md"), "utf8").then(p => p.includes(brief[1])),
      "run 1's prompt carries the brief"
    );

    // 3. WORKING — the ledger groups it, the detail says executing, and the
    // trace shows the run's real reported steps (the fake agent edited a file).
    await session.waitForText(/WORKING/, { label: "the WORKING group" });
    await session.waitForText(/executing/, { label: "the detail state word" });
    await session.waitForText(/src\/app\.ts/, { label: "the reported file change in the trace" });
    // The run REALLY modified the workspace file (the diff later is real).
    assert.match(
      await fs.readFile(path.join(base, "src", "app.ts"), "utf8"),
      /retry with backoff/,
      "the agent actually edited the working tree"
    );

    // 4. NEEDS YOU — a live interactive permission, visible in full.
    await session.waitForText(/NEEDS YOU · PERMISSION/, { timeout: 15000, label: "the permission halt" });
    await session.waitForText(/ALLOW/, { label: "the pinned action" });
    await session.waitForText(/REJECT/, { label: "the alternative" });
    task = await waitForTask(base, 1, "needs_you");
    assert.equal(task.blockedOn.type, "permission");
    assert.equal(task.blockedOn.live, true, "an interactive request holds the run");
    assert.equal(task.blockedOn.canAllow, true);
    assert.ok(task.blockedOn.file.endsWith(path.join("src", "app.ts")));
    assert.equal(task.runs.length, 1, "the run that paused is still run 1");

    // 5. inspect the task — scroll the detail pane and come back; the frame
    // survives and the halt is still there.
    session.press("J");
    session.press("K");
    await sleep(150);
    assert.match(session.text(), /NEEDS YOU · PERMISSION/);

    // 6. ALLOW — ↵ goes through the shared action; the SAME run continues.
    session.press("enter");
    await session.waitForText(/allowed · #001 continues in the same run/, {
      label: "the allow flash"
    });
    task = await waitForTask(base, 1, "ready", { tolerate: ["needs_you"] });
    assert.equal(task.runs.length, 1, "ALLOW resumed the same run — no new run was spent");
    assert.equal(task.runs[0].outcome, "ready");
    assert.match(task.runs[0].externalSessionId, /^sess-journey-/);
    assert.match(await storeOf(base).readTaskResult(task), /Added retry-with-backoff/);
    await session.waitForText(/READY/, { label: "the READY group" });
    await session.waitForText(/complete · awaiting you/, { label: "the ready detail" });
    await session.waitForText(/ACCEPT/, { label: "the pinned ACCEPT" });
    await session.waitForText(/SEND BACK/, { label: "the alternative" });

    // 7. CHANGES — the REAL diff of the working tree vs HEAD.
    session.press("d");
    await session.waitForText(/CHANGES/, { label: "the changes view" });
    await session.waitForText(/IN THE WORKING TREE · NOTHING COMMITTED/, {
      label: "the changes header"
    });
    await session.waitForText(/the real diff of the working tree vs HEAD/, {
      label: "loaded hunks"
    });
    await session.waitForText(/retry with backoff/, { label: "the added hunk line" });
    const diff = await git(["diff", "HEAD", "--", "src/app.ts"], base);
    assert.match(diff.stdout, /\+.*retry with backoff/, "the working tree really differs from HEAD");
    const events = await storeOf(base).readEvents(task.slug);
    assert.ok(
      events.some(e => e.type === "file.changed" && e.path?.endsWith(path.join("src", "app.ts"))),
      "a file.changed event was recorded"
    );
    session.press("escape");
    await session.waitForText(/complete · awaiting you/, { label: "back to the work frame" });

    // 8. SEND BACK — x opens the correction input; the correction is kept on
    // the TASK and the next run is rebuilt from it.
    session.press("x");
    await session.waitForText(/SEND BACK/, { label: "the send-back input" });
    session.type(markers.correction);
    session.press("enter");
    await session.waitForText(/sent back · run 2 of #001/, { label: "the send-back flash" });
    task = await waitForTaskState(base, 1, t => t.runs?.length === 2);
    assert.equal(task.runs[1].provider, "alpha");
    assert.ok(
      task.context.notes.some(n => n.text === markers.correction),
      "the correction is recorded on the task"
    );
    const correctedEvents = await storeOf(base).readEvents(task.slug);
    assert.ok(
      correctedEvents.some(e => e.type === "task.corrected" && e.correction === markers.correction),
      "a task.corrected event was recorded"
    );
    const run2Prompt = await storeOf(base).readRunPrompt(task, 2);
    assert.ok(run2Prompt.includes(markers.correction), "run 02's prompt carries the correction");
    assert.ok(run2Prompt.includes("User input on this task"), "run 02's prompt carries task state");

    // 9. DECISION — the full question is readable on screen, verbatim.
    // (The pane wraps the prose across rows, so these match the flattened
    // screen — the visual wrap is not content.)
    await session.waitForText(/NEEDS YOU · DECISION/, { timeout: 15000, label: "the decision halt" });
    await session.waitForFlatText(/Should the offline queue fall back to the same 503 policy as the live path\?/, {
      label: "the question heading"
    });
    await session.waitForFlatText(/fixed 30s delay/, { label: "the question's tradeoff prose" });
    await session.waitForFlatText(/Aligning it to 503 plus Retry-After/, { label: "the closing prose" });
    task = await waitForTask(base, 1, "needs_you");
    assert.equal(task.blockedOn.type, "decision");
    assert.ok(task.blockedOn.text.includes("Aligning it to 503 plus Retry-After"));

    // 10. ANSWER & CONTINUE — ↵ asks for the answer, then starts the next run.
    session.press("enter");
    await session.waitForText(/ANSWER & CONTINUE/, { label: "the answer input" });
    session.type(markers.answer);
    session.press("enter");
    await session.waitForText(/answer recorded · run 3 of #001/, { label: "the answer flash" });
    task = await waitForTask(base, 1, "ready", { tolerate: ["needs_you"] });
    assert.equal(task.runs.length, 3, "a decision continues as a NEW run");
    assert.equal(task.runs[2].provider, "alpha");
    const answer = JSON.parse(
      await fs.readFile(path.join(base, ".work", "tasks", task.slug, "answer.json"), "utf8")
    );
    assert.equal(answer.answer, markers.answer);
    assert.ok(
      task.context.notes.some(n => n.text === markers.answer),
      "the answer is part of the task context"
    );
    const run3Prompt = await storeOf(base).readRunPrompt(task, 3);
    assert.ok(run3Prompt.includes(markers.answer), "run 03's prompt carries the answer");

    // 11. READY again, 12. ACCEPT — the task closes through the shared action.
    await session.waitForText(/complete · awaiting you/, { label: "run 3 ready" });
    session.press("enter");
    await session.waitForText(/accepted #001/, { label: "the accept flash" });
    task = await waitForTask(base, 1, "done", { tolerate: ["ready"] });
    assert.equal(task.status, "done");
    await session.waitForText(/CLOSED/, { label: "the closed group" });
    await session.waitForText(/▶ 0  · 1/, { label: "the done count" });

    // 13. back to the overview — navigation and filters still work.
    session.press("g");
    session.press("G");
    session.press("tab");
    await session.waitForText(/tab needs you/, { label: "the filter hint cycles" });
    session.press("tab");
    session.press("tab");
    session.press("tab");
    session.press("escape");
    await session.waitForText(/tab all/, { label: "filters reset" });

    // 14. quit — a clean detach: the alt screen is left, the cursor returns.
    session.press("q");
    await session.waitForText(/detached\./, { label: "the detach frame" });
    const outcome = await session.waitForExit();
    assert.equal(outcome.code, 0, "the TUI exits 0 on q");
    const tail = session.rawTail(800);
    for (const seq of RESTORATION) {
      assert.ok(tail.includes(seq), `terminal restoration writes ${JSON.stringify(seq)}`);
    }
  } finally {
    await teardown(session, base);
  }
});

// --- RETRY after a normalized auth failure + provider switching ----------------

test("RETRY: a normalized provider-auth failure shows the auth band; p switches the next run to another provider; RETRY runs it and ACCEPT closes", async () => {
  const { base } = await makeWorkspace({ routingDefault: "bravo" });
  const session = await startTui({ workspace: base, cols: 120, rows: 36 });
  try {
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });

    // Create the task on bravo — the authfail agent.
    session.press("n");
    await session.waitForText(/NEW TASK/, { label: "the composer" });
    await session.waitForText(/BRAVO/, { label: "the default provider chip" });
    session.type("Re-authenticate the ingest worker");
    session.press("enter");

    // FAILED with the auth band — a provider-environment failure, normalized.
    await session.waitForText(/FAILED/, { timeout: 20000, label: "the FAILED group" });
    await session.waitForText(/invalid API key/, { label: "the failure reason" });
    await session.waitForText(/Bravo's authentication is no longer valid/, {
      label: "the auth band — 0x2F cannot sign in for you"
    });
    await session.waitForText(/RETRY/, { label: "the pinned RETRY" });
    let task = await waitForTask(base, 1, "failed");
    assert.match(task.error, /401|invalid api key/i, "the normalized auth error is stored");
    assert.equal(task.runs[0].provider, "bravo");
    assert.equal(task.runs[0].outcome, "failed");

    // Provider switching between runs: p points the NEXT run at charlie.
    session.press("p");
    await session.waitForText(/the next run would go to CHARLIE/, { label: "the retarget flash" });
    await session.waitForText(/RETRY ON CHARLIE/, { label: "the retargeted primary action" });

    // RETRY — a retry, not a send-back: the intent has not changed, only the
    // environment did; the new run goes to charlie.
    session.press("enter");
    await session.waitForText(/run 2 of #001 started on CHARLIE/, { label: "the rerun flash" });
    task = await waitForTask(base, 1, "ready", { tolerate: ["failed"] });
    assert.equal(task.runs.length, 2);
    assert.equal(task.runs[0].provider, "bravo", "run 01 stayed on bravo");
    assert.equal(task.runs[0].outcome, "failed");
    assert.equal(task.runs[1].provider, "charlie", "run 02 went to charlie");
    assert.equal(task.runs[1].outcome, "ready");

    await session.waitForText(/complete · awaiting you/, { label: "ready again" });
    session.press("enter"); // ACCEPT
    task = await waitForTask(base, 1, "done", { tolerate: ["ready"] });
    assert.equal(task.status, "done");

    session.press("q");
    await session.waitForText(/detached\./, { label: "the detach frame" });
    const outcome = await session.waitForExit();
    assert.equal(outcome.code, 0);
  } finally {
    await teardown(session, base);
  }
});

// --- navigation, search, help, scrolling, resize ---------------------------------

test("NAVIGATION: many tasks overflow the ledger; j/k/g/G move, / searches, ? help opens and closes, and a resize repaints the frame at the new size", async () => {
  const { base } = await makeWorkspace({ providerRoles: {}, routingDefault: "auto" });
  const store = storeOf(base);

  // Seed 26 tasks directly on disk — no workers, no providers — spanning
  // every state, so the ledger overflows any reasonable viewport.
  const specs = [];
  const needs = [
    ["dedupe ingest", "decision"],
    ["rate-limit headers", "decision"],
    ["flaky retry", "permission"],
    ["auth replay", "permission"],
    ["queue backoff", "decision"]
  ];
  for (const [title, kind] of needs) {
    specs.push({
      title,
      status: "needs_you",
      blockedOn:
        kind === "decision"
          ? { type: "decision", text: "Which retry policy?" }
          : { type: "permission", tool: "Edit", file: path.join(base, "src", "app.ts"), live: false }
    });
  }
  for (const title of ["retry storm", "bad gateway", "timeout drift", "headers lost"]) {
    specs.push({ title, status: "failed", error: "exit 1" });
  }
  for (const title of ["strip paths", "dedupe events", "truncate logs", "pin versions", "cache keys", "sort runs"]) {
    specs.push({ title, status: "ready" });
  }
  for (const title of ["audit auth", "migrate store", "backfill queue", "index events", "rotate keys", "rename columns"]) {
    specs.push({ title, status: "working" });
  }
  for (const title of ["fix typos", "update readme", "add tests", "bump deps", "remove dead code"]) {
    specs.push({ title, status: "done" });
  }
  assert.equal(specs.length, 26);

  for (const spec of specs) {
    const task = await store.createTask(
      { title: spec.title, brief: spec.title, prompt: spec.title },
      { provider: "claude-code" }
    );
    let updated = task;
    if (spec.status === "needs_you") {
      updated = applyOutcome(task, { status: "needs_you", blockedOn: spec.blockedOn });
    } else if (spec.status === "ready") {
      updated = applyOutcome(task, { status: "ready", result: "done" });
    } else if (spec.status === "failed") {
      updated = applyOutcome(task, { status: "failed", error: spec.error });
    } else if (spec.status === "done") {
      updated = closeTask(task);
    }
    await store.updateTask(updated);
  }

  const session = await startTui({ workspace: base, cols: 100, rows: 30 });
  try {
    // The counts row shows the full picture; the groups at the top of the
    // windowed ledger order it (the bottom groups are scrolled out — that is
    // the point of the viewport overflow).
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
    await session.waitForText(/! 5/, { label: "needs count" });
    await session.waitForText(/✕ 4/, { label: "failed count" });
    await session.waitForText(/✓ 6/, { label: "ready count" });
    await session.waitForText(/▶ 6/, { label: "working count" });
    await session.waitForText(/· 5/, { label: "done count" });
    for (const group of ["NEEDS YOU", "FAILED", "READY"]) {
      await session.waitForText(new RegExp(group), { label: `group header ${group}` });
    }

    // The cursor starts on what wants you.
    await session.waitForText(/NEEDS YOU ·/, { label: "first selection is a needs task" });

    // G jumps to the last row (a closed task) and the ledger windows onto
    // the bottom groups; g back to the first.
    session.press("G");
    await session.waitForText(/closed after/, { label: "selection at a closed task" });
    await session.waitForText(/CLOSED/, { label: "the window shows the bottom group" });
    session.press("g");
    await session.waitForText(/NEEDS YOU ·/, { label: "selection back at the top" });

    // j walks the whole ledger without ever breaking the frame.
    for (let i = 0; i < 34; i++) session.press("j");
    await session.waitForText(/closed after/, { label: "j clamps at the last row" });
    assert.match(session.text(), /0x2F/);

    // / search — by title, brief or number; esc clears.
    session.press("/");
    await session.waitForText(/SEARCH/, { label: "the search footer" });
    session.type("dedupe");
    await session.waitForText(/2 of 26 tasks match/, { label: "the match count" });
    session.press("enter");
    await session.waitForText(/dedupe ingest/, { label: "the matching row" });
    await session.waitForText(/dedupe events/, { label: "the other matching row" });
    assert.ok(!session.text().includes("rate-limit headers"), "the ledger is filtered");
    session.press("escape");
    await session.waitForText(/tab all/, { label: "the filter hint after clearing" });

    // ? help opens a full frame; any key closes it back to the ledger.
    session.press("?");
    await session.waitForText(/KEYS/, { label: "the help frame" });
    await session.waitForText(/a TASK is permanent/, { label: "the model notes" });
    await session.waitForText(/any key/, { label: "the help hint" });
    session.press("escape");
    await session.waitForText(/n to submit work/, { label: "back to the work frame" });

    // Resize: the frame repaints at the new size, header and footer intact.
    session.resize(24, 80);
    await session.waitForFrame(24, 80);
    assert.equal(session.width(), 80, "the frame is 80 columns wide");
    assert.equal(session.rows(), 24, "the frame is 24 rows tall");
    assert.match(session.text(), /0x2F/);
    assert.match(session.text(), /n to submit work/);

    session.resize(36, 120);
    await session.waitForFrame(36, 120);
    assert.equal(session.width(), 120);
    assert.equal(session.rows(), 36);
    assert.match(session.text(), /0x2F/);
    assert.match(session.text(), /n to submit work/);

    session.press("q");
    await session.waitForText(/detached\./, { label: "the detach frame" });
    const outcome = await session.waitForExit();
    assert.equal(outcome.code, 0);
  } finally {
    await teardown(session, base);
  }
});

// --- clean restoration on interruption --------------------------------------------

test("RESTORATION: SIGTERM and ⌃C both restore the terminal — alt screen off, cursor back, styles reset", async () => {
  // SIGTERM — the OS interruption path the TUI explicitly handles.
  {
    const { base } = await makeWorkspace({ providerRoles: {}, routingDefault: "auto" });
    const session = await startTui({ workspace: base, cols: 100, rows: 30 });
    try {
      await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
      session.signal("SIGTERM");
      const outcome = await session.waitForExit();
      assert.equal(outcome.code, 0, "SIGTERM exits 0 after restoring");
      const tail = session.rawTail(800);
      for (const seq of RESTORATION) {
        assert.ok(tail.includes(seq), `restores ${JSON.stringify(seq)} on SIGTERM`);
      }
    } finally {
      await teardown(session, base);
    }
  }

  // ⌃C — the raw-mode byte decodes to the design's detach, twice to leave.
  {
    const { base } = await makeWorkspace({ providerRoles: {}, routingDefault: "auto" });
    const session = await startTui({ workspace: base, cols: 100, rows: 30 });
    try {
      await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
      session.press("ctrl-c");
      await session.waitForText(/detached\./, { label: "the detach frame" });
      session.press("ctrl-c");
      const outcome = await session.waitForExit();
      assert.equal(outcome.code, 0, "⌃C exits 0 after restoring");
      const tail = session.rawTail(800);
      for (const seq of RESTORATION) {
        assert.ok(tail.includes(seq), `restores ${JSON.stringify(seq)} on ⌃C`);
      }
    } finally {
      await teardown(session, base);
    }
  }
});
