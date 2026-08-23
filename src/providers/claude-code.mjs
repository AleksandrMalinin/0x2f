// Claude Code execution provider — the boundary where Claude-specific
// behavior stops.
//
// Work talks to an ExecutionProvider, never to a specific agent CLI directly.
// The provider is responsible for translating a vendor's process into the
// normalized outcome shapes in ../core/lifecycle.mjs:
//
//   { status: "ready",    result }
//   { status: "needs_you", reason, blockedOn, result? }
//   { status: "failed",   error }
//
// A provider implements:
//
//   id: string                 e.g. "claude-code"
//   displayName: string
//   capabilities: {
//     supportsResume, supportsStructuredEvents,
//     supportsPermissionRequests, supportsSandbox, supportsStreaming
//   }
//   async start({ cwd, prompt, onEvent })                 -> outcome
//   async resume({ cwd, externalSessionId, grant, onEvent }) -> outcome
//
// `onEvent(event)` receives normalized progress events (run.started,
// progress, tool.started, tool.completed, needs_user). Consumers must not
// depend on vendor-specific event fields.
//
// Model vs harness: a provider is a harness (Claude Code, Codex, DeepSeek
// Harness, OpenCode). Which model runs inside is the provider's concern.
// Every concept in THIS file may be Claude-shaped; nothing outside this file
// may be.

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Claude Code provider (v0.2 — the only functional provider)
// ---------------------------------------------------------------------------
//
// Verified against Claude Code 2.1.241 (Aug 2026):
//
// SUPPORTED (used here):
//   - `claude -p --verbose --output-format stream-json "<prompt>"`
//     headless execution with structured, newline-delimited JSON events.
//   - `system/init` event carries `session_id` — the external session id.
//   - `result` event carries `permission_denials` (tool_name + full tool_input)
//     when a tool call needed permission that was not granted. Exit code is 0
//     and `is_error` is false in that case — a successful process, an
//     incomplete task. This is exactly the v0 dogfooding failure, now
//     detectable structurally instead of by parsing prose.
//   - `claude -p --resume <session-id> "<prompt>"` resumes the SAME session
//     (same session_id, full prior context).
//   - `--permission-mode acceptEdits` on a resumed run grants file-edit
//     permission so a previously blocked edit can proceed.
//
// NOT SUPPORTED RELIABLY (documented limitations, v0.2):
//   - `--allowedTools "Edit(<path>)"` combined with `--resume` in print mode
//     fails with "No deferred tool marker found in the resumed session" —
//     that path is built for interactive sessions paused at a permission
//     prompt, not headless denials. So the narrowest *reliable* grant on
//     resume is `--permission-mode acceptEdits` (per-session, file edits
//     only; Bash and other tools still need permission).
//   - Print-mode sessions only resume if the transcript was persisted to
//     ~/.claude/projects (default on). If the user's config disables
//     persistence, resume fails and Work reports it — it never pretends a
//     new session is the same session.

const ALLOW_PROMPT = `The user reviewed your last message and granted the requested permission.
Continue the task and complete the remaining work.

When you finish, return the same markdown sections as the original task:
## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision`;

const REJECT_PROMPT = `The user reviewed your last message and rejected the requested change.
Do not attempt it again. Complete whatever part of the task you can
responsibly finish without it, or explain what remains blocked.

When you finish, return the same markdown sections as the original task:
## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision`;

const CONTINUE_PROMPT = `Continue the task from where you left off.

When you finish, return the same markdown sections as the original task:
## Result, ## Evidence, ## Changes, ## Verification, ## Needs human decision`;

export const claudeCodeProvider = {
  id: "claude-code",
  displayName: "Claude Code",
  capabilities: {
    supportsResume: true,
    supportsStructuredEvents: true,
    supportsPermissionRequests: true,
    supportsSandbox: false,
    supportsStreaming: true
  },

  async start({ cwd, prompt, onEvent = () => {} }) {
    const args = ["-p", "--verbose", "--output-format", "stream-json", prompt];
    return runClaude({ cwd, args, onEvent });
  },

  async resume({ cwd, externalSessionId, grant = "continue", onEvent = () => {} }) {
    const prompt =
      grant === "allow"
        ? ALLOW_PROMPT
        : grant === "reject"
          ? REJECT_PROMPT
          : CONTINUE_PROMPT;

    const args = ["-p", "--verbose", "--output-format", "stream-json"];
    if (!externalSessionId) {
      throw new Error("No external session id — this task cannot be resumed.");
    }
    args.push("--resume", externalSessionId);
    if (grant === "allow") {
      // See "NOT SUPPORTED RELIABLY" above: acceptEdits is the narrowest
      // grant that works for headless resume in current Claude Code.
      args.push("--permission-mode", "acceptEdits");
    }
    args.push(prompt);
    return runClaude({ cwd, args, onEvent });
  }
};

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

function runClaude({ cwd, args, onEvent }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    let buffer = "";
    let stderr = "";
    let sessionId = null;
    let resultEvent = null;
    let sawEvent = false;

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // not JSON — ignore stray output
        }
        sawEvent = true;
        handleEvent(event);
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      reject(new Error(`Could not start claude: ${error.message}`));
    });

    child.on("close", code => {
      if (resultEvent) {
        try {
          resolve(normalizeOutcome(resultEvent, { sessionId }));
        } catch (error) {
          reject(error);
        }
      } else if (code !== 0) {
        resolve({
          status: "failed",
          error:
            stderr.trim() ||
            `claude exited with code ${code} before producing a result.`
        });
      } else {
        resolve({
          status: "failed",
          error: sawEvent
            ? "claude exited without a result event."
            : "claude produced no output. Is the Claude Code CLI installed and authenticated?"
        });
      }
    });

    function handleEvent(event) {
      if (event.type === "system" && event.subtype === "init") {
        sessionId = event.session_id ?? null;
        onEvent({ type: "run.started", sessionId });
      } else if (event.type === "system" && event.subtype === "permission_denied") {
        onEvent({
          type: "needs_user",
          reason: "permission",
          detail: { tool: event.tool_name, message: event.message }
        });
      } else if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") {
            onEvent({ type: "tool.started", name: block.name, input: block.input });
          } else if (block.type === "text" && block.text) {
            onEvent({ type: "progress", text: block.text });
          }
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_result") {
            onEvent({
              type: "tool.completed",
              isError: block.is_error === true
            });
          }
        }
      } else if (event.type === "result") {
        resultEvent = event;
      }
    }
  });
}

// Parse newline-delimited stream-json output (exported for tests).
export function parseStreamJson(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON lines
    }
  }
  return events;
}

// The vendor `result` event -> normalized outcome. Pure and testable.
export function normalizeOutcome(result, { sessionId = null } = {}) {
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials
    : [];

  // A successful process that ended blocked on permission is NEEDS YOU,
  // never READY. Check denials before is_error: a run that "failed" because
  // it was blocked on permission is still a permission block.
  if (denials.length > 0) {
    const first = denials[0];
    const input = first.tool_input ?? {};
    return {
      status: "needs_you",
      reason: "permission",
      externalSessionId: result.session_id ?? sessionId,
      result: typeof result.result === "string" ? result.result : "",
      blockedOn: {
        type: "permission",
        tool: first.tool_name,
        file: typeof input.file_path === "string" ? input.file_path : null,
        plannedChange: describeChange(first.tool_name, input),
        raw: first
      }
    };
  }

  if (result.is_error === true) {
    const errors = Array.isArray(result.errors)
      ? result.errors.join("; ")
      : "";
    return {
      status: "failed",
      externalSessionId: result.session_id ?? sessionId,
      error:
        errors ||
        (typeof result.result === "string" && result.result.trim()
          ? result.result
          : "Claude Code reported an execution error.")
    };
  }

  const text = typeof result.result === "string" ? result.result : "";
  const decision = decisionSection(text);
  if (decision) {
    return {
      status: "needs_you",
      reason: "decision",
      externalSessionId: result.session_id ?? sessionId,
      result: text,
      blockedOn: { type: "decision", text: decision }
    };
  }

  return {
    status: "ready",
    externalSessionId: result.session_id ?? sessionId,
    result: text
  };
}

function snippet(value, max = 100) {
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function describeChange(tool, input) {
  if (tool === "Edit" && input.old_string != null && input.new_string != null) {
    return `${snippet(input.old_string, 80)}  →  ${snippet(input.new_string, 80)}`;
  }
  if (typeof input.file_path === "string") {
    return `file: ${input.file_path}`;
  }
  if (typeof input.command === "string") {
    return `command: ${snippet(input.command)}`;
  }
  return snippet(JSON.stringify(input));
}

// Work's prompt asks the agent to end with a `## Needs human decision`
// section. A non-trivial section normalizes to needs_you (decision).
export function decisionSection(result) {
  const marker = "## Needs human decision";
  const index = result.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;

  const tail = result.slice(index + marker.length);
  const nextHeading = tail.search(/\n##\s+/);
  const body = (nextHeading >= 0 ? tail.slice(0, nextHeading) : tail).trim();

  if (!body || /^(none|n\/a|no)[.!]?$/i.test(body)) return null;
  return snippet(body, 400);
}

// Backward-compatible name (v0 exported this from lib).
export const hasHumanDecision = result => decisionSection(result) !== null;
