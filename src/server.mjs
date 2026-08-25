// Work local API — the boundary between clients and Work Core.
//
// The browser (and a future TUI/desktop client) speaks HTTP + SSE to this
// server. The server is a thin client of the SHARED Work actions: it parses
// requests, calls actions, and streams normalized events. It contains no
// lifecycle logic, no provider logic, no file mutation of its own — the
// actions (core/actions.mjs) own all of that.
//
//   GET  /api/tasks                -> listWork()
//   GET  /api/tasks/:id            -> getWork(id)        ({ ...task, runs, result })
//   POST /api/tasks                -> createWork({ title, provider? })
//   POST /api/tasks/:id/rerun      -> rerunWork(id, { provider?, model? })
//   GET  /api/tasks/:id/runs/:n    -> getRun(id, n)      ({ ...runRecord, result })
//   POST /api/tasks/:id/allow      -> allowWork(id)
//   POST /api/tasks/:id/reject     -> rejectWork(id)
//   POST /api/tasks/:id/answer     -> answerWork(id, { answer })
//   POST /api/tasks/:id/note       -> noteWork(id, { note })   (task context
//                                      only — no execution is started)
//   POST /api/tasks/:id/close      -> closeWork(id)
//   POST /api/refine               -> refineTaskPrompt({ text })  ({ refined }
//                                      — a pure text transform: no task is
//                                      created, no execution is started)
//   GET  /api/providers            -> [{ id, displayName, integrationType,
//                                      capabilities, available }]
//                                      (default provider first — the registry
//                                      insertion order IS the default order)
//   GET  /api/routing              -> { default, prefer } (AUTO routing config)
//   GET  /api/events               -> Server-Sent Events (live normalized events)
//   GET  /api/events/history       -> the persisted normalized event log per task
//   GET  /api/health               -> { ok, mode } — the unauthenticated probe
//                                      the `2f ui` launcher uses to recognize a
//                                      0x2F runtime (nothing sensitive)
//
// Security (local-first, hardened): the server binds to 127.0.0.1 by default.
// The API is protected by four layers, all enforced HERE at the boundary:
//
//   1. Host allowlist — only Host headers naming 127.0.0.1 / localhost /
//      [::1] are served. A DNS-rebinding page resolves a foreign host to the
//      loopback address, but its Host header is the attacker's name, so it is
//      refused before any routing happens.
//   2. Browser-request validation — an Origin header, when present, must be
//      this server's own origin, and Sec-Fetch-Site (when present) must be
//      same-origin or none. Cross-site "simple requests", form posts and
//      same-site-localhost-page tricks cannot reach the API.
//   3. Per-runtime authentication — every /api/* request must carry the
//      runtime's random auth token, either as the HttpOnly SameSite=Strict
//      cookie the server itself sets when it serves the Web shell (the
//      browser path), or as the x-0x2f-auth header (programmatic path for
//      local scripts/tests). The token is generated per server process.
//   4. Request-body cap — bodies are bounded before any JSON.parse.
//
// Static assets and the shell are served without authentication (Host +
// browser-request checks still apply) so the UI can bootstrap; only /api/*
// is token-gated. `GET /api/health` is deliberately unauthenticated — it
// exists for the launcher probe and leaks nothing.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { createRuntime } from "./runtime.mjs";
import { createTailer } from "./core/events.mjs";
import { WorkError } from "./core/errors.mjs";
import { MAX_BODY_BYTES } from "./core/limits.mjs";

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
  "/app/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app/ledger.mjs": ["ledger.mjs", "text/javascript; charset=utf-8"],
  "/app/sound-policy.mjs": ["sound-policy.mjs", "text/javascript; charset=utf-8"],
  "/app/sound.mjs": ["sound.mjs", "text/javascript; charset=utf-8"]
};

// --- local-boundary security ------------------------------------------------
//
// The four layers from the header comment. Everything is per-server-process:
// the auth token is generated once per runtime, so a stale browser cookie
// (from a previous runtime) simply fails closed until the shell is reloaded
// and re-issues the current token.

// Hosts a local 0x2F server will answer for. DNS rebinding depends on the
// attacker's hostname reaching this process; none of these names can be
// resolved to the loopback address by an attacker.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// The per-runtime credential: carried by the HttpOnly SameSite=Strict cookie
// the shell sets (browser path) or the x-0x2f-auth header (programmatic
// path). Same value, same gate.
const AUTH_COOKIE = "0x2f_auth";
const AUTH_HEADER = "x-0x2f-auth";

// Restrictive CSP for the Web surface. The client is module scripts + CSS +
// fetch/EventSource, all same-origin; it renders with textContent only and
// plays a synthesized Web Audio slash (no assets, no media, no frames).
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

function parseCookies(req) {
  const out = {};
  try {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  } catch {
    /* malformed cookie — treat as no cookie */
  }
  return out;
}

function requestHostname(req) {
  const host = (req.headers.host ?? "").trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon > 0 ? host.slice(0, colon) : host;
}

// Layer 1: the Host header must name a loopback host. Answers the request
// (403) and returns false when the request is refused.
function guardHost(req, res) {
  if (!LOOPBACK_HOSTS.has(requestHostname(req))) {
    json(res, { error: "Forbidden — 0x2F only serves its own loopback origin." }, 403);
    return false;
  }
  return true;
}

// Layer 2a: a present Origin header must be THIS server's own origin —
// `http://` + the request's own (already Host-allowlisted) host:port.
// Browsers send Origin on cross-origin requests and on same-origin POSTs;
// non-browser clients omit it. Deriving from the Host header (instead of the
// bound port) keeps the check exact for every loopback alias and port.
function guardOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    json(res, { error: "Forbidden — bad Origin header." }, 403);
    return false;
  }
  const expected = `http://${(req.headers.host ?? "").trim().toLowerCase()}`;
  if (parsed.protocol !== "http:" || origin.toLowerCase() !== expected) {
    json(res, { error: "Forbidden — cross-origin request." }, 403);
    return false;
  }
  return true;
}

// Layer 2b: browsers attach Sec-Fetch-Site to every request they make.
// Anything other than same-origin/none is a cross-site or same-site-foreign-
// page request and is refused — this closes the gap where SameSite cookies
// ignore ports (a page on another local port is "same-site" but is not us).
function guardFetchSite(req, res) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    json(res, { error: "Forbidden — cross-site request." }, 403);
    return false;
  }
  return true;
}

// Layer 3: /api/* requires the per-runtime token, as cookie or header.
function isAuthenticated(req, token) {
  if (parseCookies(req)[AUTH_COOKIE] === token) return true;
  const header = req.headers[AUTH_HEADER];
  return typeof header === "string" && header === token;
}

function requireAuth(req, res, token) {
  if (isAuthenticated(req, token)) return true;
  json(res, { error: "Unauthorized — this is a local 0x2F API; open the 0x2F UI from this machine." }, 401);
  return false;
}

async function readAsset(name) {
  return fs.readFile(new URL("./web/" + name, import.meta.url), "utf8");
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  // Layer 4: bounded bodies. Refuse by declared length when present (cheap),
  // and stop reading if a streamed body outgrows the cap.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WorkError(
      `Request body too large (max ${maxBytes} bytes).`,
      413
    );
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new WorkError(
        `Request body too large (max ${maxBytes} bytes).`,
        413
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS
  });
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

  // The per-runtime credential. Random per process (or injected by tests).
  const authToken = opts.authToken ?? crypto.randomBytes(32).toString("base64url");

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

      // Local-boundary gate: Host allowlist, Origin, Sec-Fetch-Site. Runs
      // before ANY routing — a refused request never reaches a handler.
      if (!guardHost(req, res)) return;
      if (!guardOrigin(req, res)) return;
      if (!guardFetchSite(req, res)) return;

      // The Web shell. Setting the auth cookie here is the bootstrap: the
      // browser stores it (HttpOnly, SameSite=Strict) and attaches it to the
      // same-origin /api/* requests that follow — including the SSE stream,
      // which cannot carry custom headers.
      if (req.method === "GET" && url.pathname === "/") {
        const [name, type] = ASSETS["/"];
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          ...SECURITY_HEADERS,
          "set-cookie":
            `${AUTH_COOKIE}=${authToken}; Path=/; HttpOnly; SameSite=Strict`
        });
        res.end(await readAsset(name));
        return;
      }

      const asset = req.method === "GET" ? ASSETS[url.pathname] : null;
      if (asset) {
        const [name, type] = asset;
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          ...SECURITY_HEADERS
        });
        res.end(await readAsset(name));
        return;
      }

      // The launcher probe: unauthenticated by design, leaks nothing beyond
      // "this is the local 0x2F runtime". `2f ui` uses it to distinguish a
      // healthy 0x2F runtime from "another process owns the port".
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, { ok: true, mode: "local" });
        return;
      }

      // Everything under /api/ (except /api/health) requires the token.
      if (url.pathname.startsWith("/api/") && !requireAuth(req, res, authToken)) return;

      // Surface descriptor: how this server is reached. The local server is
      // always "local" and its Mac is always "online"; the relay serves the
      // same client with mode "relay" and a real online/offline signal, so
      // the web client can tell where it is running and disable actions when
      // the Mac cannot be reached.
      if (req.method === "GET" && url.pathname === "/api/status") {
        json(res, { mode: "local", mac: "online", base: store.base });
        return;
      }

      // Live event channel — normalized Work events, SSE format.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...SECURITY_HEADERS
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
      // is normalized — id/displayName/integrationType/capabilities/available
      // — never vendor internals, and never a hint about how the provider was
      // created (native, ACP or command all look the same to a client).
      // AUTO routing configuration for clients that offer provider choice.
      // The client uses `default` to preselect (AUTO or a provider id) and
      // `prefer` is informational. Normalized, never raw config.
      if (req.method === "GET" && url.pathname === "/api/routing") {
        const config = runtime.router.config;
        json(res, {
          default: config?.default ?? runtime.providers.defaultProviderId,
          prefer: config?.prefer ?? []
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/providers") {
        json(
          res,
          runtime.providers.listProviders().map(p => ({
            id: p.id,
            displayName: p.displayName,
            integrationType: p.integrationType,
            capabilities: p.capabilities,
            // Deterministic and cheap: whether the configured executable can
            // be resolved. Never spawns.
            available: runtime.providers.available(p.id)
          }))
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = JSON.parse(await readBody(req));
        const task = await actions.createWork({
          title: body.title,
          provider: body.provider,
          model: body.model
        });
        json(res, task, 201);
        return;
      }

      // Refine a rough task note into a stronger execution brief — a PURE
      // text transform, deliberately outside the Task lifecycle: no task is
      // created, no execution is started, nothing is persisted. The client
      // keeps the refined text in the composer; the task is still created by
      // the user pressing START (POST /api/tasks). The refinement model path
      // is the refiner's concern (runtime.refine), not the API's.
      if (req.method === "POST" && url.pathname === "/api/refine") {
        const body = JSON.parse(await readBody(req));
        const refined = await runtime.refine.refineTaskPrompt(body.text);
        json(res, { refined });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (req.method === "GET" && taskMatch) {
        json(res, await actions.getWork(Number(taskMatch[1])));
        return;
      }

      // Run history: rerun the SAME task as a new run (same intent, another
      // provider), and read one run's factual detail. Both are thin clients
      // of the shared actions — the CLI offers the same two operations.
      const rerunMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/rerun$/);
      if (req.method === "POST" && rerunMatch) {
        const body = JSON.parse(await readBody(req));
        const task = await actions.rerunWork(Number(rerunMatch[1]), {
          provider: body.provider,
          model: body.model
        });
        json(res, task, 201);
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/runs\/(\d+)$/);
      if (req.method === "GET" && runMatch) {
        json(res, await actions.getRun(Number(runMatch[1]), Number(runMatch[2])));
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

      // Answer a needs_you/decision block: the human's response to a question
      // (a decision is answered, never allowed/rejected — allow/reject are
      // for permissions). The answer is persisted with the task.
      const answerMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/answer$/);
      if (req.method === "POST" && answerMatch) {
        const body = JSON.parse(await readBody(req));
        const task = await actions.answerWork(Number(answerMatch[1]), {
          answer: body.answer
        });
        json(res, task, 202);
        return;
      }

      // Record a user constraint/correction on the task (Task context — no
      // execution). The task's next run rebuilds its input from Task state,
      // so the note reaches the next provider session automatically.
      const noteMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/note$/);
      if (req.method === "POST" && noteMatch) {
        const body = JSON.parse(await readBody(req));
        const task = await actions.noteWork(Number(noteMatch[1]), {
          note: body.note
        });
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

  // Bind. On failure (e.g. EADDRINUSE) reject with a clear error instead of
  // leaving an unhandled 'error' event — the CLI and `2f ui` distinguish "0x2F
  // already running" from "another process owns the port" from this signal.
  // The tailer must stop on failure too: a rejected startServer is not a
  // server, and a running interval would keep the process alive forever.
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("error", onError);
      tailer.stop();
      if (error?.code === "EADDRINUSE") {
        const wrapped = new Error(
          `Port ${port} is already in use — another process is listening on ${host}:${port}.`
        );
        wrapped.code = "EADDRINUSE";
        reject(wrapped);
      } else {
        reject(error);
      }
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
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
