import test from "node:test";
import assert from "node:assert/strict";
import { applyOutcome, beginResume, closeTask, STATUSES, classifyResult, blockedResultText, FAILURE_KINDS } from "../src/core/lifecycle.mjs";

const baseTask = () => ({
  id: 2,
  slug: "002-x",
  title: "X",
  status: "working",
  execution: { provider: "claude-code", attempts: 1 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

test("lifecycle exposes the five Work statuses", () => {
  assert.deepEqual(STATUSES, ["working", "needs_you", "ready", "failed", "done"]);
});

test("working + ready outcome -> ready", () => {
  const task = applyOutcome(baseTask(), { status: "ready", result: "done" });
  assert.equal(task.status, "ready");
  assert.equal(task.blockedOn, undefined);
  assert.equal(task.error, undefined);
});

test("working + failed outcome -> failed with error", () => {
  const task = applyOutcome(baseTask(), { status: "failed", error: "boom" });
  assert.equal(task.status, "failed");
  assert.equal(task.error, "boom");
  assert.equal(task.blockedOn, undefined);
});

test("working + permission outcome -> needs_you with blockedOn.type=permission", () => {
  const task = applyOutcome(baseTask(), {
    status: "needs_you",
    reason: "permission",
    blockedOn: { type: "permission", tool: "Edit", file: "/r/a.tsx" }
  });
  assert.equal(task.status, "needs_you");
  assert.equal(task.blockedOn.type, "permission");
  assert.equal(task.blockedOn.tool, "Edit");
});

test("working + decision outcome -> needs_you with blockedOn.type=decision", () => {
  const task = applyOutcome(baseTask(), {
    status: "needs_you",
    reason: "decision",
    blockedOn: { type: "decision", text: "pick a backend" }
  });
  assert.equal(task.status, "needs_you");
  assert.equal(task.blockedOn.type, "decision");
});

test("needs_you + beginResume(allow) -> working, blockedOn cleared, attempts bumped", () => {
  let task = applyOutcome(baseTask(), {
    status: "needs_you",
    reason: "permission",
    blockedOn: { type: "permission", tool: "Edit", file: "/r/a.tsx" }
  });
  task = { ...task, execution: { provider: "claude-code", externalSessionId: "sess-1", attempts: 1 } };

  const resumed = beginResume(task, "allow");
  assert.equal(resumed.status, "working");
  assert.equal(resumed.blockedOn, undefined);
  assert.equal(resumed.execution.attempts, 2);
  assert.equal(resumed.execution.externalSessionId, "sess-1");
  assert.equal(resumed.execution.lastAction, "allow");
});

test("full lifecycle: working -> needs_you -> working -> ready -> done", () => {
  let task = baseTask();
  assert.equal(task.status, "working");

  task = applyOutcome(task, {
    status: "needs_you",
    reason: "permission",
    blockedOn: { type: "permission", tool: "Edit", file: "/r/a.tsx" }
  });
  assert.equal(task.status, "needs_you");

  task = beginResume(task, "allow");
  assert.equal(task.status, "working");

  task = applyOutcome(task, { status: "ready", result: "1 file changed" });
  assert.equal(task.status, "ready");

  task = closeTask(task);
  assert.equal(task.status, "done");
});

test("beginResume on a non-needs_you task throws", () => {
  assert.throws(() => beginResume(baseTask(), "allow"), /not needs_you/);
});

test("closeTask works from needs_you too (user abandons)", () => {
  const task = applyOutcome(baseTask(), {
    status: "needs_you",
    reason: "permission",
    blockedOn: { type: "permission" }
  });
  assert.equal(closeTask(task).status, "done");
});

// --- completed-run classification (item 2) ------------------------------------

test("FAILURE_KINDS includes the blocked kind", () => {
  assert.ok(FAILURE_KINDS.includes("blocked"));
});

test("classifyResult: an explicit blocker report is failed, not ready", () => {
  const out = classifyResult(
    "## Result\nI could not continue because the sandbox blocked writes to the workspace.\n## Changes\nNone"
  );
  assert.equal(out.status, "failed");
  assert.equal(out.failure.kind, "blocked");
  assert.match(out.error, /could not continue/);
});

test("classifyResult: a task-level passive blocker is failed", () => {
  const out = classifyResult(
    "The task could not be completed because the environment denied network access."
  );
  assert.equal(out.status, "failed");
  assert.equal(out.failure.kind, "blocked");
});

test("classifyResult: a partial limitation is NOT a blocker (work was done)", () => {
  const out = classifyResult(
    "## Result\nThe fix is complete and the diff is applied.\n## Evidence\nAll tests pass locally.\n## Changes\n- src/fix.mjs\n## Verification\nI could not run the integration suite because the sandbox blocks network access, but the unit tests pass."
  );
  assert.equal(out.status, "ready");
});

test("classifyResult: a warning about a subtask never becomes a blocker", () => {
  const out = classifyResult(
    "## Result\nThe tests could not continue because the service was down, so I verified the change statically instead. The task is done."
  );
  assert.equal(out.status, "ready");
});

test("classifyResult: an explicit decision protocol still wins over ready", () => {
  const out = classifyResult(
    "## Result\ninvestigated\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend should the retry use?"
  );
  assert.equal(out.status, "needs_you");
  assert.equal(out.reason, "decision");
  assert.match(out.blockedOn.text, /Which backend/);
});

test("classifyResult: plain completed text is ready", () => {
  const out = classifyResult("## Result\nfixed it\n## Verification\nnpm test");
  assert.equal(out.status, "ready");
});

test("blockedResultText: returns the agent's own explanation sentence, capped", () => {
  const text = "I could not continue because the sandbox blocked writes. I tried three times.";
  const err = blockedResultText(text);
  assert.ok(err && err.includes("could not continue"));
  assert.ok(!err.includes("three times"));
});
