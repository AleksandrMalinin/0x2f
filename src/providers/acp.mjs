// ACP Provider — one reusable execution provider that speaks the Agent Client
// Protocol (v1) generically over stdio. Any agent that exposes an ACP server
// (Cursor, Gemini CLI, OpenCode, Codex via codex-acp, future ACP agents) can
// be integrated through a manifest — no provider-specific source code.
//
// Verified against the official v1 spec (agentclientprotocol.com) and the
// current Cursor / OpenCode / Gemini CLI documentation:
//
//   transport    JSON-RPC 2.0 over stdio, one message per line
//   initialize   negotiate protocolVersion (integer 1) + capabilities
//   session/new  create a session            -> { sessionId }
//   session/load resume a session (needs the agent's `loadSession` capability)
//   session/prompt  { sessionId, prompt: [{ type: "text", text }] }
//                -> { stopReason: end_turn | max_tokens | max_turn_requests |
//                     refusal | cancelled }
//   session/update notifications: agent_message_chunk (progress text),
//                tool_call / tool_call_update (title, kind, status, locations)
//   session/request_permission  agent->client request; the client MUST answer
//                with a selected optionId (allow_once/allow_always/
//                reject_once/reject_always) or the cancelled outcome
//   session/cancel notification (client -> agent)
//
// Normalized mapping (never raw ACP shapes leak past this module):
//   initialize + session/new  -> run.started (with the real session id)
//   agent_message_chunk       -> progress
//   tool_call with locations  -> tool.started / file.changed (only when the
//                                agent actually reports them — never invented)
//   session/request_permission-> auto-resolved per manifest policy (deny by
//                                default), recorded as progress; a headless
//                                worker cannot answer a mid-run prompt, so
//                                this is never mapped to a fake needs_you halt
//   session/prompt end_turn   -> run.completed / ready (or needs_you/decision
//                                via the shared Work prompt convention)
//   cancelled / refusal / early limits -> run.failed
//   session id                -> outcome.externalSessionId (persisted by the
//                                worker; resume uses session/load)
//
// The prompt text and workspace are substituted from the manifest command's
// {prompt} / {workspace} placeholders, exactly like the command provider.

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { decisionSection } from "../core/lifecycle.mjs";
import { substituteCommand } from "./manifests.mjs";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_CLIENT_INFO = { name: "0x2f", version: "0.4.0" };

// Handshake steps must answer promptly; a prompt turn may legitimately run
// for minutes, so only the handshake is bounded.
const HANDSHAKE_TIMEOUT_MS = 30_000;
// After a run completes, close stdin and give the agent a moment to exit
// before killing it (agents normally exit on EOF).
const SHUTDOWN_GRACE_MS = 2_000;

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

// tool_call.kind is the agent's OWN classification of what it is doing —
// normalizing it into the tool input shape the ledger already reads
// (input.command for a shell-shaped step, input.file_path for a file-shaped
// one) is boundary normalization, not invention. An agent that never sends
// kind falls back to the file location alone, exactly as before.
export function toolInput(kind, title, file) {
  if (kind === "execute" && typeof title === "string" && title.trim()) {
    return { command: title };
  }
  if (typeof file === "string" && file) {
    return { file_path: file };
  }
  return {};
}

export function createAcpProvider(manifest) {
  // Permission policy: "interactive" (the product path — permission requests
  // enter the real NEEDS YOU lifecycle and the human decides), "deny", or
  // "approve" (headless auto-resolution). The default is interactive; deny /
  // approve are explicit opt-ins for headless use.
  const permissions = manifest.permissions ?? "interactive";
  // The provider is a singleton per manifest: at most one run is active per
  // process (the worker runs one execution), so an active-run handle is all
  // the cancellation seam needs.
  let active = null;

  const provider = {
    id: manifest.id,
    displayName: manifest.displayName,
    integrationType: "acp",
    command: manifest.command,
    capabilities: {
      // session/load exists in the protocol; the agent's `loadSession`
      // capability gates it at run time (resume fails clearly when absent).
      supportsResume: true,
      // Status/tool updates are structured when the agent provides them.
      supportsStructuredEvents: true,
      // tool_call.kind (the agent's own classification) is plumbed through
      // to a file.changed / command distinction below — an edit that
      // completes is a change, an execute call is a command.
      supportsFileChanges: true,
      supportsCommands: true,
      // Permission requests participate in the NEEDS YOU lifecycle
      // (interactive) or are auto-resolved (deny/approve), per the manifest.
      supportsPermissionRequests: true,
      supportsSandbox: false,
      supportsStreaming: true,
      // agent_message_chunk / tool_call updates stream throughout the run.
      resultOnCompletion: false
    },

    async start({ cwd, prompt, onEvent = () => {}, permission } = {}) {
      const run = runAcp({
        manifest,
        cwd,
        prompt,
        onEvent,
        permissions,
        decisionFile: permission?.decisionFile
      });
      active = run;
      try {
        return await run.promise;
      } finally {
        if (active === run) active = null;
      }
    },

    async resume({ cwd, externalSessionId, grant = "continue", onEvent = () => {}, permission } = {}) {
      const run = runAcp({
        manifest,
        cwd,
        prompt: RESUME_PROMPTS[grant] ?? RESUME_PROMPTS.continue,
        onEvent,
        permissions,
        decisionFile: permission?.decisionFile,
        resumeSessionId: externalSessionId
      });
      active = run;
      try {
        return await run.promise;
      } finally {
        if (active === run) active = null;
      }
    },

    // Best-effort cancellation of the active run: send session/cancel and
    // terminate the agent process. The node currently stops a run by killing
    // the worker process; this method exists for the provider contract and
    // for the worker's SIGTERM handler.
    cancel() {
      if (active) active.cancel();
    }
  };

  return provider;
}

// --- the ACP run state machine ----------------------------------------------

function runAcp({ manifest, cwd, prompt, onEvent, permissions, decisionFile = null, resumeSessionId = null }) {
  const argv = substituteCommand(manifest.command, { prompt, workspace: cwd });

  const handles = {
    child: null,
    rpc: null,
    cancel() {}
  };

  const promise = new Promise(resolve => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        // ACP speaks over stdin/stdout: we write requests to the agent's
        // stdin and read responses/notifications from its stdout.
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        status: "failed",
        error: `Could not start ${manifest.id}: ${error.message}`
      });
      return;
    }
    handles.child = child;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let sessionId = null;
    let currentMessageId = null;
    let currentText = "";
    let resultText = "";
    const pollTimers = new Set();

    const clearPollTimers = () => {
      for (const timer of pollTimers) clearInterval(timer);
      pollTimers.clear();
    };

    const settle = outcome => {
      if (settled) return;
      settled = true;
      clearPollTimers();
      if (sessionId && outcome.externalSessionId === undefined) {
        outcome = { ...outcome, externalSessionId: sessionId };
      }
      resolve(outcome);
      shutdown();
    };

    // Graceful teardown: close stdin (agents exit on EOF), then kill.
    let shutdownTimer = null;
    const shutdown = () => {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      shutdownTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, SHUTDOWN_GRACE_MS);
    };
    const forceStop = () => {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    handles.cancel = () => {
      // Per spec, respond cancelled to any pending permission request, then
      // notify the agent; the prompt turn should end with stopReason
      // "cancelled", which the normal completion path maps to a failure.
      // Give the agent a moment to honour the cancel before killing it.
      try {
        if (rpc) {
          rpc.cancelPendingPermissions();
          rpc.notify("session/cancel", { sessionId });
        }
      } catch {
        /* best-effort */
      }
      setTimeout(forceStop, 300);
    };

    // --- JSON-RPC client ----------------------------------------------------
    let nextId = 0;
    const pending = new Map(); // id -> { resolve, reject, timer }
    const permissionPending = new Map(); // requestId -> sessionId
    let buffer = "";

    const rpc = {
      send(method, params, { timeout = HANDSHAKE_TIMEOUT_MS } = {}) {
        const id = ++nextId;
        const message = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolveMsg, rejectMsg) => {
          const timer =
            timeout > 0
              ? setTimeout(() => {
                  pending.delete(id);
                  rejectMsg(
                    new Error(`${manifest.id} did not respond to ${method} within ${Math.round(timeout / 1000)}s.`)
                  );
                }, timeout)
              : null;
          pending.set(id, { resolve: resolveMsg, reject: rejectMsg, timer });
          try {
            child.stdin.write(JSON.stringify(message) + "\n");
          } catch (error) {
            pending.delete(id);
            if (timer) clearTimeout(timer);
            rejectMsg(new Error(`Could not write to ${manifest.id}: ${error.message}`));
          }
        });
      },

      notify(method, params) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
        );
      },

      respond(id, result) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
        );
      },

      cancelPendingPermissions() {
        for (const [requestId] of permissionPending) {
          rpc.respond(requestId, {
            outcome: { outcome: "cancelled" }
          });
          permissionPending.delete(requestId);
        }
      }
    };
    handles.rpc = rpc;

    // Answer an agent-initiated permission request.
    //
    // deny / approve: auto-resolve headlessly and continue (recorded as
    // progress — observability without a fake halt).
    //
    // interactive: hold the response, surface the request as a normalized
    // needs_user event (blockedOn.live), and wait for the human's decision in
    // the per-task decision file. The ACP session stays alive the whole time,
    // so ALLOW/REJECT answers the ORIGINAL request and the same execution
    // continues — never a fresh run, never a session/load restart.
    function answerPermission(requestId, request) {
      const options = Array.isArray(request.params?.options) ? request.params.options : [];
      if (permissions === "interactive") {
        startInteractivePermission(requestId, request, options);
        return;
      }
      const kind = permissions === "approve" ? "allow_" : "reject_";
      const preferred = options.find(o => String(o.kind ?? "").startsWith(kind));
      const chosen = preferred ?? null;
      if (!chosen) {
        // The agent offered no option matching the policy — abort the turn
        // rather than silently pick a conflicting option.
        rpc.respond(requestId, { outcome: { outcome: "cancelled" } });
        return;
      }
      rpc.respond(requestId, {
        outcome: { outcome: "selected", optionId: chosen.optionId }
      });
      const tool = request.params?.toolCall ?? {};
      onEvent({
        type: "progress",
        text:
          `${manifest.displayName} requested permission (${tool.title ?? tool.kind ?? "tool call"}): ` +
          `${permissions === "approve" ? "approved" : "declined"} by headless policy`
      });
    }

    // Choose the least-privilege option of a kind: allow_once before
    // allow_always, reject_once before reject_always.
    function pickOption(options, kindPrefix) {
      const byKind = kind => options.find(o => String(o.kind ?? "") === kind);
      const one = kindPrefix === "allow_" ? "allow_once" : "reject_once";
      const always = kindPrefix === "allow_" ? "allow_always" : "reject_always";
      return byKind(one) ?? byKind(always) ?? null;
    }

    function firstLocationPath(tool) {
      const locations = Array.isArray(tool.locations) ? tool.locations : [];
      return typeof locations[0]?.path === "string" ? locations[0].path : null;
    }

    // Interactive: persist the request for the human, emit needs_user, and
    // wait on the decision file. Only ACTUALLY SUPPLIED context is shown —
    // never invented from prose.
    function startInteractivePermission(requestId, request, options) {
      const tool = request.params?.toolCall ?? {};
      const allowOption = pickOption(options, "allow_");
      const rejectOption = pickOption(options, "reject_");
      const blockedOn = {
        type: "permission",
        live: true,
        tool: tool.title ?? tool.kind ?? null,
        file: firstLocationPath(tool),
        description: tool.title ?? null,
        options: options.map(o => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind
        })),
        canAllow: allowOption !== null,
        canReject: rejectOption !== null,
        requestId,
        raw: tool
      };
      permissionPending.set(requestId, {
        sessionId: request.params?.sessionId,
        allowOption,
        rejectOption
      });

      onEvent({ type: "needs_user", reason: "permission", blockedOn });

      if (!decisionFile) {
        // No decision channel (a direct provider test, or a caller that did
        // not wire the worker's permission file). Never approve silently:
        // fall back to declining the request headlessly.
        const fallback = rejectOption ?? allowOption;
        rpc.respond(requestId, {
          outcome: fallback
            ? { outcome: "selected", optionId: fallback.optionId }
            : { outcome: "cancelled" }
        });
        permissionPending.delete(requestId);
        onEvent({
          type: "progress",
          text: `${manifest.displayName} requested permission but no interactive decision channel exists — declined by headless policy`
        });
        return;
      }

      const timer = setInterval(async () => {
        let decision = null;
        try {
          decision = JSON.parse(await fs.readFile(decisionFile, "utf8"));
        } catch {
          return; // not written yet — keep waiting
        }
        if (!decision?.grant) return;
        clearInterval(timer);
        pollTimers.delete(timer);
        permissionPending.delete(requestId);
        const optionId =
          decision.grant === "allow" ? allowOption?.optionId : rejectOption?.optionId;
        // Surface the resolution to the worker BEFORE answering the agent.
        // The worker's permission.resolved handler rewrites the task to
        // "working" while the same run continues; answering first would let
        // the agent's completion settle the run (ready) and then be clobbered
        // back to "working" by the fire-and-forget handler landing last —
        // a finished run stuck at working forever.
        try {
          await onEvent({ type: "permission.resolved", grant: decision.grant });
        } catch {
          /* best-effort — the completion path still settles the run */
        }
        rpc.respond(requestId, {
          outcome: optionId
            ? { outcome: "selected", optionId }
            : { outcome: "cancelled" }
        });
        try {
          await fs.rm(decisionFile, { force: true });
        } catch {
          /* best-effort */
        }
      }, 250);
      pollTimers.add(timer);
    }

    function handleMessage(message) {
      // A server-initiated REQUEST (has id + method) — answer it.
      if (message.id !== undefined && message.id !== null && typeof message.method === "string") {
        if (message.method === "session/request_permission") {
          permissionPending.set(message.id, message.params?.sessionId);
          answerPermission(message.id, message);
        }
        // Unknown server methods get a clear error response, never a hang.
        else {
          rpc.respond(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } });
        }
        return;
      }
      // A RESPONSE to one of our requests.
      if (message.id !== undefined && message.id !== null) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(`${manifest.id}: ${message.error.message ?? JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result ?? {});
        }
        return;
      }
      // A NOTIFICATION.
      handleNotification(message);
    }

    function handleNotification(message) {
      switch (message.method) {
        case "session/update": {
          const update = message.params?.update ?? {};
          switch (update.sessionUpdate) {
            case "agent_message_chunk": {
              const text = update.content?.text;
              if (typeof text === "string" && text) {
                if (update.messageId !== undefined && update.messageId !== null && update.messageId !== currentMessageId) {
                  currentMessageId = update.messageId;
                  resultText = currentText; // previous message is complete
                  currentText = "";
                }
                currentText += text;
                onEvent({ type: "progress", text });
              }
              break;
            }
            case "tool_call": {
              const locations = Array.isArray(update.locations) ? update.locations : [];
              const file = locations[0]?.path;
              const name = update.title || update.kind || "tool";
              onEvent({
                type: "tool.started",
                name,
                input: toolInput(update.kind, update.title, file)
              });
              break;
            }
            case "tool_call_update": {
              const locations = Array.isArray(update.locations) ? update.locations : [];
              if (locations.length && (update.status === "completed" || update.status === "failed")) {
                // The agent reports files this tool call affected.
                onEvent({
                  type: "tool.started",
                  name: update.title || "tool",
                  input: { file_path: locations[0].path }
                });
              }
              // kind is the agent's OWN classification of what this tool call
              // did — an "edit" that reached completed is a real change, not
              // an inference from the tool's name.
              if (update.kind === "edit" && update.status === "completed" && locations[0]?.path) {
                onEvent({ type: "file.changed", path: locations[0].path });
              }
              break;
            }
            default:
              // plan / usage_update / agent_plan_update / ... — no reliable
              // Work mapping; ignore rather than fabricate.
              break;
          }
          break;
        }
        default:
          // Unknown notifications must never break the run.
          break;
      }
    }

    // Map a completed prompt turn (or failure) to a normalized outcome.
    function outcomeFromStopReason(stopReason) {
      if (stopReason === "end_turn") {
        const result = currentText || resultText || "";
        const decision = decisionSection(result);
        if (decision) {
          return {
            status: "needs_you",
            reason: "decision",
            result,
            blockedOn: { type: "decision", text: decision }
          };
        }
        return { status: "ready", result };
      }
      if (stopReason === "cancelled") {
        return { status: "failed", error: `${manifest.id} cancelled the run.` };
      }
      return {
        status: "failed",
        error: `${manifest.id} ended the turn early (${stopReason}).`
      };
    }

    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC message — ignore stray output
        }
        handleMessage(message);
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      settle({
        status: "failed",
        error: `Could not start ${manifest.id}: ${error.message}. Is "${argv[0]}" installed and on PATH?`
      });
    });

    child.on("close", code => {
      // If we already settled (a stopReason arrived), this is the teardown.
      if (settled) return;
      // The agent exited without completing the turn.
      for (const [, entry] of pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(`${manifest.id} exited before responding.`));
      }
      pending.clear();
      settle({
        status: "failed",
        error:
          stderr.trim() ||
          `${manifest.id} exited with code ${code ?? "?"} before completing the run.`
      });
    });

    // --- the run ------------------------------------------------------------
    (async () => {
      try {
        const init = await rpc.send("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          agentCapabilities: {},
          clientInfo: ACP_CLIENT_INFO
        });
        if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
          throw new Error(
            `${manifest.id} speaks ACP protocol version ${JSON.stringify(init.protocolVersion)}; 0x2F supports ${ACP_PROTOCOL_VERSION}.`
          );
        }
        const agentCapabilities = init.agentCapabilities ?? {};

        if (resumeSessionId) {
          if (agentCapabilities.loadSession !== true) {
            throw new Error(
              `${manifest.id} does not advertise the loadSession capability — this task cannot be resumed.`
            );
          }
          const loaded = await rpc.send("session/load", {
            sessionId: resumeSessionId,
            cwd,
            mcpServers: []
          });
          sessionId = loaded.sessionId ?? resumeSessionId;
        } else {
          const created = await rpc.send("session/new", {
            cwd,
            mcpServers: []
          });
          sessionId = created.sessionId;
          if (!sessionId) {
            throw new Error(`${manifest.id} did not return a session id from session/new.`);
          }
        }

        onEvent({ type: "run.started", sessionId });

        const promptResult = await rpc.send(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: prompt }]
          },
          { timeout: 0 } // a prompt turn may run for minutes
        );
        settle(outcomeFromStopReason(promptResult.stopReason));
      } catch (error) {
        settle({
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  });

  return { promise, cancel: () => handles.cancel() };
}
