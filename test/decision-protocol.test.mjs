// Decision protocol — the machine-read contract for needs_you/decision.
//
// REGRESSION (task /02, the first successful DeepSeek Harness dogfood run):
// the agent's output ended with
//
//   ## Needs human decision
//
//   None. The only open detail is TTY-only vs. always-on glyphs, which is a
//   trivial implementation choice, not a product/architecture/ownership
//   decision.
//
// and 0x2F ended in a FALSE NEEDS YOU / DECISION REQUIRED — the parser saw
// "a section exists with non-empty prose" and treated it as a decision.
//
// The invariant this suite pins: NEEDS YOU means execution genuinely requires
// human input before the Work can proceed. Only an explicit positive
// machine-readable signal — REQUIRED: yes — can produce needs_you/decision.
// A heading, a mention, "None.", "No decision required", or any other prose
// never can. There is deliberately NO prose interpretation here.

import test from "node:test";
import assert from "node:assert/strict";
import { decisionSection, hasHumanDecision } from "../src/core/lifecycle.mjs";
import { normalizeDshRun } from "../src/providers/deepseek-harness.mjs";
import { normalizeOutcome } from "../src/providers/claude-code.mjs";
import { normalizeCommandRun } from "../src/providers/command.mjs";

// The exact /02 capture (the decision section verbatim from its result.md).
const D02_CAPTURE =
  "## Result\n\nThe current `2f providers` table is functionally complete.\n\n" +
  "## Needs human decision\n\n" +
  "None. The only open detail is TTY-only vs. always-on glyphs, which is a " +
  "trivial implementation choice, not a product/architecture/ownership decision.";

// --- the parser ------------------------------------------------------------

test("a normal result without the section is not a decision", () => {
  assert.equal(decisionSection("## Result\nfixed it\n## Verification\nnpm test"), null);
  assert.equal(hasHumanDecision("## Result\nfixed it"), false);
});

test("merely mentioning the convention is not a decision", () => {
  const text =
    "I considered adding a ## Needs human decision section, but nothing here " +
    "requires a human.";
  assert.equal(decisionSection(text), null);
});

test("REGRESSION /02: 'None.' plus explanation under the heading is not a decision", () => {
  assert.equal(decisionSection(D02_CAPTURE), null);
});

test("a bare 'None' section is not a decision", () => {
  assert.equal(decisionSection("## Result\nok\n## Needs human decision\nNone"), null);
  assert.equal(decisionSection("## Result\nok\n## Needs human decision\nNone."), null);
  assert.equal(decisionSection("## Result\nok\n## Needs human decision\nNo decision required"), null);
});

test("REQUIRED: no is an explicit no-decision signal", () => {
  const text = "## Result\nok\n## Needs human decision\nREQUIRED: no";
  assert.equal(decisionSection(text), null);
});

test("a non-positive REQUIRED value is not a decision", () => {
  assert.equal(
    decisionSection("## Needs human decision\nREQUIRED: maybe\nQUESTION: x?"),
    null
  );
  assert.equal(
    decisionSection("## Needs human decision\nREQUIRED: yes.\nQUESTION: x?"),
    null
  );
  assert.equal(
    decisionSection("## Needs human decision\nREQUIRED: y\nQUESTION: x?"),
    null
  );
});

test("a question without the positive signal is not a decision (malformed block)", () => {
  assert.equal(
    decisionSection("## Needs human decision\nQUESTION: Which backend?"),
    null
  );
  // The old prose convention is now malformed by definition.
  assert.equal(
    decisionSection("## Needs human decision\nWhich backend should we standardize on?"),
    null
  );
});

test("REQUIRED: yes with no readable question is incomplete, not a decision", () => {
  assert.equal(decisionSection("## Needs human decision\nREQUIRED: yes"), null);
});

test("REQUIRED: yes + QUESTION is a genuine decision; the question is preserved", () => {
  const text =
    "## Result\ninvestigated\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend should we standardize on?";
  const section = decisionSection(text);
  assert.equal(section, "Which backend should we standardize on?");
  assert.equal(hasHumanDecision(text), true);
});

test("REQUIRED: yes with the question as prose after the marker is preserved", () => {
  const text =
    "## Needs human decision\nREQUIRED: yes\nWhich backend should we standardize on?";
  assert.equal(
    decisionSection(text),
    "Which backend should we standardize on?"
  );
});

test("the signal is case-insensitive; keys may be lowercase", () => {
  assert.equal(
    decisionSection("## Needs human decision\nrequired: YES\nquestion: Keep the CLI plain?"),
    "Keep the CLI plain?"
  );
});

test("a long question is capped, never dropped", () => {
  const question = "q".repeat(500) + "?";
  const section = decisionSection(
    `## Needs human decision\nREQUIRED: yes\nQUESTION: ${question}`
  );
  assert.ok(section.length < question.length);
  assert.match(section, /q+…/);
});

test("a decision block is the LAST section: later ## headings bound it", () => {
  const text =
    "## Needs human decision\nREQUIRED: yes\nQUESTION: X or Y?\n\n## Verification\nnpm test";
  assert.equal(decisionSection(text), "X or Y?");
});

// --- provider normalization (all providers share the same parser) ----------

test("normalizeDshRun: the /02 capture -> READY, not needs_you", () => {
  const outcome = normalizeDshRun({ code: 0, stdout: D02_CAPTURE });
  assert.equal(outcome.status, "ready");
  assert.match(outcome.result, /None\. The only open detail/);
});

test("normalizeDshRun: explicit protocol -> needs_you/decision with the question", () => {
  const outcome = normalizeDshRun({
    code: 0,
    stdout:
      "## Result\ninvestigated\n\n## Needs human decision\nREQUIRED: yes\nQUESTION: Which backend?"
  });
  assert.equal(outcome.status, "needs_you");
  assert.equal(outcome.reason, "decision");
  assert.equal(outcome.blockedOn.type, "decision");
  assert.equal(outcome.blockedOn.text, "Which backend?");
});

test("normalizeOutcome (Claude): explicit protocol -> needs_you/decision; prose -> ready", () => {
  const decision = normalizeOutcome({
    is_error: false,
    result:
      "## Result\ninvestigated\n## Needs human decision\nREQUIRED: yes\nQUESTION: X or Y?"
  });
  assert.equal(decision.status, "needs_you");
  assert.equal(decision.blockedOn.text, "X or Y?");

  const prose = normalizeOutcome({
    is_error: false,
    result:
      "## Result\ninvestigated\n## Needs human decision\nNone. Nothing requires a human."
  });
  assert.equal(prose.status, "ready");
});

test("normalizeCommandRun: explicit protocol -> needs_you/decision; prose -> ready", () => {
  const decision = normalizeCommandRun({
    code: 0,
    stdout:
      "## Result\nx\n## Needs human decision\nREQUIRED: yes\nQUESTION: pick one"
  });
  assert.equal(decision.status, "needs_you");
  assert.equal(decision.blockedOn.text, "pick one");

  const prose = normalizeCommandRun({
    code: 0,
    stdout: "## Result\nx\n## Needs human decision\nNone"
  });
  assert.equal(prose.status, "ready");
});
