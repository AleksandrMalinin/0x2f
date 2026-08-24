// Generic Command Provider — a reusable execution provider for harnesses that
// can be invoked headlessly but speak no structured protocol (no ACP).
//
//   manifest = { id, displayName, transport: "command", command: [exec, ...] }
//
// The command is spawned DIRECTLY as an argv array — never through a shell,
// never with string interpolation. Only two placeholders are substituted at
// run time ({prompt}, {workspace}); manifest validation guarantees no other
// placeholder can reach this module.
//
// What we genuinely know:
//   process spawned      -> run.started
//   exit 0 + stdout      -> run.completed / ready (or needs_you/decision via
//                           the shared Work prompt convention)
//   non-zero exit        -> run.failed / failed
//
// Nothing else is inferred from prose: no permissions, no file changes, no
// tools, no resume. Capabilities are the conservative defaults on purpose —
// a harness that can express more should move to ACP (or a native adapter).

import { spawn } from "node:child_process";
import { decisionSection } from "../core/lifecycle.mjs";
import { substituteCommand } from "./manifests.mjs";

export function createCommandProvider(manifest) {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    integrationType: "command",
    // The configured command, kept for availability checks and introspection.
    command: manifest.command,
    capabilities: {
      supportsResume: false,
      supportsStructuredEvents: false,
      supportsFileChanges: false,
      supportsCommands: false,
      supportsPermissionRequests: false,
      supportsSandbox: false,
      supportsStreaming: false,
      // Exit 0 + stdout is the only signal a bare command gives, and it
      // arrives all at once when the process closes — nothing before that.
      resultOnCompletion: true
    },

    async start({ cwd, prompt, onEvent = () => {} }) {
      const argv = substituteCommand(manifest.command, { prompt, workspace: cwd });
      return runCommand({ id: manifest.id, cwd, argv, onEvent });
    }
    // resume() is deliberately absent: supportsResume is false, and the worker
    // + actions refuse to resume a provider that cannot continue a session.
  };
}

// Substitute the tiny placeholder set. Validation (providers/manifests.mjs)
// guarantees {prompt} and {workspace} are the only placeholders present.
// (Defined in manifests.mjs — the manifest concern — and re-exported here for
// callers that import the provider module directly.)
export { substituteCommand } from "./manifests.mjs";

function runCommand({ id, cwd, argv, onEvent }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        status: "failed",
        error: `Could not start ${id}: ${error.message}`
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
        error: `Could not start ${id}: ${error.message}. Is "${argv[0]}" installed and on PATH?`
      });
    });

    child.on("close", code => {
      settle(normalizeCommandRun({ code: code ?? 1, stdout, stderr }));
    });
  });
}

// exit 0 -> ready (honoring the Work `## Needs human decision` convention);
// non-zero -> failed with the stderr message. Pure and testable.
export function normalizeCommandRun({ code, stdout = "", stderr = "", id = "command" }) {
  const text = typeof stdout === "string" ? stdout : "";

  if (code === 0) {
    const decision = decisionSection(text);
    if (decision) {
      return {
        status: "needs_you",
        reason: "decision",
        result: text,
        blockedOn: { type: "decision", text: decision }
      };
    }
    return { status: "ready", result: text };
  }

  return {
    status: "failed",
    error:
      (typeof stderr === "string" && stderr.trim()) ||
      `${id} exited with code ${code} before completing the task.`
  };
}
