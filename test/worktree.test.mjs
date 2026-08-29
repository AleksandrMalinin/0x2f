// Repository-observed file changes — the worker's honest counterpart to
// provider-reported file.changed events (src/core/worktree.mjs).
//
// These tests exercise the git observation primitives against a real
// (throwaway) repository: a provider that does not declare file-change
// reporting still leaves its work in the working tree, and 0x2F observes it
// rather than faking a provider capability.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parsePorcelain, snapshotWorktree, changedSince } from "../src/core/worktree.mjs";

function run(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function gitRepo(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-worktree-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await run(["init"], base);
  await fs.writeFile(path.join(base, ".gitignore"), ".work/\n");
  await fs.writeFile(path.join(base, "existing.txt"), "before\n");
  await run(["add", "."], base);
  await run(["commit", "-m", "initial"], base);
  return base;
}

test("parsePorcelain: status lines become { code, path }, renames take the destination", () => {
  const entries = parsePorcelain(" M src/a.ts\n?? new-file.txt\nR  old.txt -> new.txt\n");
  assert.deepEqual(entries, [
    { code: " M", path: "src/a.ts" },
    { code: "??", path: "new-file.txt" },
    { code: "R ", path: "new.txt" }
  ]);
});

test("snapshotWorktree returns null when the directory is not a git repository", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-worktree-nogit-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.equal(await snapshotWorktree(base), null);
});

test("changedSince reports files introduced or altered during the run", async t => {
  const base = await gitRepo(t);
  const before = await snapshotWorktree(base);
  assert.deepEqual([...before.keys()], []); // clean tree

  await fs.writeFile(path.join(base, "new-file.txt"), "made during the run\n");
  await fs.appendFile(path.join(base, "existing.txt"), "edited during the run\n");

  const changed = await changedSince(base, before);
  assert.deepEqual(changed.sort(), ["existing.txt", "new-file.txt"]);
});

test("a file already dirty before the run is not re-reported when it stays dirty", async t => {
  const base = await gitRepo(t);
  await fs.appendFile(path.join(base, "existing.txt"), "dirty before the run\n");
  const before = await snapshotWorktree(base);
  assert.deepEqual([...before.keys()], ["existing.txt"]);

  // Further edits during the run keep the same status code (" M") — the
  // observation cannot tell "was dirty" from "changed again", and stays
  // silent rather than over-claim.
  await fs.appendFile(path.join(base, "existing.txt"), "still dirty\n");
  const changed = await changedSince(base, before);
  assert.deepEqual(changed, []);
});

test("gitignored paths are invisible to the observation (0x2F's own .work never counts)", async t => {
  const base = await gitRepo(t);
  const before = await snapshotWorktree(base);
  await fs.mkdir(path.join(base, ".work", "tasks"), { recursive: true });
  await fs.writeFile(path.join(base, ".work", "tasks", "result.md"), "bookkeeping\n");
  const changed = await changedSince(base, before);
  assert.deepEqual(changed, []);
});

test("changedSince returns null without a baseline (non-git workspace)", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-worktree-nobase-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  assert.equal(await changedSince(base, null), null);
});
