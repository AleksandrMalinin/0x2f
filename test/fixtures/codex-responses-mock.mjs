// Deterministic mock of the OpenAI Responses API for real-CLI integration
// tests. Codex talks to its model provider over the Responses wire API
// (wire_api = "responses"); this server answers with scripted SSE streams so
// the REAL codex binary can be driven end-to-end without network access.
//
// Usage:
//
//   const mock = await startCodexResponsesMock([{ events: [...] }, ...]);
//   // write $CODEX_HOME/config.toml with base_url = mock.url + "/v1"
//   const outcome = await runTaskThroughCodex(...);
//   await mock.close();
//
// Each step is one streaming response, served per POST /v1/responses in
// order and replayed from the start once exhausted (Codex retries failed
// turns with identical requests). A step is:
//
//   { events: [ {event, data}, ... ] }   // SSE events
//   { error: { status, message } }       // HTTP error
//
// Requests are recorded in mock.requests for assertions.

import http from "node:http";

const MODEL = {
  slug: "gpt-5.1-codex",
  display_name: "Mock Codex",
  description: "Mock model for smoke tests",
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  support_verbosity: true,
  model_messages: { instructions_template: "You are Codex, a mock coding agent." }
};

export function messageStream(text, { responseId = "resp_mock", itemId = "msg_mock" } = {}) {
  return [
    { event: "response.created", data: { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model: "gpt-5.1-codex", output: [], parallel_tool_calls: true, tools: [] } } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] } } },
    { event: "response.content_part.added", data: { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text } },
    { event: "response.output_text.done", data: { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text } },
    { event: "response.content_part.done", data: { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } } },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } } },
    { event: "response.completed", data: { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model: "gpt-5.1-codex", output: [{ id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] } } }
  ];
}

export function commandExecutionStream({ command, output = "ok\n", exitCode = 0, responseId = "resp_tool" }) {
  const args = JSON.stringify({ cmd: command });
  return [
    { event: "response.created", data: { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model: "gpt-5.1-codex", output: [], parallel_tool_calls: true, tools: [] } } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { id: "fc_tool", type: "function_call", name: "exec_command", arguments: "", call_id: "call_tool", status: "in_progress" } } },
    { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_tool", output_index: 0, delta: args } },
    { event: "response.function_call_arguments.done", data: { type: "response.function_call_arguments.done", item_id: "fc_tool", output_index: 0, arguments: args } },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { id: "fc_tool", type: "function_call", name: "exec_command", arguments: args, call_id: "call_tool", status: "completed" } } },
    { event: "response.completed", data: { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model: "gpt-5.1-codex", output: [{ id: "fc_tool", type: "function_call", name: "exec_command", arguments: args, call_id: "call_tool", status: "completed" }] } } }
  ];
}

export function startCodexResponsesMock(steps = []) {
  let stepIndex = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        /* not json */
      }
      requests.push({
        ts: Date.now(),
        method: req.method,
        url: req.url,
        body: parsed
      });

      if (req.url.startsWith("/v1/models") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [MODEL] }));
        return;
      }

      if (req.url.startsWith("/v1/responses") && req.method === "POST") {
        const step = steps.length
          ? steps[Math.min(stepIndex, steps.length - 1)]
          : { events: messageStream("Hello from mock!") };
        stepIndex += 1;
        if (step.error) {
          res.writeHead(step.error.status || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: step.error.message, type: "mock_error", code: null } }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        for (const { event, data } of step.events ?? []) {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${req.url}` } }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
