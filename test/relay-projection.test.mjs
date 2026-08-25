// Relay projection additions for the dogfood review (src/relay/project.mjs):
//
//   §01 — task.failure (kind/remedy) crosses the relay boundary, re-vetted
//         against the same closed vocabulary core/lifecycle.mjs enforces —
//         the phone's copy names a provider and a machine it cannot reach,
//         so it needs the same classification the local UI gets.
//   §02 — projectSnapshot carries a bounded workspace label and a node
//         (machine) label — never the absolute path, which stays Mac-only
//         exactly like `base` itself already did.
//   §03 — the decision question's relay cap is raised to match the storage
//         cap, and an actual cut (if the bound is ever hit) is marked
//         explicitly rather than rendered as an indistinguishable "…".

import test from "node:test";
import assert from "node:assert/strict";
import {
  projectTask,
  projectBlockedOn,
  projectSnapshot,
  projectWorkspaceLabel,
  REMOTE_LIMITS
} from "../src/relay/project.mjs";
import { FAILURE_KINDS } from "../src/core/lifecycle.mjs";
import { MAX_BRIEF } from "../src/core/limits.mjs";

const baseTask = (over = {}) => ({
  id: 1,
  title: "t",
  status: "failed",
  execution: { provider: "claude-code", node: "local", workspace: "local" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  error: "boom",
  ...over
});

// --- §01: failure crosses the boundary, re-vetted ---------------------------

test("projectTask: a recognized failure.kind (and adapter remedy) crosses the relay", () => {
  const p = projectTask(baseTask({ failure: { kind: "auth", remedy: "claude /login" } }));
  assert.deepEqual(p.failure, { kind: "auth", remedy: "claude /login" });
});

test("projectTask: an unrecognized kind never reaches the phone — re-vetted, not trusted", () => {
  // Simulates a bypass of the core/lifecycle.mjs gate (a bug, a future
  // provider that forgets to validate) — the relay boundary is a second,
  // independent check, not a rubber stamp on already-trusted data.
  const p = projectTask(baseTask({ failure: { kind: "sudo rm -rf /", remedy: "haha" } }));
  assert.equal(p.failure, undefined);
});

test("projectTask: no failure field at all projects to undefined, exactly as before", () => {
  const p = projectTask(baseTask());
  assert.equal(p.failure, undefined);
});

test("projectTask: failure.remedy is bounded like any other adapter-authored field", () => {
  const p = projectTask(baseTask({ failure: { kind: "auth", remedy: "x".repeat(500) } }));
  assert.ok(p.failure.remedy.length < 500);
});

test("the closed vocabulary the relay checks against is the same one core/lifecycle.mjs owns", () => {
  assert.deepEqual(FAILURE_KINDS, ["auth", "unavailable", "crashed"]);
  for (const kind of FAILURE_KINDS) {
    const p = projectTask(baseTask({ failure: { kind } }));
    assert.equal(p.failure.kind, kind);
  }
});

// --- §02: workspace + node identity, bounded, never the absolute path ------

test("projectWorkspaceLabel: the basename only, never the absolute path", () => {
  assert.equal(projectWorkspaceLabel("/Users/bob/code/0x2f-site"), "0x2f-site");
  assert.equal(projectWorkspaceLabel("/Users/bob/code/0x2f-site/"), "0x2f-site");
  assert.equal(projectWorkspaceLabel(""), null);
  assert.equal(projectWorkspaceLabel(null), null);
});

test("projectWorkspaceLabel: a long name is truncated from the LEFT so the distinguishing tail survives", () => {
  const long = "a".repeat(60) + "-distinguishing-tail";
  const label = projectWorkspaceLabel("/Users/bob/code/" + long);
  assert.ok(label.length <= REMOTE_LIMITS.workspaceLabel);
  assert.ok(label.startsWith("…"));
  assert.ok(label.endsWith("distinguishing-tail"));
});

test("projectSnapshot: carries a bounded workspace label and node — never the absolute base", async () => {
  const snap = await projectSnapshot({
    tasks: [],
    eventsByTask: {},
    providers: [],
    routing: {},
    base: "/Users/bob/secret/0x2f-site",
    node: "Bobs-MacBook-Pro.local",
    serverTime: 12345
  });
  assert.deepEqual(snap.workspace, { label: "0x2f-site" });
  assert.equal(snap.node, "Bobs-MacBook-Pro.local");
  assert.equal(JSON.stringify(snap).includes("/Users/bob/secret"), false, "the absolute path must never appear anywhere in the snapshot");
});

test("projectSnapshot: absent base/node project to null, not a crash or an empty string standing in for absence", async () => {
  const snap = await projectSnapshot({
    tasks: [],
    eventsByTask: {},
    providers: [],
    routing: {},
    base: "",
    node: null,
    serverTime: 1
  });
  assert.equal(snap.workspace, null);
  assert.equal(snap.node, null);
});

// --- §03: the relay's decision cap matches the storage cap ------------------

test("projectBlockedOn: the decision cap is raised to 4000, matching core/lifecycle.mjs's storage guard", () => {
  assert.equal(REMOTE_LIMITS.decision, 4000);
});

test("projectBlockedOn: a question under the cap is passed through completely, newlines intact", () => {
  const text = "Which backend?\n\nPostgres is already used elsewhere.";
  const out = projectBlockedOn({ type: "decision", text }, "");
  assert.equal(out.text, text);
});

test("projectBlockedOn: a genuine over-cap cut is marked explicitly, never a bare ellipsis", () => {
  const text = "q".repeat(5000);
  const out = projectBlockedOn({ type: "decision", text }, "");
  assert.ok(out.text.length < text.length);
  assert.match(out.text, /\[truncated by the relay\]$/);
  // Never the bare "…" a reader could mistake for the agent's own writing.
  assert.doesNotMatch(out.text, /q…$/);
});

test("projectBlockedOn: an absolute workspace path inside a decision question is still stripped", () => {
  const base = "/Users/bob/secret/project";
  const out = projectBlockedOn(
    { type: "decision", text: "Should " + base + "/src/a.ts move?" },
    base
  );
  assert.equal(out.text.includes(base), false);
  assert.match(out.text, /Should …\/src\/a\.ts move\?/);
});

// --- the task brief on the remote surface -----------------------------------
//
// The phone's task detail shows the user's own brief. If the relay cut it to
// a short cap, the phone would silently show a different (shorter) task than
// the Mac — so the brief is carried WHOLE: the relay's bound is the same
// MAX_BRIEF the action already enforced, meaning the cap can never bite in
// practice. If it ever did, the cut is explicit and the surface is told, so
// the phone says "truncated" rather than ending mid-sentence.

test("projectTask carries the full brief — a long brief is not cut for the phone", async () => {
  const brief =
    "Audit the authentication boundary for token leakage.\n\n" +
    "Scope\n- every path that reads or writes the per-runtime auth token\n" +
    "- the pairing ceremony and the device secret rotation flow\n\n" +
    "Constraints\n- do not change the wire protocol\n- no new dependencies";
  const p = projectTask(baseTask({ brief }));
  assert.equal(p.brief, brief, "every character reaches the phone");
  assert.equal(p.briefTruncated, undefined, "nothing was cut, so nothing claims it was");
});

test("the relay's brief bound IS the action's bound — the remote surface loses nothing", () => {
  assert.equal(REMOTE_LIMITS.brief, MAX_BRIEF);
  const atCap = "x".repeat(MAX_BRIEF);
  const p = projectTask(baseTask({ brief: atCap }));
  assert.equal(p.brief, atCap);
  assert.equal(p.briefTruncated, undefined);
});

test("a brief beyond the bound is cut EXPLICITLY and flagged for the UI to say so", () => {
  const p = projectTask(baseTask({ brief: "x".repeat(MAX_BRIEF + 500) }));
  assert.ok(p.brief.length < MAX_BRIEF + 500);
  assert.match(p.brief, /\[truncated by the relay\]$/);
  assert.equal(p.briefTruncated, true, "the UI must be able to say the text was cut");
});

test("a task with no brief falls back to its title, as legacy tasks require", () => {
  const legacy = baseTask({ title: "legacy task" });
  delete legacy.brief;
  assert.equal(projectTask(legacy).brief, "legacy task");
});

test("an absolute workspace path quoted inside a brief is still stripped", () => {
  const base = "/Users/bob/secret/project";
  const p = projectTask(baseTask({ brief: "Refactor " + base + "/src/a.ts please." }), base);
  assert.equal(p.brief.includes(base), false, "the Mac's absolute layout must never leave it");
  assert.match(p.brief, /Refactor …\/src\/a\.ts please\./);
});
