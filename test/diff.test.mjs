// The shared diff layer — REAL per-file hunks from the working tree, the
// source the TUI's `d` (CHANGES) view draws. A tracked file diffs against
// HEAD; an untracked file has no baseline, so the whole file reads as
// additions; a workspace with no git repository has no baseline at all, and
// files are reported without hunks. Nothing is fabricated.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { taskDiff } from "../src/core/diff.mjs";

function git(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
    );
  });
}

// A real git repository with one committed file, one modified file and one
// untracked file — the shapes taskDiff must distinguish.
async function makeGitRepo() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-diff-"));
  await git(["init", "-q"], base);
  await git(["config", "user.email", "test@0x2f.dev"], base);
  await git(["config", "user.name", "0x2F test"], base);
  await fs.writeFile(path.join(base, "tracked.ts"), "const a = 1;\n");
  await git(["add", "."], base);
  await git(["commit", "-qm", "init"], base);
  // Now: tracked.ts is modified, untracked.ts is new.
  await fs.writeFile(path.join(base, "tracked.ts"), "const a = 2;\nconst b = 3;\n");
  await fs.writeFile(path.join(base, "untracked.ts"), "export const fresh = true;\n");
  return base;
}

test("taskDiff returns real hunks for a tracked, modified file", async () => {
  const base = await makeGitRepo();
  try {
    const out = await taskDiff({ base, files: [path.join(base, "tracked.ts")] });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "hunks");
    assert.equal(out[0].path, "tracked.ts");
    assert.match(out[0].hunks, /^-const a = 1;$/m, "the removed line");
    assert.match(out[0].hunks, /^\+const a = 2;$/m, "the added line");
    assert.match(out[0].hunks, /^@@/m, "a hunk header");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("taskDiff reads an untracked file as a whole-file addition", async () => {
  const base = await makeGitRepo();
  try {
    const out = await taskDiff({ base, files: [path.join(base, "untracked.ts")] });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "hunks");
    assert.equal(out[0].path, "untracked.ts");
    assert.match(out[0].hunks, /new file mode/m);
    assert.match(out[0].hunks, /^\+export const fresh = true;$/m, "every line is an addition");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("taskDiff reports a file without hunks when the workspace is not a git repository", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-diff-nogit-"));
  try {
    await fs.writeFile(path.join(base, "plain.txt"), "hello\n");
    const out = await taskDiff({ base, files: [path.join(base, "plain.txt")] });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "reported");
    assert.equal(out[0].hunks, null);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("taskDiff dedupes repeated reports and keeps report order", async () => {
  const base = await makeGitRepo();
  try {
    const out = await taskDiff({
      base,
      files: [
        path.join(base, "untracked.ts"),
        path.join(base, "untracked.ts"),
        path.join(base, "tracked.ts")
      ]
    });
    assert.deepEqual(out.map(f => f.path), ["untracked.ts", "tracked.ts"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("taskDiff reports a file outside the workspace without hunks — never diffs elsewhere", async () => {
  const base = await makeGitRepo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "work-diff-out-"));
  try {
    const out = await taskDiff({ base, files: [path.join(outside, "elsewhere.txt")] });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "reported");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("taskDiff shows a tracked deletion when the reported file is gone", async () => {
  const base = await makeGitRepo();
  try {
    await fs.rm(path.join(base, "tracked.ts"));
    const out = await taskDiff({ base, files: [path.join(base, "tracked.ts")] });
    assert.equal(out[0].kind, "hunks");
    assert.match(out[0].hunks, /^-const a = 1;$/m, "the deletion still diffs");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
