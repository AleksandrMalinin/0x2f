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
//   POST /api/tasks                -> createWork({ brief, provider? })
//                                      `brief` is the user's full task text;
//                                      the short display title is derived
//                                      from it (core/title.mjs), never sent
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
//      [::1] are served, PLUS, only while LAN pairing is active (`2f pair`,
//      v0.5), private-LAN hosts — and even then only the BOUNDED LAN surface
//      below, never the local API. A DNS-rebinding page resolves a foreign
//      host to the loopback address, but its Host header is the attacker's
//      name, so it is refused before any routing happens.
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
// LAN-first pairing (v0.5): `2f pair` is the ONLY thing that turns the LAN
// surface on. When it does, the runtime is started with LAN mode: it binds
// all interfaces and serves private-LAN hosts ONLY the static client (the
// pairing page + app) and an in-process instance of the RELAY protocol — the
// phone talks to the Mac directly through the exact protocol the hosted
// relay speaks, so the existing pairing client and E2E encrypted channel are
// reused unchanged. The normal local API (/api/tasks, /api/providers, …) is
// never served to LAN hosts, and `2f pair --off` closes the LAN surface
// within a second. The relay's own protections (one-time token, session
// bearer, GCM envelopes, rate limits) all apply on the LAN surface.
//
// Two properties every client can rely on:
//
//   * Every response is valid JSON. Failures are `{ error }` objects with a
//     real status — never an empty body, never bare text — so a client can
//     parse unconditionally.
//   * POSTs are idempotent when they carry `x-0x2f-request-id`. The same key
//     executes once; a retry replays the first attempt's exact answer. This
//     mirrors the relay agent's ack cache, so a double tap or a retry after an
//     ambiguous failure cannot start a second run of a task.
//
// Static assets and the shell are served without authentication (Host +
// browser-request checks still apply) so the UI can bootstrap; only /api/*
// is token-gated. `GET /api/health` is deliberately unauthenticated — it
// exists for the launcher probe and leaks nothing.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { createRuntime } from "./runtime.mjs";
import { deriveWorkspace } from "./project.mjs";
import { createTailer } from "./core/events.mjs";
import { WorkError } from "./core/errors.mjs";
import { MAX_BODY_BYTES } from "./core/limits.mjs";
import { createRelayServer } from "./relay/server.mjs";
import { isPrivateLanIp } from "./relay/lan.mjs";

// The Web surface is served as static files from src/ — the shell and the
// browser client from src/web/, plus the relay client protocol module the
// browser's E2E envelope code imports (src/relay/protocol.mjs). Values are
// [src-relative path, mime]:
//
//   /                index.html   the shell + the design's styles
//   /app/app.js      the browser client (transport + DOM)
//   /app/ledger.mjs  the pure projection from normalized events to the
//                    ledger view model — imported by the browser AND by the
//                    Node tests, so the rendering rules have exactly one
//                    implementation.
//
// The allowlist below is the whole static story: no directory walking, no
// user-supplied paths, nothing outside these exact entries can be requested.
//
// Vendored pure-JS crypto (scripts/vendor-crypto.mjs) — the transitive file
// graph of @noble/hashes + @noble/ciphers that e2e.mjs needs when WebCrypto
// is unavailable. Kept in sync with scripts/vendor-crypto.mjs and
// deploy/client/build.mjs.
const VENDOR_CRYPTO_FILES = [
  "@noble/hashes/pbkdf2.js",
  "@noble/hashes/sha2.js",
  "@noble/hashes/_md.js",
  "@noble/hashes/_u64.js",
  "@noble/hashes/crypto.js",
  "@noble/hashes/hmac.js",
  "@noble/hashes/utils.js",
  "@noble/ciphers/aes.js",
  "@noble/ciphers/_polyval.js",
  "@noble/ciphers/utils.js"
];

const ASSETS = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/pair": ["web/pair.html", "text/html; charset=utf-8"],
  "/app/app.css": ["web/app.css", "text/css; charset=utf-8"],
  "/app/app.js": ["web/app.js", "text/javascript; charset=utf-8"],
  "/app/e2e.mjs": ["web/e2e.mjs", "text/javascript; charset=utf-8"],
  "/app/pair.mjs": ["web/pair.mjs", "text/javascript; charset=utf-8"],
  "/app/pair.css": ["web/pair.css", "text/css; charset=utf-8"],
  "/app/remote.mjs": ["web/remote.mjs", "text/javascript; charset=utf-8"],
  "/app/ledger.mjs": ["web/ledger.mjs", "text/javascript; charset=utf-8"],
  "/app/sound-policy.mjs": ["web/sound-policy.mjs", "text/javascript; charset=utf-8"],
  "/app/sound.mjs": ["web/sound.mjs", "text/javascript; charset=utf-8"],
  // The browser's E2E envelope code (e2e.mjs) imports this shared protocol
  // module; without it the whole client module graph fails and the UI
  // renders blank. The relay SERVER is never served — only this client-side
  // wire-contract module, which the local product ships anyway.
  "/relay/protocol.mjs": ["relay/protocol.mjs", "text/javascript; charset=utf-8"],
  // Task title derivation. Core persists the derived title; the client
  // re-derives to decide whether a detail view still needs to show the
  // brief. Serving the same module (imported as "../core/title.mjs", which
  // resolves in Node AND from /app/ledger.mjs in the browser) is what keeps
  // those two from drifting — the same reason ledger.mjs itself is shared.
  // It is a pure string function: no store, no fs, no secrets.
  "/core/title.mjs": ["core/title.mjs", "text/javascript; charset=utf-8"],
  // The pure-JS crypto fallback (see src/web/e2e.mjs): WebCrypto's subtle API
  // is unavailable in insecure contexts, so a phone on a plain-http LAN page
  // imports these vendored modules. Kept in sync with scripts/vendor-crypto.mjs.
  ...Object.fromEntries(
    VENDOR_CRYPTO_FILES.map(file => [
      "/app/vendor/" + file,
      ["web/vendor/" + file, "text/javascript; charset=utf-8"]
    ])
  )
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

// How stale the LAN-mode config check may be. `2f pair --off` writes
// enabled:false and the LAN surface closes within ~this long.
const LAN_GATE_TTL_MS = 1000;

// The per-runtime credential: carried by the HttpOnly SameSite=Strict cookie
// the shell sets (browser path) or the x-0x2f-auth header (programmatic
// path). Same value, same gate.
const AUTH_COOKIE = "0x2f_auth";
const AUTH_HEADER = "x-0x2f-auth";

// Restrictive CSP for the Web surface. The client is module scripts + CSS +
// fetch/EventSource, all same-origin in LOCAL mode; in REMOTE mode the same
// client (served from this origin or a static client host) talks to the
// user-configured relay origin, so connect-src is loosened to any http(s)/ws
// endpoint. script-src/style-src 'self' remain the hard boundary against
// injected code; the client renders with textContent only and plays a
// synthesized Web Audio slash (no assets, no media, no frames).
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' http: https: ws: wss:",
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

// Layer 1 (LAN-aware): a request is served only when its Host header names a
// loopback host, OR a private-LAN host while LAN pairing is active (checked
// against the live config, so `2f pair --off` closes the LAN surface quickly).
// `lanRelay` is the mounted in-process relay (present only in LAN mode).
async function guardHostLan(req, res, lanRelay, lanEnabledNow) {
  const hostname = requestHostname(req);
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (lanRelay && isPrivateLanIp(hostname) && (await lanEnabledNow())) return true;
  json(res, { error: "Forbidden — 0x2F only serves its own loopback origin." }, 403);
  return false;
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
  return fs.readFile(new URL("./" + name, import.meta.url), "utf8");
}

// --- workspace identity (dogfood review §02) --------------------------------
//
// The chrome already answers "which machine" (the runtime host) and never
// answered "which checkout" — two 0x2F tabs against different repositories
// are visually identical. `base` was already returned by /api/status, but
// nothing rendered it. The derivation itself lives in project.mjs, so the
// Web shell and the TUI name the same checkout the same way.

// "Which machine" for a message that must say so ("<provider> needs to be
// re-authenticated on <node>" — §01). os.hostname() works with no pairing
// required, unlike the paired-only relay agent name (src/relay/pair.mjs),
// so a purely local, never-paired runtime still gets a real machine name
// instead of the browser's connection target (which is meaningless here —
// 127.0.0.1 is not a machine identity).
function localNodeLabel() {
  try {
    return os.hostname() || "this machine";
  } catch {
    return "this machine";
  }
}

// The Web shell, with the workspace/node bootstrap injected. The client
// needs the workspace label before its first paint — waiting for the first
// /api/status poll would flicker the identity in exactly the moment it is
// needed — so it is embedded directly in the HTML response, alongside the
// auth cookie, rather than fetched.
//
// A <meta> tag, not an inline <script>: the CSP this server sends is
// deliberately `script-src 'self'` with no 'unsafe-inline' (see CSP below) —
// an inline bootstrap script would be silently blocked by the app's own
// security boundary and never run. A meta tag is plain markup, not
// executable content, so it needs no CSP exception; app.js reads it
// synchronously from `document` before its first render. The content
// attribute is HTML-escaped by the same `el()`-style rule the rest of the
// client follows — quotes and `<`/`&` cannot break out of the attribute.
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

async function readShell(base) {
  const html = await readAsset(ASSETS["/"][0]);
  const bootstrap = JSON.stringify({
    workspace: deriveWorkspace(base),
    node: localNodeLabel()
  });
  const meta = `<meta name="0x2f-bootstrap" content="${escapeAttr(bootstrap)}">`;
  return html.replace("</head>", `${meta}\n</head>`);
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

// Every mutating route reads its parameters from a JSON body, but several of
// them are legitimately body-less: SEND BACK (rerun with no provider override),
// like ALLOW/REJECT/CLOSE, is a bare POST. `JSON.parse("")` throws
// `Unexpected end of JSON input`, which surfaced to the user as a generic 500
// and made SEND BACK unusable from the Web UI. An absent body is an empty
// parameter set; a malformed one is the client's error (400), never a 500.
async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const text = (await readBody(req, maxBytes)).trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkError("Request body is not valid JSON.", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkError("Request body must be a JSON object.", 400);
  }
  return parsed;
}

// Every API response is produced here, so this is the one place that can
// observe what a route answered — the idempotency layer below hooks it to
// remember a mutation's result without any route knowing about replay.
const SENT_HOOK = Symbol("0x2f.sent");

function json(res, value, status = 200) {
  res[SENT_HOOK]?.(status, value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS
  });
  res.end(JSON.stringify(value));
}

// --- idempotent mutations ---------------------------------------------------
//
// The Web client mints a unique key per mutating request (x-0x2f-request-id).
// The relay agent has always honored it through its persisted ack cache; the
// LOCAL server ignored it, so a double tap or a retry after an ambiguous
// failure could start a second run of the same task. This is the local
// counterpart: same key -> same answer, executed exactly once.
//
// In-memory and bounded — a local server process is the trust and lifetime
// boundary here, and a key is only useful for as long as a client might retry
// it. Entries hold the in-flight promise, so a duplicate that arrives while
// the first is still executing waits for it instead of racing it.
const IDEMPOTENCY_HEADER = "x-0x2f-request-id";
const MAX_IDEMPOTENCY_KEYS = 512;

function createIdempotencyCache(limit = MAX_IDEMPOTENCY_KEYS) {
  const entries = new Map();
  return {
    get: key => entries.get(key),
    set(key, pending) {
      entries.set(key, pending);
      // Oldest-first eviction: Map preserves insertion order.
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    drop: key => entries.delete(key)
  };
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// Read every task's event log once. The tailer diffs against what it has
// already emitted, so this is cheap even on a workspace with many tasks.
// The read itself belongs to the store (the only module that knows the
// `.work` layout) — the TUI tails the same logs through the same call.
function makeReadLines(store) {
  return () => store.readEventLogs();
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
  // LAN mode (`2f pair`): bind all interfaces so the phone on the same Wi-Fi
  // can reach the pairing surface; the per-request gate still restricts what
  // LAN hosts are served. Loopback-only remains the default for everything
  // else (plain `2f` / `2f ui`).
  const lan = opts.lan === true;
  const host = lan ? "0.0.0.0" : (opts.host ?? "127.0.0.1");
  const interval = opts.interval ?? 250;
  const lanGateTtlMs = opts.lanGateTtlMs ?? LAN_GATE_TTL_MS;

  // The per-runtime credential. Random per process (or injected by tests).
  const authToken = opts.authToken ?? crypto.randomBytes(32).toString("base64url");

  // LAN mode: an in-process instance of the relay protocol, MOUNTED on this
  // server (it never listens on its own socket). The phone on the same Wi-Fi
  // talks to the Mac through the exact protocol the hosted relay speaks —
  // one remote-control implementation, two transports. Its credential state
  // (tokens, sessions, device identity) persists in .work/relay-state.json,
  // mode 0600, exactly like the standalone relay's state file.
  let lanRelay = null;
  let lanGateCache = { at: 0, enabled: false };
  async function lanEnabledNow() {
    const cfgPath = path.join(base, ".work", "relay.json");
    const nowMs = Date.now();
    if (nowMs - lanGateCache.at >= lanGateTtlMs) {
      try {
        const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
        lanGateCache = { at: nowMs, enabled: cfg?.enabled === true && cfg?.transport === "lan" };
      } catch {
        lanGateCache = { at: nowMs, enabled: false };
      }
    }
    return lanGateCache.enabled;
  }
  if (lan) {
    lanRelay = await createRelayServer({
      dataFile: path.join(base, ".work", "relay-state.json"),
      host: "127.0.0.1",
      port: 0,
      mount: true,
      log: opts.relayLog ?? console
    }).start();
  }

  // One tailer per server: new lines in any task's event log become bus
  // events, so events written by OTHER processes (e.g. `2f allow` in a
  // terminal while this UI is open) reach every connected client.
  const tailer = createTailer({
    interval,
    emit: event => events.emit(event),
    readLines: makeReadLines(store)
  });
  tailer.start();

  const idempotency = createIdempotencyCache();

  const route = async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      // Local-boundary gate: Host allowlist (loopback, or private-LAN while
      // LAN pairing is active), then Origin, then Sec-Fetch-Site. Runs before
      // ANY routing — a refused request never reaches a handler.
      if (!(await guardHostLan(req, res, lanRelay, lanEnabledNow))) return;
      if (!guardOrigin(req, res)) return;
      if (!guardFetchSite(req, res)) return;

      // LAN surface: a phone on the same Wi-Fi gets ONLY the static client
      // (pairing page + app) and the mounted relay protocol — never the local
      // API. The shell carries no auth cookie here: the LAN client uses the
      // relay session, not the per-runtime token.
      if (lanRelay && isPrivateLanIp(requestHostname(req))) {
        if (req.method === "GET" && (url.pathname === "/" || ASSETS[url.pathname])) {
          if (url.pathname === "/") {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              ...SECURITY_HEADERS
            });
            res.end(await readShell(store.base));
          } else {
            const [name, type] = ASSETS[url.pathname];
            res.writeHead(200, {
              "content-type": type,
              "cache-control": "no-store",
              ...SECURITY_HEADERS
            });
            res.end(await readAsset(name));
          }
          return;
        }
        return lanRelay.handler(req, res);
      }

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
        res.end(await readShell(store.base));
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
      // "this is the local 0x2F runtime" (the workspace path is only visible
      // to loopback callers; LAN hosts never reach this route). `2f ui` uses
      // it to distinguish a healthy 0x2F runtime from "another process owns
      // the port". `lan` tells `2f pair` whether an already-running runtime
      // has the LAN surface mounted; `base` tells it whether that runtime
      // belongs to THIS workspace (a foreign runtime on the port must not be
      // restarted — the pairing falls back to another port instead).
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, {
          ok: true,
          mode: "local",
          base: store.base,
          ...(lanRelay ? { lan: true } : {})
        });
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
        json(res, {
          mode: "local",
          mac: "online",
          base: store.base,
          workspace: deriveWorkspace(store.base),
          node: localNodeLabel()
        });
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
        const body = await readJsonBody(req);
        const task = await actions.createWork({
          brief: body.brief,
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
        const body = await readJsonBody(req);
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
        const body = await readJsonBody(req);
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
        const body = await readJsonBody(req);
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
        const body = await readJsonBody(req);
        const task = await actions.noteWork(Number(noteMatch[1]), {
          note: body.note
        });
        json(res, task, 202);
        return;
      }

      // SEND BACK's correction: the same task-context channel as a note, but
      // recorded as its own normalized event (task.corrected) so every
      // surface can tell a correction from a note or an answer.
      const correctMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/correct$/);
      if (req.method === "POST" && correctMatch) {
        const body = await readJsonBody(req);
        const task = await actions.correctWork(Number(correctMatch[1]), {
          correction: body.correction
        });
        json(res, task, 202);
        return;
      }

      const closeMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/close$/);
      if (req.method === "POST" && closeMatch) {
        json(res, await actions.closeWork(Number(closeMatch[1])));
        return;
      }

      // Every failure the API can produce is a JSON object with an `error`
      // string — a client that always parses JSON never meets a partial body.
      json(res, { error: `No such endpoint: ${req.method} ${url.pathname}` }, 404);
      return;
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
  };

  const server = http.createServer(async (req, res) => {
    const key = req.method === "POST" ? req.headers[IDEMPOTENCY_HEADER] : null;
    if (typeof key !== "string" || !key) return route(req, res);

    const inFlight = idempotency.get(key);
    if (inFlight) {
      // Same key seen before: replay the first attempt's exact answer rather
      // than executing the mutation a second time. A duplicate that arrives
      // mid-execution awaits the original instead of racing it.
      const first = await inFlight;
      if (first) {
        json(res, first.value, first.status);
        return;
      }
    }

    let settle;
    idempotency.set(key, new Promise(resolve => { settle = resolve; }));
    let answered = null;
    res[SENT_HOOK] = (status, value) => { answered = { status, value }; };
    try {
      await route(req, res);
    } finally {
      // A request that produced no JSON answer is not replayable — forget the
      // key so a retry is a fresh attempt rather than a hang.
      if (!answered) idempotency.drop(key);
      settle(answered);
    }
  });

  // WebSocket upgrades: only the Mac's relay agent upgrades (its outbound
  // /ws channel). In LAN mode the agent connects to THIS server; the mounted
  // relay authenticates the deviceSecret and handles the upgrade. Without
  // LAN mode there is no /ws surface at all.
  server.on("upgrade", (req, socket, head) => {
    if (lanRelay) return lanRelay.handleUpgrade(req, socket, head);
    socket.destroy();
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
    // The mounted LAN relay (null when LAN mode is off) — exposes its state
    // for tests and operators.
    relay: lanRelay,
    close: async () => {
      tailer.stop();
      if (lanRelay) await lanRelay.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
