// Gemini CLI execution provider — the boundary where Gemini-specific
// behavior stops.
//
// Work talks to an ExecutionProvider, never to a specific agent CLI directly.
// The provider translates Gemini CLI's process output into the normalized
// outcome shapes in ../core/lifecycle.mjs:
//
//   { status: "ready",    result }
//   { status: "needs_you", reason, blockedOn, result? }
//   { status: "failed",   error, failure? }
//
// Everything Gemini-shaped lives in THIS file; nothing outside it may depend
// on Gemini vocabulary. See docs/gemini-capability-map.md for the empirically
// verified boundaries (Gemini CLI 0.57.0, installed + smoke-tested 2026-08).
//
// # Invocation (verified against gemini 0.57.0)
//
//   gemini -p "<prompt>" --skip-trust -o stream-json [--approval-mode auto_edit]
//   gemini -p "<prompt>" --skip-trust -o stream-json --resume <session-uuid>
//
// `-p` is non-interactive (headless) mode; `-o stream-json` prints a
// newline-delimited JSONL event stream on stdout:
//
//   init         { session_id, model }                    -> the session id
//   message      { role: user|assistant, content, delta } -> assistant text
//                                                           streams as deltas;
//                                                           the run result is
//                                                           their concatenation
//   tool_use     { tool_name, tool_id, parameters }       -> tool started
//   tool_result  { tool_id, status: success|error, ... }  -> tool completed
//   error        { severity, message }                    -> non-fatal warnings
//   result       { status: success|error, error?, stats } -> TERMINAL event
//
// Verified capability boundaries (docs/gemini-capability-map.md):
//
//   - `--skip-trust` is required in untrusted workspaces (headless otherwise
//     fails with FatalUntrustedWorkspaceError); it makes the folder trusted.
//   - Native headless mode has NO human-in-the-loop permission surface: the
//     policy engine's headless default decision is deny, and an ask_user
//     decision with no confirmation listener auto-denies without prompting.
//     supportsPermissionRequests is therefore false; a needs_you from Gemini
//     can only be a decision (the shared `## Needs human decision` protocol).
//   - Headless default policy denies everything, so the adapter passes an
//     approval mode: auto_edit (file edits proceed; everything else denied)
//     by default, overridable via GEMINI_APPROVAL_MODE (yolo / default).
//   - `--resume <uuid>` continues the SAME session with prior context
//     (init carries the resumed session id), so supportsResume is true.
//     `--resume latest` silently starts a NEW session when none exists, so
//     this adapter ONLY resumes by explicit UUID — a missing session is a
//     real failure (exit 42), never a disguised fresh run.
//   - No auth configured -> exit 41 + a settings/env message on stderr, with
//     NO JSON events (stable structural signal). In-run API auth failures
//     (401 / "API key not valid") are classified here from Gemini's own text.
//   - SIGTERM/SIGINT -> graceful shutdown exits 0 WITHOUT a terminal `result`
//     event, so a cancelled/interrupted run is detected by the absence of the
//     result event, never trusted from the exit code.
//
// Approval modes other than default are only honored in a trusted folder;
// `--skip-trust` (GEMINI_CLI_TRUST_WORKSPACE=true) satisfies that, which is
// why every invocation carries it.

import { spawn } from "node:child_process";
import { classifyResult } from "../core/lifecycle.mjs";

// Injectable for tests and non-PATH installs; defaults to `gemini` on PATH.
export function geminiBin() {
  return process.env.GEMINI_BIN ?? "gemini";
}

// Approval mode for headless runs. auto_edit is the honest default: the file
// edits a coding task needs proceed, and every other tool is denied by
// Gemini's headless policy engine (there is no human to ask). GEMINI_APPROVAL_MODE
// is a deployment override, never a silent provider choice:
//   auto_edit (default) -> edits proceed, everything else denied
//   yolo                -> auto-approve every tool (danger-full-access analog)
//   default             -> Gemini's plain headless default (denies edits too)
export function geminiApprovalArgs() {
  switch (process.env.GEMINI_APPROVAL_MODE ?? "auto_edit") {
    case "yolo":
      return ["--approval-mode", "yolo"];
    case "default":
      return [];
    case "auto_edit":
    default:
      return ["--approval-mode", "auto_edit"];
  }
}

// The user-facing recovery step for a classified auth failure, shown verbatim
// by the UI. Gemini has no `login` subcommand: credentials live in
// ~/.gemini/settings.json or in GEMINI_API_KEY / Vertex env vars. The one
// honest prompt covers both — a person runs `gemini` once interactively to
// sign in, or sets GEMINI_API_KEY.
export function classifyGeminiFailure(text, exitCode = null) {
  const message = String(text ?? "");
  const authExit = exitCode === 41;
  const authText =
    /api key not valid|invalid api key|\b401\b|unauthorized|not authenticated|authentication_error|api_key_invalid|missing bearer|please set an auth method/i.test(
      message
    );
  if (authExit || authText) {
    return {
      kind: "auth",
      remedy: "run `gemini` once interactively (or set GEMINI_API_KEY)"
    };
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

// Tools that actually mutate a file on disk. A ReadFile, FindFiles or
// SearchText also carries a file_path but never changed anything — only these
// produce a file.changed event, exactly like the Claude adapter's MUTATING
// set. This is the one place Gemini's tool vocabulary is allowed to decide
// what counts as a change.
const MUTATING = new Set(["Edit", "WriteFile"]);

export const geminiProvider = {
  id: "gemini",
  displayName: "Gemini CLI",
  capabilities: {
    // Honest declaration, verified against gemini 0.57.0 (see
    // docs/gemini-capability-map.md): --resume <uuid> continues the same
    // session; -o stream-json emits structured events (init/message/
    // tool_use/tool_result/result); mutating tool_use events carry the
    // file_path; shell tool_use carries the command; but native headless mode
    // has NO human-in-the-loop permission surface (headless policy default is
    // deny; ask_user auto-denies with no listener).
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsFileChanges: true,
    supportsCommands: true,
    supportsPermissionRequests: false,
    supportsSandbox: false,
    supportsStreaming: true,
    // Assistant message deltas stream the result text as it is produced; the
    // written result is final at the terminal `result` event.
    resultOnCompletion: false
  },

  async start({ cwd, prompt, model, onEvent = () => {} }) {
    const args = ["-p", prompt, "--skip-trust", "-o", "stream-json", ...geminiApprovalArgs()];
    if (model) args.push("-m", model);
    return runGemini({ cwd, args, onEvent });
  },

  async resume({ cwd, externalSessionId, grant = "continue", model, onEvent = () => {} }) {
    if (!externalSessionId) {
      throw new Error("No external session id — this task cannot be resumed.");
    }
    const prompt = RESUME_PROMPTS[grant] ?? RESUME_PROMPTS.continue;
    // Resume by EXPLICIT UUID only — `--resume latest` silently starts a new
    // session when none exists, and a missing session must be a real error.
    const args = [
      "-p",
      prompt,
      "--skip-trust",
      "-o",
      "stream-json",
      "--resume",
      externalSessionId,
      ...geminiApprovalArgs()
    ];
    if (model) args.push("-m", model);
    return runGemini({ cwd, args, onEvent });
  }
};

// ---------------------------------------------------------------------------
// Run + JSONL event parsing
// ---------------------------------------------------------------------------

// The per-run parser state shared between the live stream and the pure
// parser. `consumeGeminiLine` feeds one JSON line; `runGemini` feeds live
// chunks, and tests feed fixture text — the exact same code path.
export function createGeminiParser(onEvent = () => {}) {
  return {
    sessionId: null,
    assistantText: "",
    result: null, // the terminal { status, error? } event, if any
    sawEvent: false,
    onEvent
  };
}

export function consumeGeminiLine(state, line) {
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
    case "init":
      state.sessionId = event.session_id ?? null;
      onEvent({ type: "run.started", sessionId: state.sessionId });
      break;
    case "message":
      if (event.role === "assistant" && typeof event.content === "string") {
        state.assistantText += event.content;
        if (event.content) onEvent({ type: "progress", text: event.content });
      }
      break;
    case "tool_use":
      onEvent({
        type: "tool.started",
        name: event.tool_name ?? "unknown",
        input: event.parameters ?? {}
      });
      // Mutating tools only — a Read never produces a change. Same
      // convention as the Claude adapter (emitted at the call, not at
      // completion).
      if (
        MUTATING.has(event.tool_name) &&
        typeof event.parameters?.file_path === "string"
      ) {
        onEvent({ type: "file.changed", path: event.parameters.file_path });
      }
      break;
    case "tool_result":
      onEvent({ type: "tool.completed", isError: event.status === "error" });
      break;
    case "result":
      // The terminal event for success AND handled fatal errors. It carries
      // no response text — the result text comes from assistant deltas.
      state.result = event;
      break;
    case "error":
      // Non-fatal stream warnings (severity warning|error). The terminal
      // `result` event is the only signal that decides the outcome —
      // deliberately not recorded as task progress.
      break;
  }
  return state;
}

function runGemini({ cwd, args, onEvent }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(geminiBin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        status: "failed",
        error: `Could not start gemini: ${error.message}`
      });
      return;
    }

    let buffer = "";
    let stderr = "";
    const state = createGeminiParser(onEvent);

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        consumeGeminiLine(state, line);
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      resolve({
        status: "failed",
        error: `Could not start gemini. Is the Gemini CLI installed and on PATH? ${error.message}`
      });
    });

    child.on("close", code => {
      resolve(
        normalizeGeminiRun({
          sessionId: state.sessionId,
          result: state.result,
          text: state.assistantText,
          sawEvent: state.sawEvent,
          exitCode: code ?? 1,
          stderr
        })
      );
    });
  });
}

// The JSONL event stream -> normalized Work outcome. Pure and testable.
export function normalizeGeminiRun({
  text = "",
  sessionId = null,
  result = null,
  sawEvent = false,
  exitCode = null,
  stderr = ""
} = {}) {
  // A terminal `result` event is the only signal that decides the outcome —
  // exit codes alone are not trustworthy (a signal-cancelled run exits 0).
  if (result) {
    if (result.status === "error") {
      const error =
        result.error?.message ||
        (typeof result.error === "string" ? result.error : "") ||
        stderr.trim() ||
        "Gemini CLI reported an execution error.";
      const failure = classifyGeminiFailure(error, exitCode);
      return {
        status: "failed",
        ...(sessionId ? { externalSessionId: sessionId } : {}),
        error,
        ...(failure ? { failure } : {})
      };
    }
    // status === "success"
    const classified = classifyResult(text);
    if (classified.status === "needs_you") {
      return {
        status: "needs_you",
        reason: "decision",
        ...(sessionId ? { externalSessionId: sessionId } : {}),
        result: text,
        blockedOn: classified.blockedOn
      };
    }
    if (classified.status === "failed") {
      return {
        status: "failed",
        ...(sessionId ? { externalSessionId: sessionId } : {}),
        error: classified.error,
        failure: classified.failure
      };
    }
    return {
      status: "ready",
      ...(sessionId ? { externalSessionId: sessionId } : {}),
      result: text
    };
  }

  // No terminal result event: the run was interrupted/cancelled or died
  // before completing. Never claim readiness from an exit code.
  const error =
    stderr.trim() ||
    (!sawEvent
      ? "gemini produced no output. Is the Gemini CLI installed and authenticated?"
      : exitCode === 0
        ? "gemini exited without completing the run."
        : `gemini exited with code ${exitCode} before completing the run.`);
  const failure = classifyGeminiFailure(error, exitCode);
  return {
    status: "failed",
    ...(sessionId ? { externalSessionId: sessionId } : {}),
    error,
    ...(failure ? { failure } : {})
  };
}
