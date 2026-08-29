// Codex execution provider — the boundary where Codex-specific behavior
// stops.
//
// Work talks to an ExecutionProvider, never to a specific agent CLI directly.
// The provider translates Codex's process output into the normalized outcome
// shapes in ../core/lifecycle.mjs:
//
//   { status: "ready",    result }
//   { status: "needs_you", reason, blockedOn, result? }
//   { status: "failed",   error, failure? }
//
// Everything Codex-shaped lives in THIS file; nothing outside it may depend
// on Codex vocabulary.
//
// # Invocation (verified against codex-cli 0.149.1, 2026-08)
//
//   codex exec --json --skip-git-repo-check [-s <sandbox>] "<prompt>"
//   codex exec resume <thread-id> --json --skip-git-repo-check "<prompt>"
//
// `--json` prints a newline-delimited JSONL event stream on stdout:
//
//   thread.started        { thread_id }                 -> the session id
//   turn.started
//   item.started/completed { item: { type: command_execution | agent_message
//                                     | reasoning | mcp_tool_call | ... } }
//   turn.completed         { usage }
//   turn.failed            { error.message }            -> exit 1
//   error                  { message }                  -> transient (reconnects)
//
// Verified capability boundaries (see docs/codex-capability-map.md):
//
//   - file_change items are documented but NEVER emitted by exec in any
//     tested configuration (apply_patch is rejected in exec mode; shell
//     apply_patch reports only command_execution with the path inside output
//     text). supportsFileChanges is therefore false, and this adapter never
//     fabricates a file.changed event from command text.
//   - exec has NO human-in-the-loop permission surface: the default approval
//     policy is Never (escalations are rejected), `--ask-for-approval` is not
//     an exec flag, `request_user_input` is Default-mode-unavailable, and
//     `codex queue` targets the app-server daemon, not transient exec runs.
//     supportsPermissionRequests is therefore false: a needs_you from Codex
//     can only be a decision (the shared `## Needs human decision` protocol).
//   - resume continues the SAME thread with prior context
//     (`codex exec resume <thread-id>`), so supportsResume is true.
//   - auth presence is detectable (`codex login status`) but auth VALIDITY
//     only surfaces at exec time as turn.failed with a 401/refresh message —
//     classified here, once, from Codex's own failure text.

import { spawn } from "node:child_process";
import { classifyResult } from "../core/lifecycle.mjs";

// Injectable for tests and non-PATH installs; defaults to `codex` on PATH.
export function codexBin() {
  return process.env.CODEX_BIN ?? "codex";
}

// Sandbox selection for exec. workspace-write is the standard headless mode:
// the agent can edit the workspace and run commands inside it without
// approval prompts (approval policy is Never), which is what a coding task
// needs. In sandboxed/CI environments where the seatbelt sandbox cannot
// apply, set CODEX_SANDBOX=bypass (--dangerously-bypass-approvals-and-sandbox)
// — a deployment decision, never a silent provider choice.
export function codexSandboxArgs() {
  switch (process.env.CODEX_SANDBOX ?? "workspace-write") {
    case "read-only":
      return ["-s", "read-only"];
    case "danger-full-access":
      return ["-s", "danger-full-access"];
    case "bypass":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "workspace-write":
    default:
      return ["-s", "workspace-write"];
  }
}

// The user-facing recovery step for a classified auth failure, shown verbatim
// by the UI. Codex auth is either ChatGPT (`codex login`) or an API key
// (`codex login --with-api-key`); "codex login" is the single honest prompt
// for both — it is the command a person would run outside 0x2F.
export function classifyCodexFailure(text) {
  if (
    /\b401\b|unauthenticated|not authenticated|not logged in|refresh token|could not be refreshed|invalid api key|missing bearer|authentication_error|unauthorized|could not parse your authentication token|please log out and sign in|please log in|sign in again/i.test(
      String(text ?? "")
    )
  ) {
    return { kind: "auth", remedy: "codex login" };
  }
  return null;
}

const RESUME_PROMPTS = {
  allow:
    "The user reviewed your last message and granted the requested permission.\n" +
    "Continue the task and complete the remaining work.\n\n" +
    "When you finish, return the same markdown sections as the original task:\n" +
    "## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision\n" +
    "(## Needs human decision uses the REQUIRED: yes / REQUIRED: no protocol.)",
  reject:
    "The user reviewed your last message and rejected the requested change.\n" +
    "Do not attempt it again. Complete whatever part of the task you can\n" +
    "responsibly finish without it, or explain what remains blocked.\n\n" +
    "When you finish, return the same markdown sections as the original task:\n" +
    "## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision\n" +
    "(## Needs human decision uses the REQUIRED: yes / REQUIRED: no protocol.)",
  continue:
    "Continue the task from where you left off.\n\n" +
    "When you finish, return the same markdown sections as the original task:\n" +
    "## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision\n" +
    "(## Needs human decision uses the REQUIRED: yes / REQUIRED: no protocol.)"
};

export const codexProvider = {
  id: "codex",
  displayName: "Codex",
  capabilities: {
    // Honest declaration, verified against codex-cli 0.149.1: resume
    // continues the same thread with prior context; exec reports structured
    // events and commands; but it never emits file_change items and has no
    // human-in-the-loop permission surface (see header comment + the
    // capability map document).
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsFileChanges: false,
    supportsCommands: true,
    supportsPermissionRequests: false,
    supportsSandbox: false,
    supportsStreaming: true,
    // agent_message items stream the result text as it is produced; the
    // written result is final at turn.completed.
    resultOnCompletion: false
  },

  async start({ cwd, prompt, model, onEvent = () => {} }) {
    const args = ["exec", "--json", "--skip-git-repo-check", ...codexSandboxArgs()];
    if (model) args.push("-m", model);
    args.push(prompt);
    return runCodex({ cwd, args, onEvent });
  },

  async resume({ cwd, externalSessionId, grant = "continue", model, onEvent = () => {} }) {
    if (!externalSessionId) {
      throw new Error("No external session id — this task cannot be resumed.");
    }
    const prompt = RESUME_PROMPTS[grant] ?? RESUME_PROMPTS.continue;
    const args = ["exec", "resume", externalSessionId, "--json", "--skip-git-repo-check", ...codexSandboxArgs()];
    if (model) args.push("-m", model);
    args.push(prompt);
    return runCodex({ cwd, args, onEvent });
  }
};

// ---------------------------------------------------------------------------
// Run + JSONL event parsing
// ---------------------------------------------------------------------------

// The per-run parser state shared between the live stream and the pure
// parser. `consumeCodexLine` feeds one JSON line; `runCodex` feeds live
// chunks, and tests feed fixture text — the exact same code path.
export function createCodexParser(onEvent = () => {}) {
  return {
    threadId: null,
    lastAgentText: "",
    turnCompleted: false,
    turnFailed: null, // { message }
    sawEvent: false,
    onEvent
  };
}

export function consumeCodexLine(state, line) {
  if (!line.trim()) return state;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return state; // not JSON — ignore stray output
  }
  state.sawEvent = true;
  const { onEvent } = state;

  switch (event.type) {
    case "thread.started":
      state.threadId = event.thread_id ?? null;
      onEvent({ type: "run.started", sessionId: state.threadId });
      break;
    case "item.started":
    case "item.updated":
    case "item.completed":
      consumeCodexItem(state, event.type, event.item ?? {});
      break;
    case "turn.completed":
      state.turnCompleted = true;
      break;
    case "turn.failed":
      state.turnFailed = { message: event.error?.message ?? "codex reported a failed turn." };
      break;
    case "error":
      // Transient reconnect notices ("Reconnecting... 1/5") — non-fatal
      // progress, deliberately not recorded as task progress.
      break;
  }
  return state;
}

function consumeCodexItem(state, kind, item) {
  const { onEvent } = state;
  switch (item.type) {
    case "command_execution": {
      const command = typeof item.command === "string" ? item.command : "";
      if (kind === "item.started") {
        onEvent({ type: "tool.started", name: "command_execution", input: { command } });
      } else if (kind === "item.completed") {
        onEvent({
          type: "tool.completed",
          isError: item.exit_code !== 0 && item.exit_code !== null && item.exit_code !== undefined
        });
      }
      break;
    }
    case "agent_message":
      // agent_message is emitted completed with the full text; track the
      // last one as the run's result, and surface it as progress.
      if (kind === "item.completed" && typeof item.text === "string") {
        state.lastAgentText = item.text;
        onEvent({ type: "progress", text: item.text });
      }
      break;
    case "reasoning":
      // Reasoning summaries are the agent's visible thinking, not the
      // result; surface briefly as progress when present.
      if (kind === "item.completed" && typeof item.text === "string" && item.text) {
        onEvent({ type: "progress", text: item.text });
      }
      break;
    case "mcp_tool_call": {
      if (kind === "item.started") {
        onEvent({
          type: "tool.started",
          name: item.tool ?? "mcp_tool_call",
          input: {
            ...(typeof item.server === "string" ? { server: item.server } : {}),
            ...(item.arguments !== null && item.arguments !== undefined ? { arguments: item.arguments } : {})
          }
        });
      } else if (kind === "item.completed") {
        onEvent({ type: "tool.completed", isError: item.status === "failed" });
      }
      break;
    }
    // todo_list / web_search / error items: no reliable Work mapping —
    // ignore rather than fabricate.
  }
}

function runCodex({ cwd, args, onEvent }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(codexBin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        status: "failed",
        error: `Could not start codex: ${error.message}`
      });
      return;
    }

    let buffer = "";
    let stderr = "";
    const state = createCodexParser(onEvent);

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        consumeCodexLine(state, line);
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      resolve({
        status: "failed",
        error: `Could not start codex. Is the Codex CLI installed and on PATH? ${error.message}`
      });
    });

    child.on("close", code => {
      if (state.turnFailed) {
        const failure = classifyCodexFailure(state.turnFailed.message);
        resolve({
          status: "failed",
          externalSessionId: state.threadId,
          error: state.turnFailed.message,
          ...(failure ? { failure } : {})
        });
      } else if (state.turnCompleted) {
        resolve(normalizeCodexRun({ text: state.lastAgentText, threadId: state.threadId }));
      } else if (code !== 0) {
        const error =
          stderr.trim() ||
          `codex exited with code ${code} before completing the run.`;
        const failure = classifyCodexFailure(error);
        resolve({
          status: "failed",
          externalSessionId: state.threadId,
          error,
          ...(failure ? { failure } : {})
        });
      } else {
        resolve({
          status: "failed",
          externalSessionId: state.threadId,
          error: state.sawEvent
            ? "codex exited without completing a turn."
            : "codex produced no output. Is the Codex CLI installed and authenticated?"
        });
      }
    });
  });
}

// The JSONL event stream -> normalized Work outcome. Pure and testable.
export function normalizeCodexRun({ text = "", threadId = null, error = null } = {}) {
  if (error) {
    const failure = classifyCodexFailure(error);
    return {
      status: "failed",
      ...(threadId ? { externalSessionId: threadId } : {}),
      error,
      ...(failure ? { failure } : {})
    };
  }

  // The shared prompt asks the agent to end with `## Needs human decision`;
  // honor that Work convention exactly like the other providers do. The same
  // shared classifier also turns an explicit blocker report ("could not
  // continue because …") into a failed run instead of a false READY.
  const classified = classifyResult(text);
  if (classified.status === "needs_you") {
    return {
      status: "needs_you",
      reason: "decision",
      ...(threadId ? { externalSessionId: threadId } : {}),
      result: text,
      blockedOn: classified.blockedOn
    };
  }
  if (classified.status === "failed") {
    return {
      status: "failed",
      ...(threadId ? { externalSessionId: threadId } : {}),
      error: classified.error,
      failure: classified.failure
    };
  }
  return {
    status: "ready",
    ...(threadId ? { externalSessionId: threadId } : {}),
    result: text
  };
}
