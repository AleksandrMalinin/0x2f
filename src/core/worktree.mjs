// Repository-observed file changes — the honest counterpart to
// provider-REPORTED file.changed events.
//
// A provider that declares supportsFileChanges (Claude Code) reports what it
// edited, as normalized file.changed events. A provider that does not (Codex
// exec, DeepSeek Harness headless) still leaves its work in the working tree.
// 0x2F never fakes a provider capability; instead the WORKER observes the
// repository around a run: a snapshot of `git status` taken before the run
// starts, diffed against the tree when the run ends. Files the run
// introduced or changed are recorded as file.changed events with
// `source: "worktree"`, so every surface can show "N files changed" without
// pretending the provider reported them.
//
// This is best-effort observation, never a diff-correct claim:
//   - it sees what `git status` sees (tracked + untracked files);
//   - a file already modified before the run and further modified during it
//     is not re-reported (same path, same status code);
//   - a file created and deleted within the run appears in neither snapshot;
//   - a non-git workspace has no baseline at all (nothing is observed).

import { execFile } from "node:child_process";

function run(args, cwd) {
  return new Promise(resolve => {
    execFile(
      "git",
      args,
      { cwd, timeout: 8000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        });
      }
    );
  });
}

// Parse `git status --porcelain` lines into { code, path } entries. Renames
// and copies print "R  old -> new" — the destination is the path that now
// exists in the tree.
export function parsePorcelain(output) {
  const out = [];
  for (const line of String(output ?? "").split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    if (code[0] === "R" || code[0] === "C") {
      const arrow = rest.indexOf(" -> ");
      if (arrow >= 0) rest = rest.slice(arrow + 4);
    }
    out.push({ code, path: rest });
  }
  return out;
}

// A snapshot of the working tree's git-visible state: path -> status code.
// Returns null when git is unavailable or the directory is not a repository
// (no baseline to diff against — observation is impossible, honestly).
export async function snapshotWorktree(base) {
  const r = await run(["status", "--porcelain"], base);
  if (r.code !== 0) return null;
  return new Map(parsePorcelain(r.stdout).map(e => [e.path, e.code]));
}

// The paths whose git-visible state changed between `before` and the current
// tree: introduced during the run, or with a different status code than at
// run start. Returns null when there is no baseline (non-git workspace).
export async function changedSince(base, before) {
  if (!before) return null;
  const after = await snapshotWorktree(base);
  if (!after) return null;
  const out = [];
  for (const [path, code] of after) {
    if (!before.has(path) || before.get(path) !== code) out.push(path);
  }
  return out;
}
