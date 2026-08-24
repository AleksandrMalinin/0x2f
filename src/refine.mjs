// Task prompt refinement — a narrow, pure text transform.
//
// Users often have the INTENT for a task but only a rough note in the
// composer. REFINE turns that note into a stronger execution brief without
// leaving 0x2F, so the user can review/edit it and press START.
//
// This module is deliberately NOT part of Work Core or the Task lifecycle:
// refinement never creates a task, never starts an execution, and never
// persists anything. The persisted artifact stays the final prompt the user
// submits with START (POST /api/tasks).
//
// Contract: refineTaskPrompt(rawText) -> refinedText (the one function the
// API layer needs), kept independent from Task execution so the model path
// can change later without touching the lifecycle.
//
// Model path: the refinement service reuses the SAME native provider CLIs the
// execution providers run, in their narrowest text-only mode — no harness
// run, no events, no session. Which model runs inside is the provider's own
// concern (exactly as for task execution); this service only chooses the
// PATH, deterministically, by executable availability:
//
//   claude-code       `claude -p --output-format text --disallowedTools=…`
//                     print mode with every tool denied — the closest thing
//                     in this codebase to a plain chat call.
//   deepseek-harness  `dsh --profile headless "<task>"` — the SAME one-shot
//                     invocation the execution provider uses, pointed at an
//                     empty temp cwd so the model has no repository to reach
//                     into (DSH headless keeps tools enabled; the instruction
//                     forbids their use).
//
// Only native providers qualify: configured (ACP/command) harnesses have no
// text-only mode this service can rely on.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkError } from "./core/errors.mjs";
import { claudeBin } from "./providers/claude-code.mjs";
import { dshBin } from "./providers/deepseek-harness.mjs";

// The exact instruction sent to the model. Every refinement shares it; only
// the user's raw note is interpolated. It is deliberately explicit about the
// boundaries: preserve intent and constraints, never invent requirements,
// keep it short, structure only where helpful, and return ONLY the task text.
export const REFINE_RULES = `You are turning a rough task note into a clear, actionable engineering brief.

The note was written quickly, in the composer of a local task tracker. The
brief replaces the note as the task an autonomous coding/research agent
receives next. Nothing is executed here — rewrite the text only.

THE USER'S ROUGH NOTE

"""
{raw}
"""

RULES

- Preserve the user's intent and every explicit constraint exactly.
- Make vague input clearer and more actionable. Where the meaning is
  ambiguous, state the most reasonable reading plainly — but never invent
  requirements, scope, deliverables, or constraints the user did not express.
- Structure the brief only where it helps: a one-line statement of the task,
  then short sections (for example Goals, Constraints, Deliverable) when they
  clarify it. A simple task stays a simple paragraph.
- Keep it concise: no filler, no rationale, no boilerplate.
- Write it for the agent that receives it next: what to do, what to respect,
  and what to deliver — with no project context beyond this brief.
- Do not ask the user clarifying questions.

REPLY

Reply with only the refined task text. No intro, no "Refined task:" heading,
no commentary, and no explanation of what you changed.`;

export function buildRefineInstruction(rawText) {
  return REFINE_RULES.replace("{raw}", rawText);
}

// A rough note beyond this length is not a rough note; refuse before any
// model call so a paste cannot turn REFINE into an expensive model run.
export const MAX_RAW_LENGTH = 4000;

// Claude Code print mode with every tool denied. The `=` form binds the whole
// list to the flag: a bare `--disallowedTools <tools…>` is variadic and would
// swallow the prompt positional. Verified against Claude Code 2.x print mode.
const CLAUDE_DISALLOWED_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch";

// The refinement model paths, in preference order. Narrowest first: Claude
// Code's print mode hard-denies tools (a pure text call); DeepSeek Harness's
// headless one-shot cannot disable tools, so it runs in an empty temp cwd and
// relies on the instruction.
const REFINEMENT_PATHS = {
  "claude-code": {
    bin: () => claudeBin(),
    args: instruction => [
      "-p",
      "--output-format",
      "text",
      "--disallowedTools=" + CLAUDE_DISALLOWED_TOOLS,
      instruction
    ]
  },
  "deepseek-harness": {
    bin: () => dshBin(),
    args: instruction => ["--profile", "headless", instruction]
  }
};
const REFINEMENT_ORDER = ["claude-code", "deepseek-harness"];

// Pick the first refinement path whose executable can be resolved. Uses the
// provider registry's availability check (never spawns), so a fake bin via
// CLAUDE_BIN / DSH_BIN participates exactly like it does for execution.
export function pickRefinementPath(providers) {
  for (const id of REFINEMENT_ORDER) {
    try {
      if (providers?.available?.(id) === true) {
        return { id, ...REFINEMENT_PATHS[id] };
      }
    } catch {
      // treat an unreadable availability check as unavailable
    }
  }
  return null;
}

// Spawn one model CLI, capture stdout, and resolve with the raw text. The
// timeout is the failure boundary REFINE's button state depends on: without
// it a hung model would leave the composer stuck in REFINING forever.
function spawnModel(bin, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new WorkError(`Could not start the refinement model: ${error.message}`, 502));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      settle(reject, new WorkError("Refinement timed out — try again.", 504));
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      settle(reject, new WorkError(`Could not start the refinement model: ${error.message}`, 502));
    });
    child.on("close", code => {
      if (code === 0) {
        settle(resolve, stdout);
      } else {
        settle(
          reject,
          new WorkError(
            stderr.trim() || `The refinement model exited with code ${code}.`,
            502
          )
        );
      }
    });
  });
}

// The model's reply -> the brief that replaces the composer text. Trim, and
// unwrap a single code fence if the model wrapped the reply despite the
// instruction — a fence is never task text.
export function cleanRefinedText(text) {
  let out = typeof text === "string" ? text.trim() : "";
  const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (fenced) out = fenced[1].trim();
  return out;
}

// createRefiner({ providers, timeoutMs }) -> { refineTaskPrompt(rawText) }
//
// `providers` is the workspace provider registry (used only for availability
// checks). The service is stateless: each call picks the path, runs the
// model, and returns the refined text — nothing is persisted or emitted.
export function createRefiner({ providers, timeoutMs = 120000 } = {}) {
  async function refineTaskPrompt(rawText) {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) {
      // Fail gracefully and leave the user's text untouched: the caller never
      // replaces its composer content on error, so a blank note is a no-op.
      throw new WorkError("There is nothing to refine — write your task first.");
    }
    if (text.length > MAX_RAW_LENGTH) {
      throw new WorkError(
        `The note is too long to refine (${text.length} characters; the limit is ${MAX_RAW_LENGTH}). Shorten it, or press START to run it as-is.`
      );
    }

    const refinement = pickRefinementPath(providers);
    if (!refinement) {
      throw new WorkError(
        "No model is available to refine — install Claude Code or DeepSeek Harness, then retry.",
        503
      );
    }

    const instruction = buildRefineInstruction(text);
    // An empty temp cwd keeps the model's working directory away from the
    // repository: refinement must never read or modify project files.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "0x2f-refine-"));
    try {
      const stdout = await spawnModel(refinement.bin(), refinement.args(instruction), {
        cwd: tmp,
        timeoutMs
      });
      const refined = cleanRefinedText(stdout);
      if (!refined) {
        throw new WorkError("The model returned an empty refinement — try again.", 502);
      }
      return refined;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { refineTaskPrompt };
}
