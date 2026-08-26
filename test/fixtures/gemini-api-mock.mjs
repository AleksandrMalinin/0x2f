// Gemini API mock — a local stand-in for the Gemini API that lets the REAL
// gemini CLI run end to end without network or credentials, mirroring
// codex-responses-mock.mjs.
//
// The real Gemini CLI (0.57.0) with `security.auth.selectedType=gateway`,
// `useExternal=true`, `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` pointed
// here makes these requests (captured 2026-08 against the real binary):
//
//   1. A model-routing classification: POST /v1beta/models/<flash-lite>:
//      generateContent whose systemInstruction is the "Complexity Score"
//      rubric; the CLI expects a JSON string with `complexity_score` in the
//      candidate text (NumericalClassifierStrategy).
//   2. The main task call: POST /v1beta/models/<main-model>:
//      streamGenerateContent?alt=ss — an SSE stream of candidate chunks
//      ending with finishReason STOP. The CLI concatenates the text into
//      assistant message deltas.

import http from "node:http";

const STOP = "STOP";

function contentResponse(text, finishReason = STOP) {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason
      }
    ],
    usageMetadata: { totalTokenCount: 10, promptTokenCount: 5, candidatesTokenCount: 5 }
  };
}

// The complexity-score JSON the routing classifier parses out of the text.
export function classification() {
  return JSON.stringify({
    complexity_reasoning: "classified by the test mock",
    complexity_score: 10
  });
}

// startGeminiApiMock(steps) -> { url, close, requestLog }
//   steps: array of handlers for the MAIN (non-classifier) requests, in
//   order. The classifier call always answers with `classification()`. Each
//   handler returns either { text } (streamed to the CLI) or
//   { status, message } for a provider-style API error (401 -> the CLI's
//   auth failure path). After the last step, the last handler repeats.
export async function startGeminiApiMock({ steps = [] } = {}) {
  const requestLog = [];
  let stepIndex = 0;
  let server;
  await new Promise(resolve => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* non-JSON body — still record it */
        }
        requestLog.push({ method: req.method, url: req.url, body: parsed });

        const isClassifier =
          typeof parsed?.systemInstruction?.parts?.[0]?.text === "string" &&
          /Complexity Score/i.test(parsed.systemInstruction.parts[0].text);

        const writeJson = (code, obj) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };

        if (isClassifier) {
          writeJson(200, contentResponse(classification()));
          return;
        }

        const handler = steps[stepIndex] ?? { text: "## Result\nno more steps\n## Needs human decision\nNone" };
        stepIndex = Math.min(stepIndex + 1, steps.length - 1);

        if (handler.status) {
          // A provider-style API error (401 -> the CLI's auth failure path).
          writeJson(handler.status, {
            error: { code: handler.status, message: handler.message, status: "INVALID_ARGUMENT" }
          });
          return;
        }

        if (req.url.includes("streamGenerateContent")) {
          // SSE stream the SDK's streamGenerateContent expects: one candidate
          // chunk with the text, then a terminal STOP chunk.
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache"
          });
          res.write(`data: ${JSON.stringify(contentResponse(handler.text ?? ""))}\n\n`);
          res.write(`data: ${JSON.stringify(contentResponse("", STOP))}\n\n`);
          res.end();
          return;
        }

        writeJson(200, contentResponse(handler.text ?? ""));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requestLog,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
