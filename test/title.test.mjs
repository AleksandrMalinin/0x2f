// Task title derivation (src/core/title.mjs).
//
// Dogfooding rejected a real ~1,000 character security-audit brief pasted
// into the composer, because the composer's text was treated as the task
// TITLE and titles are capped at 400 characters. The fix separates the two:
// the user writes one thing (the brief), and 0x2F derives the short label a
// ledger row shows.
//
// The derivation is deterministic — no model call. It runs on the task
// CREATE path, so a model call would make creating a task fail whenever a
// provider's auth expires, add a round trip before the run starts, and make
// the same brief produce different titles on different days.
//
// This module is the single implementation: core persists what it returns,
// and the browser client (web/ledger.mjs) re-derives from it to decide
// whether a detail view still needs to show the brief underneath.

import test from "node:test";
import assert from "node:assert/strict";
import { deriveTitle, briefBody, normalizeBrief, TITLE_TARGET } from "../src/core/title.mjs";

// --- the property that keeps today's simple cases simple --------------------

test("a short one-line brief IS its own title — nothing changes for simple input", () => {
  const { title, complete } = deriveTitle("fix the login redirect");
  assert.equal(title, "fix the login redirect");
  // complete === true means no detail view renders the brief a second time:
  // a one-line task looks exactly as it did before briefs existed.
  assert.equal(complete, true);
});

test("a blank brief derives nothing and is not treated as incomplete", () => {
  assert.deepEqual(deriveTitle("   \n  "), { title: "", complete: true });
  assert.deepEqual(deriveTitle(""), { title: "", complete: true });
  assert.deepEqual(deriveTitle(null), { title: "", complete: true });
});

// --- the dogfood case -------------------------------------------------------

test("a multi-paragraph engineering brief yields a scannable title and stays incomplete", () => {
  const brief =
    "Investigate and fix the task-creation friction discovered during dogfooding.\n\n" +
    "A real security-audit brief (~1,000 chars) entered into the composer was " +
    "rejected because the current input is treated as the task title, which has " +
    "a 400-character limit.\n\n" +
    "The user should be able to paste a normal engineering brief without " +
    "understanding an internal distinction between task title and task prompt.";
  const { title, complete } = deriveTitle(brief);
  assert.equal(
    title,
    "Investigate and fix the task-creation friction discovered during dogfooding."
  );
  assert.ok(title.length <= TITLE_TARGET);
  assert.equal(complete, false, "the brief says far more than the title — a detail view must show it");
});

// --- the first sentence, correctly identified -------------------------------

test("the title is the first sentence, not the first paragraph", () => {
  const { title } = deriveTitle("Fix the login redirect. It 500s on Safari only.");
  assert.equal(title, "Fix the login redirect.");
});

test("an abbreviation does not end the sentence early", () => {
  // Without the abbreviation rule this would be the useless fragment "Use e.g."
  assert.equal(deriveTitle("Use e.g. the shared helper here.").title, "Use e.g. the shared helper here.");
  assert.equal(deriveTitle("The U.S. region flag is wrong. Fix it.").title, "The U.S. region flag is wrong.");
  assert.equal(deriveTitle("Check i.e. the retry path. Then ship.").title, "Check i.e. the retry path.");
});

test("a version number does not split the title mid-number", () => {
  assert.equal(
    deriveTitle("Upgrade to v0.5.2 and verify. Then ship it.").title,
    "Upgrade to v0.5.2 and verify."
  );
});

test("a brief with no terminal punctuation is wholly the title", () => {
  const { title, complete } = deriveTitle("audit the auth boundary for token leakage");
  assert.equal(title, "audit the auth boundary for token leakage");
  assert.equal(complete, true);
});

test("CJK sentence terminators end a sentence without a following space", () => {
  const { title } = deriveTitle("これは日本語のテキストです。これは二番目の文です。");
  assert.equal(title, "これは日本語のテキストです。");
});

// --- markdown decoration ----------------------------------------------------

test("leading markdown decoration is stripped from the title", () => {
  assert.equal(deriveTitle("# Fix the login redirect").title, "Fix the login redirect");
  assert.equal(deriveTitle("- audit the auth boundary").title, "audit the auth boundary");
  assert.equal(deriveTitle("1. Do the thing").title, "Do the thing");
  assert.equal(deriveTitle("> quoted request").title, "quoted request");
});

// THE adjustment that matters for rendering: a decorated one-line brief is
// STILL fully represented by its title. A naive `brief !== title` check would
// call this incomplete and render a "body" that only repeats the heading.
test("a decorated one-line brief is complete — the title represents all of it", () => {
  for (const brief of ["# Fix the login redirect", "- Fix the login redirect", "1. Fix the login redirect"]) {
    const { title, complete } = deriveTitle(brief);
    assert.equal(title, "Fix the login redirect", brief);
    assert.notEqual(title, brief, "a plain string comparison would disagree — that is the point");
    assert.equal(complete, true, brief);
  }
});

test("a brief that merely wraps across lines is complete once normalized", () => {
  const { title, complete } = deriveTitle("audit the auth boundary\nfor token leakage");
  // The title is the first LINE (no sentence break to find), so it cannot
  // represent the wrapped remainder — incomplete, and the body renders.
  assert.equal(title, "audit the auth boundary");
  assert.equal(complete, false);
  // But normalization is what the comparison is made against, so a brief
  // whose only difference is whitespace collapses to the same string.
  assert.equal(normalizeBrief("  audit the auth\n  boundary  "), "audit the auth boundary");
  assert.equal(deriveTitle("  audit the auth boundary  ").complete, true);
});

// --- truncation -------------------------------------------------------------

test("an over-long first sentence is cut at a word boundary, never mid-word", () => {
  const brief =
    "Investigate the intermittent session store replay failure that appears only " +
    "under sustained parallel load on the staging cluster and never locally.";
  const { title, complete } = deriveTitle(brief);
  assert.ok(title.length <= TITLE_TARGET + 1, `got ${title.length}`); // + the "…"
  assert.ok(title.endsWith("…"));
  // The cut landed on a word boundary: no partial word before the marker.
  const words = title.slice(0, -1).trim().split(" ");
  assert.ok(brief.includes(words.at(-1)), "the last word must be a whole word from the brief");
  assert.equal(complete, false, "a truncated title can never represent the whole brief");
});

test("text with no spaces at all still truncates safely (no word boundary to find)", () => {
  const { title, complete } = deriveTitle("x".repeat(500));
  assert.ok(title.length <= TITLE_TARGET + 1);
  assert.ok(title.endsWith("…"));
  assert.equal(complete, false);
});

test("a CJK run with no spaces truncates without hanging or over-cutting", () => {
  const { title } = deriveTitle("これは日本語のテキストです".repeat(40));
  assert.ok(title.length <= TITLE_TARGET + 1);
  assert.ok(title.endsWith("…"));
});

test("a title at exactly the target is not truncated", () => {
  const exact = "a".repeat(TITLE_TARGET);
  const { title } = deriveTitle(exact);
  assert.equal(title, exact);
  assert.ok(!title.endsWith("…"));
});

test("the derived title always fits the storage guard with room to spare", () => {
  // MAX_TITLE (400) is a storage guard on a value 0x2F computes; derivation
  // targets ~80, so it can never be the thing a user hits by writing.
  for (const brief of ["x".repeat(10_000), "word ".repeat(2000), "これは日本語です。".repeat(500)]) {
    assert.ok(deriveTitle(brief).title.length <= TITLE_TARGET + 1);
  }
});

// --- the body a detail view renders under the heading -----------------------
//
// The heading is the derived title; the body must not repeat it. This is the
// same heading + body split the decision card uses for an agent's question.

test("briefBody is empty when the title already says everything", () => {
  assert.equal(briefBody("fix the login redirect"), "");
  assert.equal(briefBody("# Fix the login redirect"), "");
  assert.equal(briefBody("  fix the login redirect  "), "");
  assert.equal(briefBody(""), "");
});

test("briefBody is the REST of the brief — the heading sentence is never repeated", () => {
  assert.equal(briefBody("Fix the login redirect. It 500s on Safari."), "It 500s on Safari.");
  assert.equal(briefBody("audit the auth boundary\nfor token leakage"), "for token leakage");
});

test("briefBody preserves the structure of everything after the opening sentence", () => {
  const brief =
    "Audit the authentication boundary for token leakage.\n\n" +
    "Scope\n- every token path\n- the pairing ceremony\n\nConstraints\n- no new dependencies";
  const body = briefBody(brief);
  assert.ok(!body.includes("Audit the authentication boundary"), "the heading must not appear twice");
  assert.ok(body.startsWith("Scope"));
  assert.ok(body.includes("- the pairing ceremony"), "list structure survives untouched");
  assert.ok(body.includes("no new dependencies"), "nothing after the opening is lost");
});

test("a TRUNCATED title renders the whole brief — a remainder would start mid-thought", () => {
  const brief =
    "Investigate the intermittent session store replay failure that appears only " +
    "under sustained parallel load on the staging cluster and never locally.";
  const { title } = deriveTitle(brief);
  assert.ok(title.endsWith("…"));
  // The heading is visibly cut, so re-reading the full opening sentence is
  // what the reader needs — not a body beginning in the middle of a word.
  assert.equal(briefBody(brief), brief);
});
