// DeepSeek Harness execution provider — the boundary where DSH-specific
// behavior stops.
//
// DeepSeek Harness is treated as an execution provider / harness, NOT as a
// model: which model runs inside is DSH's own concern (its `agent-default-model`
// settings, `$DSH_HOME/settings.yaml`), and 0x2F never overrides it.
//
// This file is the ONLY place DSH shapes may appear. Everything it produces
// is normalized to Work concepts (core/lifecycle.mjs outcomes + core/events.mjs
// events). DSH is developer preview and may change; all compatibility-sensitive
// code is isolated here.
//
// # Invocation (verified against dsh 0.1.1-rc.2 source)
//
//   dsh --profile headless "<prompt>"
//
// The headless profile is a one-shot direct Agent driver:
//   - it creates ONE fresh persisted session (`session-<uuid>`) — the id is
//     generated inside DSH and never surfaced on stdout;
//   - it submits the task as an ordinary user message and waits for quiescence;
//   - on completion it prints the LAST non-empty assistant text to stdout;
//   - exit code 0 means the final turn/end reason was `completed`; any other
//     outcome (error) exits 1 and writes `dsh: <code>: <message>` to stderr;
//   - a terminal error reason also writes its code and message to stderr;
//     successful runs keep stderr empty.
//
// The headless profile exposes NO structured event stream on stdout (only the
// final text) and NO --resume flag (each run is a fresh session), and it runs
// tools without a human-in-the-loop approval prompt. Those are real capability
// differences vs Claude Code — they are DECLARED in `capabilities` below, not
// faked. The provider emits only what it can reliably derive:
//
//   DSH headless CLI                      ->  normalized Work event/outcome
//   ------------------------------------      ---------------------------------
//   process spawns                        ->  run.started (sessionId null)
//   final stdout text (exit 0)            ->  run.completed (via worker) + ready
//   `## Needs human decision` section     ->  needs_you / decision (shared prompt
//                                              convention, parsed in core)
//   exit 1 / stderr error                 ->  run.failed (via worker) + failed
//   permission prompts                    ->  never emitted (headless has none)
//   progress / tool.started / file.changed -> not derivable from the CLI output
//
// Binary: `dsh` on PATH, override with DSH_BIN (tests, non-PATH installs).

import { spawn } from "node:child_process";
import { classifyResult } from "../core/lifecycle.mjs";

// Injectable for tests and non-PATH installs; defaults to `dsh` on PATH.
export function dshBin() {
  return process.env.DSH_BIN ?? "dsh";
}

export const deepseekHarnessProvider = {
  id: "deepseek-harness",
  displayName: "DeepSeek Harness",
  capabilities: {
    // Honest declaration: the headless profile cannot resume a session,
    // emits no structured event stream, and has no approval prompts.
    supportsResume: false,
    supportsStructuredEvents: false,
    supportsFileChanges: false,
    supportsCommands: false,
    supportsPermissionRequests: false,
    supportsSandbox: false,
    supportsStreaming: false,
    // The only signal this profile gives is the final stdout text, printed
    // once the run has fully quiesced — there is nothing to show before that.
    resultOnCompletion: true
  },

  async start({ cwd, prompt, onEvent = () => {} }) {
    return runDsh({ cwd, prompt, onEvent });
  }

  // resume() is deliberately absent: supportsResume is false, and the worker
  // + actions refuse to resume a task whose provider cannot continue a
  // session. A `needs_you` task from this provider (decision blocks only —
  // DSH never emits permission blocks) can be inspected and closed, but not
  // continued in place.
};

// ---------------------------------------------------------------------------
// Run + normalization
// ---------------------------------------------------------------------------

function runDsh({ cwd, prompt, onEvent }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(dshBin(), ["--profile", "headless", prompt], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        status: "failed",
        error: `Could not start dsh: ${error.message}`
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = outcome => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    // We cannot know DSH's session id (generated internally per run), so
    // run.started carries no session id — honestly.
    onEvent({ type: "run.started", sessionId: null });

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      settle({
        status: "failed",
        error: `Could not start dsh. Is the DeepSeek Harness CLI installed and configured (dsh --profile headless)? ${error.message}`
      });
    });

    child.on("close", code => {
      settle(normalizeDshRun({ code: code ?? 1, stdout, stderr }));
    });
  });
}

// The DSH process outcome -> normalized Work outcome. Pure and testable.
export function normalizeDshRun({ code, stdout = "", stderr = "" }) {
  const text = typeof stdout === "string" ? stdout : "";

  if (code === 0) {
    // Exit 0 means the final turn completed. The shared prompt asks agents to
    // end with `## Needs human decision`; the shared classifier also turns an
    // explicit blocker report into a failed run instead of a false READY.
    const classified = classifyResult(text);
    if (classified.status === "needs_you") {
      return {
        status: "needs_you",
        reason: "decision",
        result: text,
        blockedOn: classified.blockedOn
      };
    }
    if (classified.status === "failed") {
      return { status: "failed", error: classified.error, failure: classified.failure };
    }
    return { status: "ready", result: text };
  }

  return {
    status: "failed",
    error:
      (typeof stderr === "string" && stderr.trim()) ||
      `dsh exited with code ${code} before completing the task.`
  };
}
