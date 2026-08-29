// Canonical path normalization (src/core/paths.mjs) — the shared rule that
// makes "src/foo.mjs", "./src/foo.mjs" and "src/./foo.mjs" the SAME logical
// file in any aggregate changed-file list (desktop, TUI, phone).

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPath } from "../src/core/paths.mjs";

test("canonicalPath: leading ./ and interior . segments collapse", () => {
  assert.equal(canonicalPath("src/foo.mjs"), "src/foo.mjs");
  assert.equal(canonicalPath("./src/foo.mjs"), "src/foo.mjs");
  assert.equal(canonicalPath("src/./foo.mjs"), "src/foo.mjs");
  assert.equal(canonicalPath(".//src//foo.mjs"), "src/foo.mjs");
});

test("canonicalPath: the three spellings of one file are identical", () => {
  const a = canonicalPath("src/foo.mjs");
  const b = canonicalPath("./src/foo.mjs");
  const c = canonicalPath("src/./foo.mjs");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("canonicalPath: resolves .. lexically but never escapes the repository root", () => {
  assert.equal(canonicalPath("src/a/../foo.mjs"), "src/foo.mjs");
  assert.equal(canonicalPath("../outside.mjs"), "../outside.mjs");
  assert.equal(canonicalPath("a/../../b.mjs"), "../b.mjs");
});

test("canonicalPath: empty and root-like inputs are stable", () => {
  assert.equal(canonicalPath(""), "");
  assert.equal(canonicalPath("./"), "");
  assert.equal(canonicalPath("a/"), "a");
});
