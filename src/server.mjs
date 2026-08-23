// Work local API — the boundary between clients and Work Core.
//
// The browser (and a future TUI/desktop client) speaks HTTP + SSE to this
// server. The server is a thin client of the SHARED Work actions: it parses
// requests, calls actions, and streams normalized events. It contains no
// lifecycle logic, no provider logic, no file mutation of its own — the
// actions (core/actions.mjs) own all of that.
//
//   GET  /api/tasks                -> listWork()
//   GET  /api/tasks/:id            -> getWork(id)        ({ ...task, result })
//   POST /api/tasks                -> createWork({ title, provider? })
//   POST /api/tasks/:id/allow      -> allowWork(id)
//   POST /api/tasks/:id/reject     -> rejectWork(id)
//   POST /api/tasks/:id/close      -> closeWork(id)
//   GET  /api/providers            -> [{ id, displayName, capabilities }]
//                                      (default provider first — the registry
//                                      insertion order IS the default order)
//   GET  /api/events               -> Server-Sent Events (live normalized events)
//   GET  /api/events/history       -> the persisted normalized event log per task
//
// Security (local-first): the server binds to 127.0.0.1 by default. Work is
// deliberately not exposed to the LAN and has no auth in this iteration.
// A future trusted-node topology will need authentication + transport
// security BETWEEN the runtime and remote nodes — that is a future boundary,
// not implemented here.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { createRuntime } from "./runtime.mjs";
import { createTailer } from "./core/events.mjs";
import { WorkError } from "./core/errors.mjs";
import { listProviders } from "./providers/index.mjs";

// The Web surface is served as three static files from src/web/:
//
//   index.html   the shell + the design's styles
//   app.js       the browser client (transport + DOM)
//   ledger.mjs   the pure projection from normalized events to the ledger
//                view model — imported by the browser AND by the Node tests,
//                so the rendering rules have exactly one implementation.
//
// The allowlist below is the whole static story: no directory walking, no
// user-supplied paths, nothing outside src/web can be requested.
const ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app/ledger.mjs": ["ledger.mjs", "text/javascript; charset=utf-8"]
};

async function readAsset(name) {
  return fs.readFile(new URL("./web/" + name, import.meta.url), "utf8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// Read every task's event log once. The tailer diffs against what it has
// already emitted, so this is cheap even on a workspace with many tasks.
function makeReadLines(store) {
  return async () => {
    const dir = store.tasksDir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(dir, entry.name, "events.jsonl");
      try {
        const text = await fs.readFile(logPath, "utf8");
        out.push({ slug: entry.name, text });
      } catch {
        // no event log yet for this task
      }
    }
    return out;
  };
}

// Newest MAX_HISTORY events per task. A long-running task can write a lot of
// progress lines; a surface only ever draws recent work, and an unbounded
// response would punish the client for the runtime's verbosity.
const MAX_HISTORY = 1000;

async function readHistory(store) {
  const tasks = await store.listTasks();
  const out = {};
  for (const task of tasks) {
    const text = await store.readEventLog(task.slug);
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event.type === "string") events.push(event);
      } catch {
        // not a Work event line — ignore, exactly as the tailer does
      }
    }
    out[task.id] = events.slice(-MAX_HISTORY);
  }
  return out;
}

export async function startServer(base = process.cwd(), port = 4242, opts = {}) {
  const runtime = opts.runtime ?? createRuntime(base, opts);
  const { store, actions, events } = runtime;
  const host = opts.host ?? "127.0.0.1";
  const interval = opts.interval ?? 250;

  // One tailer per server: new lines in any task's event log become bus
  // events, so events written by OTHER processes (e.g. `2f allow` in a
  // terminal while this UI is open) reach every connected client.
  const tailer = createTailer({
    interval,
    emit: event => events.emit(event),
    readLines: makeReadLines(store)
  });
  tailer.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      const asset = req.method === "GET" ? ASSETS[url.pathname] : null;
      if (asset) {
        const [name, type] = asset;
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(await readAsset(name));
        return;
      }

      // Live event channel — normalized Work events, SSE format.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");
        const unsubscribe = events.on(event => sendSse(res, event));
        req.on("close", () => unsubscribe());
        return;
      }

      // The persisted history behind /api/events. SSE only carries deltas
      // from the moment a client connects and the tailer never replays, so a
      // client that connects mid-run needs the log it missed. These are the
      // same normalized Work events, read from the same append-only logs the
      // CLI and the worker write — not a second store.
      if (req.method === "GET" && url.pathname === "/api/events/history") {
        json(res, { base: store.base, events: await readHistory(store) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        json(res, await actions.listWork());
        return;
      }

      // Provider registry for clients that need to offer a choice. The shape
      // is normalized (id/displayName/capabilities) — never vendor internals.
      if (req.method === "GET" && url.pathname === "/api/providers") {
        json(
          res,
          listProviders().map(p => ({
            id: p.id,
            displayName: p.displayName,
            capabilities: p.capabilities
          }))
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = JSON.parse(await readBody(req));
        const task = await actions.createWork({
          title: body.title,
          provider: body.provider
        });
        json(res, task, 201);
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (req.method === "GET" && taskMatch) {
        json(res, await actions.getWork(Number(taskMatch[1])));
        return;
      }

      const allowMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/allow$/);
      if (req.method === "POST" && allowMatch) {
        const task = await actions.allowWork(Number(allowMatch[1]));
        json(res, task, 202);
        return;
      }

      const rejectMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reject$/);
      if (req.method === "POST" && rejectMatch) {
        const task = await actions.rejectWork(Number(rejectMatch[1]));
        json(res, task, 202);
        return;
      }

      const closeMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/close$/);
      if (req.method === "POST" && closeMatch) {
        json(res, await actions.closeWork(Number(closeMatch[1])));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      if (error instanceof WorkError) {
        json(res, { error: error.message }, error.status);
      } else {
        json(
          res,
          { error: error instanceof Error ? error.message : String(error) },
          500
        );
      }
    }
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  console.log(`0x2F UI: ${url}`);

  return {
    server,
    url,
    port: actualPort,
    runtime,
    close: async () => {
      tailer.stop();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
