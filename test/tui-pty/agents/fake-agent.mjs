#!/usr/bin/env node
// Fake ACP agent for the TUI dogfood suite — a deterministic stand-in for a
// real coding harness, speaking the Agent Client Protocol (v1) over stdio
// exactly like the real agents 0x2F integrates. It performs real work (it
// edits a real file in the workspace) and pauses for real permission and
// decision stops, so the full TUI journey runs without any network access or
// model credentials.
//
// Roles (--role <role>):
//
//   journey   run 01: progress -> a REAL file edit -> an interactive
//              permission request (waits for the human's ALLOW/REJECT, then
//              finishes READY). run 02 (when the prompt carries the
//              correction marker): finishes with a NEEDS-YOU decision block.
//              run 03 (when the prompt carries the answer marker): finishes
//              READY. The run is chosen from markers in the PROMPT, exactly
//              like a real agent reading the task state in its input.
//   authfail  fails with a normalized provider-auth error (stderr + non-zero
//              exit) — the shared layer classifies it as an auth failure.
//   succeed   finishes READY immediately.
//
// The correction/answer markers come from a JSON file named by
// FAKE_AGENT_MARKERS (written by the driver, so the test and the agent can
// never disagree about the text it must react to).

import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const role = args[args.indexOf("--role") + 1] ?? "journey";

const markersFile = process.env.FAKE_AGENT_MARKERS;
const markers = markersFile
  ? JSON.parse(fs.readFileSync(markersFile, "utf8"))
  : { correction: "Use a 503, not a 429", answer: "keep the 429 for misbehaving clients" };

// How long the journey run stays visibly WORKING before pausing for the
// human — a real agent investigates before it asks; the fake keeps the same
// shape so the TUI's WORKING frame is observable even under parallel test
// load.
const PERMISSION_DELAY_MS = Number(process.env.FAKE_AGENT_PERMISSION_DELAY_MS ?? 2000);

// The workspace file a journey run really edits — the test commits a
// baseline, so the TUI's `d` view can draw the real working-tree diff.
const TARGET = "src/app.ts";
const APPENDED = "\n// retry with backoff\n";

const send = o => process.stdout.write(JSON.stringify(o) + "\n");
const notify = (sessionId, update) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let sessionId = null;
let promptId = null;

function decideRun(promptText) {
  if (promptText.includes(markers.answer)) return "ready";
  if (promptText.includes(markers.correction)) return "decision";
  return "permission";
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // not JSON-RPC — ignore
  }

  // The provider answered our permission request (id 100): continue the
  // same turn and finish READY.
  if (message.id === 100) {
    const chosen = message.result?.outcome?.outcome === "selected";
    const grant = chosen ? "allowed" : "declined";
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m2",
      content: {
        type: "text",
        text:
          "Verified the change after the human " + grant + ".\n\n" +
          "## Result\nAdded retry-with-backoff to the submit path; honors Retry-After in whole seconds.\n\n" +
          "## Evidence\nsrc/app.ts — the new retry block.\n\n" +
          "## Changes\nsrc/app.ts\n\n" +
          "## Verification\nnpm test -- submit\n\n" +
          "## Needs human decision\nREQUIRED: no\n"
      }
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }

  if (message.method === "session/cancel") {
    process.exit(0);
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-" + role },
        authMethods: []
      }
    });
    return;
  }
  if (message.method === "session/new") {
    sessionId = "sess-" + role + "-" + process.pid;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/load") {
    sessionId = message.params?.sessionId ?? "sess-loaded";
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method !== "session/prompt") return;

  promptId = message.id;
  const promptText = message.params?.prompt?.[0]?.text ?? "";

  if (role === "authfail") {
    // A normalized provider-auth/environment failure: the agent exits before
    // completing the turn, and the shared layer classifies the error text.
    process.stderr.write("Authentication failed: invalid API key (401 expired).\n");
    process.exit(1);
    return;
  }

  if (role === "succeed") {
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "s1",
      content: {
        type: "text",
        text:
          "## Result\nDone on the alternate harness.\n\n" +
          "## Verification\nnpm test\n\n" +
          "## Needs human decision\nREQUIRED: no\n"
      }
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }

  const run = decideRun(promptText);

  if (run === "permission") {
    // 1. report progress, 2. REALLY edit the workspace file, 3. report the
    // completed edit (-> file.changed), 4. pause for the human.
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "Inspecting the submit path…" }
    });
    const target = fs.existsSync(TARGET) ? TARGET : "src/app.ts";
    fs.appendFileSync(target, APPENDED);
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      messageId: "t1",
      title: "Edit submit path",
      kind: "edit",
      status: "completed",
      locations: [{ path: fs.realpathSync(target), line: 42 }]
    });
    // The human's decision (id 100 above) continues the same turn. Delaying
    // the request keeps the run observably WORKING first, like a real agent
    // that investigates before it asks.
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 100,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "call-1",
            title: "Edit submit-capture.ts",
            kind: "edit",
            locations: [{ path: fs.realpathSync(target), line: 42 }]
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" }
          ]
        }
      });
    }, PERMISSION_DELAY_MS);
    return; // continue when the human's decision arrives (id 100 above)
  }

  if (run === "decision") {
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "d1",
      content: {
        type: "text",
        text:
          "## Result\nRewrote the retry path to honor Retry-After.\n\n" +
          "## Needs human decision\nREQUIRED: yes\n" +
          "QUESTION: Should the offline queue fall back to the same 503 policy as the live path?\n" +
          "The offline queue currently retries with 429 semantics and a fixed 30s delay.\n" +
          "Aligning it to 503 plus Retry-After would keep one policy everywhere.\n"
      }
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }

  if (run === "ready") {
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      messageId: "r1",
      content: {
        type: "text",
        text:
          "## Result\nAligned the offline queue to the 503 policy per your answer.\n\n" +
          "## Verification\nnpm test -- queue\n\n" +
          "## Needs human decision\nREQUIRED: no\n"
      }
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
});
