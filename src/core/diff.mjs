// Real per-file diffs for a run's changed files — the shared-layer source
// for the `d` (CHANGES) surface.
//
// The working tree IS the run's output (0x2F never stages or commits), so a
// real diff exists wherever git has a baseline: the actual difference
// between the tree and the last commit, per file, computed at read time —
// never provider prose, never fabricated.
//
//   tracked file    git diff HEAD -- <file>        the real diff vs the
//                                                  last commit
//   untracked file  git diff --no-index /dev/null  the whole file as
//                                                  additions (no baseline)
//   no git / no base for the file                  the file is reported
//                                                  without hunks, and the
//                                                  surface says no diff
//                                                  could be computed
//
// The result shape is provider-neutral: one entry per reported file, with
// either a `hunks` string (raw unified-diff output) or `kind: "reported"`.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

// Run one git command without ever treating a non-zero exit as an error —
// git diff exits 1 when a diff exists (--no-index always does). Returns
// { code, stdout, stderr }.
function run(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 8000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      });
    });
  });
}

function isUntracked(base, rel) {
  return run(["ls-files", "--error-unmatch", "--", rel], base).then(
    r => r.code !== 0
  );
}

// The absolute path of one reported file. A provider reports paths in its
// own vocabulary (absolute or relative); only a file that actually lives in
// this workspace has a baseline worth diffing — anything else is reported
// without hunks.
function resolveReported(base, file) {
  const p = String(file ?? "");
  if (!p) return null;
  if (path.isAbsolute(p)) {
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return p.startsWith(prefix) ? p : null;
  }
  return path.resolve(base, p);
}

// One reported file -> { path, kind: "hunks"|"reported", hunks? }.
async function diffFile(base, file) {
  const abs = resolveReported(base, file);
  const rel = path.relative(base, abs ?? base);
  if (!abs) {
    return { path: file, kind: "reported", hunks: null };
  }
  try {
    await fs.access(abs);
  } catch {
    // The file is gone from the working tree. If it is tracked, git diff
    // still has the deletion; if it never existed, there is nothing to diff.
    const untracked = await isUntracked(base, rel);
    if (!untracked) {
      const r = await run(["diff", "HEAD", "--", rel], base);
      return { path: rel, kind: "hunks", hunks: r.stdout || null };
    }
    return { path: rel, kind: "reported", hunks: null };
  }

  const tracked = await run(["diff", "HEAD", "--", rel], base);
  if (tracked.code !== 0) {
    // Not a git repository (or HEAD does not exist) — no baseline at all.
    return { path: rel, kind: "reported", hunks: null };
  }
  if (tracked.stdout.trim()) {
    return { path: rel, kind: "hunks", hunks: tracked.stdout };
  }
  // Tracked but unchanged (the run reported it, the working tree does not
  // differ from HEAD) — or untracked. The untracked case is a whole-file
  // addition: /dev/null as the baseline, so every line reads as new.
  const untracked = await isUntracked(base, rel);
  if (!untracked) return { path: rel, kind: "reported", hunks: null };
  const added = await run(["diff", "--no-index", "/dev/null", "--", abs], base);
  if (added.code === 128) return { path: rel, kind: "reported", hunks: null };
  return { path: rel, kind: "hunks", hunks: added.stdout || null };
}

// The full change set for one run's reported files: one entry per file, in
// the order they were reported, deduped. `base` is the workspace root.
export async function taskDiff({ base, files = [] }) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const key = String(file ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(await diffFile(base, key));
  }
  return out;
}
