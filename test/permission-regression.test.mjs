// Regression coverage for the exact v0 dogfooding failure:
//
//   Input:  a headless agent run that exits successfully (exit 0,
//           result.is_error === false) but whose final state says it cannot
//           continue because file editing requires user permission.
//   Expected: status = needs_you, blockedOn.type = permission.
//   NOT:      status = ready.
//
// The fixtures are sanitized synthetic replays of real
// `claude -p --output-format stream-json` captures (event structure
// preserved; machine-specific paths, session ids, and usage data removed):
//   permission-blocked.jsonl  — blocked Edit denial (this regression)
//   resume-completed.jsonl    — the same session resumed after grant
//   completed.jsonl           — a clean trivial run

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseStreamJson, normalizeOutcome } from "../src/providers/claude-code.mjs";
import { applyOutcome, beginResume } from "../src/core/lifecycle.mjs";

const fixture = name =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function outcomeFromFixture(name) {
  const events = parseStreamJson(fixture(name));
  const init = events.find(e => e.type === "system" && e.subtype === "init");
  const result = events.find(e => e.type === "result");
  assert.ok(result, `fixture ${name} has a result event`);
  return normalizeOutcome(result, { sessionId: init?.session_id });
}

const baseTask = () => ({
  id: 2,
  slug: "002-x",
  title: "X",
  status: "working",
  execution: { provider: "claude-code", attempts: 1 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

test("REGRESSION: exit-0 run blocked on file-edit permission -> needs_you, reason=permission", () => {
  const outcome = outcomeFromFixture("permission-blocked.jsonl");

  // The process succeeded — but the task did not.
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "permission");
  assert.notEqual(outcome.status, "ready");

  // Normalized blockedOn carries the concrete request.
  assert.equal(outcome.blockedOn.type, "permission");
  assert.equal(outcome.blockedOn.tool, "Edit");
  assert.match(outcome.blockedOn.file, /note\.txt$/);
  assert.match(outcome.blockedOn.plannedChange, /hello work/);

  // The session id is preserved so the task can be resumed later.
  assert.equal(outcome.externalSessionId, "11111111-1111-4111-8111-111111111111");
});

test("REGRESSION at the task layer: v0 marked this READY; v0.2 marks it needs_you", () => {
  const outcome = outcomeFromFixture("permission-blocked.jsonl");
  const task = applyOutcome(baseTask(), outcome);

  assert.equal(task.status, "needs_you");
  assert.equal(task.blockedOn.type, "permission");
});

test("after approval, resume outcome on the same session -> working -> ready", () => {
  const blocked = outcomeFromFixture("permission-blocked.jsonl");
  let task = applyOutcome(baseTask(), blocked);
  assert.equal(task.status, "needs_you");

  task = {
    ...task,
    execution: {
      provider: "claude-code",
      externalSessionId: blocked.externalSessionId,
      attempts: 1
    }
  };
  task = beginResume(task, "allow");
  assert.equal(task.status, "working");

  const resumed = outcomeFromFixture("resume-completed.jsonl");
  // Same underlying execution session continues.
  assert.equal(resumed.externalSessionId, blocked.externalSessionId);

  task = applyOutcome(task, resumed);
  assert.equal(task.status, "ready");
});

test("clean successful run -> ready", () => {
  const outcome = outcomeFromFixture("completed.jsonl");
  assert.equal(outcome.status, "ready");
  assert.ok(outcome.result.length > 0);
});

test("result with is_error=true -> failed", () => {
  const outcome = normalizeOutcome({
    is_error: true,
    errors: ["Something broke"],
    result: ""
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Something broke");
});

test("result text with a real decision section -> needs_you/decision", () => {
  const outcome = normalizeOutcome({
    is_error: false,
    result:
      "## Result\ninvestigated\n\n## Needs human decision\nWhich backend should we standardize on?"
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.blockedOn.type, "decision");
});

test("result text with 'None' decision section -> ready", () => {
  const outcome = normalizeOutcome({
    is_error: false,
    result: "## Result\nok\n## Needs human decision\nNone"
  });
  assert.equal(outcome.status, "ready");
});

test("denials win even when is_error is also true (blocked, not failed)", () => {
  const outcome = normalizeOutcome({
    is_error: true,
    errors: ["n/a"],
    permission_denials: [{ tool_name: "Edit", tool_input: { file_path: "/r/x.ts" } }]
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.blockedOn.type, "permission");
});
