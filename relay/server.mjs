// 0x2F Relay — the connectivity/control layer between a phone browser and a
// local 0x2F runtime on the Mac.
//
//   Phone browser ── HTTPS (existing API semantics) ──► 0x2F Relay ◄── outbound
//                                                          WebSocket ── Mac
//
// Principles:
//   Local 0x2F owns work.   Relay owns connectivity.   Web owns control.
//
// The relay is deliberately NOT cloud 0x2f:
//   - it never sees provider credentials, repository contents, or execution;
//   - it holds only a BOUNDED last-known snapshot/event cache per device,
//     restored from the Mac's canonical state on every reconnect;
//   - it is disposable — Task state lives on the Mac, never here;
//   - pairing is a one-time token flow, no accounts.
//
// Security boundary (documented, not pretended otherwise): the relay
// necessarily observes the Task/control information required to render the
// remote surface — task status, normalized events, result/progress text, file
// paths, NEEDS YOU details. That is what it forwards. It must NOT receive
// provider credentials, arbitrary repository contents, or execution authority
// independent of the connected Mac.
//
// Routes:
//   GET  /pair/:token            one-time pairing page (public)
//   GET  /api/pair/:token        { registered, claimed, expiresAt } (public)
//   POST /api/pair/claim         { token } -> session cookie, consumes token
//   GET  /                       app shell (paired) or pairing landing page
//   GET  /app/*                  web assets (the same src/web/ client)
//   GET  /api/status             { mode: "relay", mac: online|offline, base }
//   ...the rest of the local API contract, proxied to the Mac:
//   GET  /api/tasks, /api/tasks/:id, /api/tasks/:id/runs/:n
//   POST /api/tasks, /api/tasks/:id/{allow,reject,answer,note,close,rerun}
//   POST /api/refine
//   GET  /api/events             SSE (live normalized events)
//   GET  /api/events/history     bounded last-known event cache
//   GET  /api/providers, /api/routing   (cached from the agent's hello)
//
// Reads: forwarded to the Mac when it is online; served from the last-known
// cache (stale marker header) when it is offline. Mutating commands: never
// queued — while the Mac is offline they fail immediately with 503, because
// "user taps SEND BACK now and it unexpectedly executes 15 minutes later" is
// worse than explicit unavailability.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  API_VERSION,
  COMMAND_OPS,
  makeFrame,
  parseFrame
} from "../src/relay/protocol.mjs";

const SESSION_COOKIE = "0x2f_session";
const MAX_EVENTS_PER_TASK = 1000;
const MAX_EVENTS_TOTAL = 20000;
const COMMAND_TIMEOUT_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const PAIR_TTL_MS = 10 * 60 * 1000;

const ASSETS = {
  "/app/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app/ledger.mjs": ["ledger.mjs", "text/javascript; charset=utf-8"],
  "/app/sound-policy.mjs": ["sound-policy.mjs", "text/javascript; charset=utf-8"],
  "/app/sound.mjs": ["sound.mjs", "text/javascript; charset=utf-8"]
};

// Same restrictive CSP the local runtime applies to the shared web client.
// The pairing pages below are NOT covered: they legitimately use inline
// scripts/styles and are served from this file, not from src/web/.
const WEB_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "media-src 'none'; object-src 'none'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export function createRelayServer({
  webDir = path.resolve(fileURLToPath(new URL("../src/web/", import.meta.url))),
  dataFile = null,
  host = "127.0.0.1",
  port = 0,
  log = console,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  saveDelayMs = 500
} = {}) {
  const devices = new Map(); // deviceId -> device state (below)
  const tokens = new Map(); // pairing token -> { deviceId, expiresAt, claimed }
  const sessions = new Map(); // session secret -> deviceId
  const pending = new Map(); // requestId -> { deviceId, resolvers: [], timer }
  const sseClients = new Map(); // deviceId -> Set<http.ServerResponse>

  // device = {
  //   deviceSecret, online, ws, base, tasks, providers, routing,
  //   events: Map<taskId, event[]>, seen: Set, sessions: Set, lastSeenAt
  // }

  // --- persistence (the relay is disposable; this file only survives its own
  // restart — tokens, sessions and the last-known cache. Task state is never
  // here and always restorable from the Mac.) --------------------------------

  let saveTimer = null;

  function scheduleSave() {
    if (!dataFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushSave().catch(() => {});
    }, saveDelayMs);
  }

  async function flushSave() {
    if (!dataFile) return;
    const snapshot = {
      version: 1,
      tokens: Object.fromEntries([...tokens.entries()].map(([t, v]) => [t, v])),
      sessions: Object.fromEntries([...sessions.entries()]),
      devices: Object.fromEntries(
        [...devices.entries()].map(([id, d]) => [
          id,
          {
            deviceSecret: d.deviceSecret,
            base: d.base,
            tasks: d.tasks,
            providers: d.providers,
            routing: d.routing,
            events: Object.fromEntries([...d.events.entries()]),
            lastSeenAt: d.lastSeenAt
          }
        ])
      )
    };
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.writeFile(dataFile, JSON.stringify(snapshot) + "\n", "utf8");
  }

  async function loadState() {
    if (!dataFile) return;
    let raw;
    try {
      raw = await fs.readFile(dataFile, "utf8");
    } catch {
      return; // no persisted state yet
    }
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      return;
    }
    for (const [token, v] of Object.entries(saved.tokens ?? {})) {
      tokens.set(token, v);
    }
    for (const [session, deviceId] of Object.entries(saved.sessions ?? {})) {
      sessions.set(session, deviceId);
    }
    for (const [id, d] of Object.entries(saved.devices ?? {})) {
      const events = new Map();
      for (const [taskId, list] of Object.entries(d.events ?? {})) {
        events.set(taskId, Array.isArray(list) ? list.slice(-MAX_EVENTS_PER_TASK) : []);
      }
      devices.set(id, {
        deviceSecret: d.deviceSecret ?? "",
        online: false,
        ws: null,
        base: d.base ?? "",
        tasks: Array.isArray(d.tasks) ? d.tasks : [],
        providers: Array.isArray(d.providers) ? d.providers : [],
        routing: d.routing ?? {},
        events,
        seen: new Set(),
        sessions: new Set(),
        lastSeenAt: d.lastSeenAt ?? null
      });
    }
  }

  // --- helpers --------------------------------------------------------------

  function json(res, value, status = 200, extraHeaders = {}) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    });
    res.end(JSON.stringify(value));
  }

  function sendSse(res, event) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  function parseCookies(req) {
    const header = req.headers.cookie ?? "";
    const out = {};
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function secureCookie(req) {
    const proto = req.headers["x-forwarded-proto"];
    return req.socket.encrypted || proto === "https";
  }

  // The session device for a request, or null when the request is not paired.
  function sessionDevice(req) {
    const session = parseCookies(req)[SESSION_COOKIE];
    if (!session) return null;
    const deviceId = sessions.get(session);
    if (!deviceId) return null;
    const device = devices.get(deviceId);
    return device ? { deviceId, device } : null;
  }

  function deviceOnline(device) {
    return Boolean(device?.online && device?.ws && device.ws.readyState === 1);
  }

  // Never rejects: resolves with { ok, status, body } (a Mac ack) or
  // { status, body } (an immediate 503 / timeout 504 error). Requests that
  // share a requestId share the outcome — a duplicate delivery waits on the
  // in-flight command instead of firing a second one.
  function forwardCommand(deviceId, op, taskId, body, requestId) {
    return new Promise(resolve => {
      const device = devices.get(deviceId);
      if (!deviceOnline(device)) {
        resolve(offlineError());
        return;
      }
      const id = requestId || crypto.randomUUID();
      const existing = pending.get(id);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const result = {
          status: 504,
          body: { error: "Timed out waiting for the Mac." }
        };
        for (const r of p.resolvers) r(result);
      }, commandTimeoutMs);
      pending.set(id, { deviceId, resolvers: [resolve], timer });
      let sent = false;
      try {
        device.ws.send(
          JSON.stringify(makeFrame("command", deviceId, id, { op, taskId, body }))
        );
        sent = true;
      } catch {
        sent = false;
      }
      if (!sent) {
        clearTimeout(timer);
        const p = pending.get(id);
        pending.delete(id);
        const result = offlineError();
        for (const r of p?.resolvers ?? []) r(result);
      }
    });
  }

  function offlineError() {
    return {
      status: 503,
      body: { error: "Mac is offline — actions are unavailable until it reconnects." }
    };
  }

  function respondForwarded(res, result) {
    if (result?.ok) {
      json(res, result.body, result.status ?? 200);
    } else {
      json(res, result?.body ?? { error: "Mac action failed" }, result.status ?? 500);
    }
  }

  // --- WebSocket: the Mac's outbound connection -----------------------------

  const wss = new WebSocketServer({ noServer: true });

  function authenticate(ws, frame) {
    const { deviceId, requestId, payload } = frame;
    const reject = (error, closeCode = 1008) => {
      ws.send(
        JSON.stringify(
          makeFrame("hello", deviceId, requestId, {
            ok: false,
            error,
            protocolVersion: PROTOCOL_VERSION
          })
        )
      );
      ws.close(closeCode, error.slice(0, 120));
      return null;
    };

    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      return reject(`protocol mismatch: relay speaks ${PROTOCOL_VERSION}`);
    }
    const secret = typeof payload.deviceSecret === "string" ? payload.deviceSecret : "";
    if (!secret) return reject("missing deviceSecret");

    const existing = devices.get(deviceId);
    let device;

    if (existing && existing.deviceSecret === secret) {
      // Already registered — the secret is the long-lived credential; the
      // token is only metadata now. A new token (re-pair) becomes claimable.
      device = existing;
      if (typeof payload.token === "string" && payload.token && !tokens.has(payload.token)) {
        tokens.set(payload.token, {
          deviceId,
          expiresAt: null, // the agent's config carries its own expiry
          claimed: false
        });
        scheduleSave();
      }
    } else if (existing && existing.deviceSecret !== secret) {
      return reject("device identity conflict — secret does not match");
    } else {
      // Unregistered device. There are no accounts: the pairing token IS the
      // bootstrap credential. `2f pair` generated a high-entropy one-time
      // token on the Mac; whoever presents it is the Mac. The relay has never
      // seen it before — accept it, bind it to this deviceId, and let the
      // phone claim it exactly once before it expires.
      const token = typeof payload.token === "string" && payload.token.length >= 8 ? payload.token : "";
      if (!token) {
        return reject("unregistered");
      }
      const seen = tokens.get(token);
      if (seen) {
        if (seen.deviceId && seen.deviceId !== deviceId) {
          return reject("pairing token is bound to another device");
        }
        if (seen.claimed) {
          return reject("pairing token already used");
        }
      }
      tokens.set(token, {
        deviceId,
        expiresAt: seen?.expiresAt ?? new Date(Date.now() + PAIR_TTL_MS).toISOString(),
        claimed: false
      });
      device = {
        deviceSecret: secret,
        online: false,
        ws: null,
        base: "",
        tasks: [],
        providers: [],
        routing: {},
        events: new Map(),
        seen: new Set(),
        sessions: new Set(),
        lastSeenAt: null
      };
      devices.set(deviceId, device);
      scheduleSave();
    }

    if (device.ws && device.ws !== ws && device.ws.readyState === 1) {
      try {
        device.ws.close(1008, "replaced by a newer connection");
      } catch {
        /* already closing */
      }
    }
    device.ws = ws;
    device.online = true;
    device.lastSeenAt = new Date().toISOString();
    ws.send(
      JSON.stringify(
        makeFrame("hello", deviceId, requestId, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          apiVersion: API_VERSION,
          serverTime: new Date().toISOString()
        })
      )
    );
    scheduleSave();
    return deviceId;
  }

  function markOffline(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return;
    device.online = false;
    device.ws = null;
    device.lastSeenAt = new Date().toISOString();
    // Fail any in-flight commands for this device — never let a command hang.
    for (const [requestId, p] of [...pending.entries()]) {
      if (p.deviceId === deviceId) {
        clearTimeout(p.timer);
        pending.delete(requestId);
        for (const r of p.resolvers) r(offlineError());
      }
    }
    scheduleSave();
  }

  function handleAgentFrame(deviceId, frame) {
    const device = devices.get(deviceId);
    if (!device) return;
    switch (frame.type) {
      case "snapshot": {
        const p = frame.payload;
        if (typeof p.base === "string") device.base = p.base;
        if (Array.isArray(p.tasks)) device.tasks = p.tasks;
        device.lastSeenAt = new Date().toISOString();
        scheduleSave();
        break;
      }
      case "event": {
        const p = frame.payload;
        const byTask = p.events
          ? p.events
          : p.event && typeof p.event.taskId !== "undefined"
            ? { [String(p.event.taskId)]: [p.event] }
            : null;
        if (byTask) {
          const fanout = [];
          for (const [taskId, list] of Object.entries(byTask)) {
            if (!Array.isArray(list)) continue;
            let ring = device.events.get(taskId);
            if (!ring) {
              ring = [];
              device.events.set(taskId, ring);
            }
            for (const e of list) {
              const key = JSON.stringify(e);
              if (device.seen.has(key)) continue;
              device.seen.add(key);
              if (device.seen.size > MAX_EVENTS_TOTAL * 2) device.seen.clear();
              ring.push(e);
              fanout.push(e);
            }
            if (ring.length > MAX_EVENTS_PER_TASK) {
              device.events.set(taskId, ring.slice(-MAX_EVENTS_PER_TASK));
            }
          }
          trimEvents(device);
          for (const e of fanout) {
            for (const res of sseClients.get(deviceId) ?? []) sendSse(res, e);
          }
          scheduleSave();
        }
        break;
      }
      case "ack": {
        const p = pending.get(frame.requestId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(frame.requestId);
          const ack = frame.payload;
          const result = ack.ok
            ? ack
            : { status: ack.status ?? 500, body: { error: ack.error ?? "Mac action failed" } };
          for (const r of p.resolvers) r(result);
        }
        break;
      }
      default:
        log.warn(`relay: unexpected agent frame "${frame.type}"`);
    }
  }

  function trimEvents(device) {
    let total = 0;
    for (const ring of device.events.values()) total += ring.length;
    if (total <= MAX_EVENTS_TOTAL) return;
    // Drop the oldest rings first (task ids are ascending creation order).
    const ids = [...device.events.keys()].sort((a, b) => Number(a) - Number(b));
    for (const id of ids) {
      if (total <= MAX_EVENTS_TOTAL) break;
      const ring = device.events.get(id);
      total -= ring.length;
      device.events.delete(id);
    }
  }

  wss.on("connection", (ws, req) => {
    let deviceId = null;
    const helloTimer = setTimeout(() => {
      try {
        ws.close(1008, "hello timeout");
      } catch {
        /* already closing */
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(data.toString());
      if (!frame) return;
      if (frame.type === "hello") {
        if (deviceId) return; // already authenticated
        const id = authenticate(ws, frame);
        if (id) {
          clearTimeout(helloTimer);
          deviceId = id;
        }
        return;
      }
      if (frame._protocolMismatch) return; // version-gated: only hello answers it
      if (!deviceId || frame.deviceId !== deviceId) return;
      handleAgentFrame(deviceId, frame);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (deviceId) markOffline(deviceId);
    });

    ws.on("error", () => {
      /* close will follow */
    });

    // Server-side liveness: mobile networks can drop connections without a
    // FIN; ping agents and drop the ones that stop answering.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
  });

  const pingTimer = setInterval(() => {
    for (const device of devices.values()) {
      const sock = device.ws;
      if (!sock || sock.readyState !== 1) continue;
      if (sock.isAlive === false) {
        try {
          sock.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      sock.isAlive = false;
      try {
        sock.ping();
      } catch {
        /* close will follow */
      }
    }
  }, 30000);
  pingTimer.unref?.();

  // --- HTTP ----------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // --- pairing (public) ---
      if (method === "GET" && pathname.startsWith("/pair/")) {
        const token = decodeURIComponent(pathname.slice("/pair/".length));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pairPage(token));
        return;
      }

      const pairMatch = pathname.match(/^\/api\/pair\/([^/]+)$/);
      if (method === "GET" && pairMatch) {
        const token = decodeURIComponent(pairMatch[1]);
        const t = tokens.get(token);
        json(res, {
          registered: Boolean(t),
          claimed: t?.claimed ?? false,
          expiresAt: t?.expiresAt ?? null
        });
        return;
      }

      if (method === "POST" && pathname === "/api/pair/claim") {
        const body = JSON.parse(await readBody(req));
        const token = typeof body.token === "string" ? body.token : "";
        const t = tokens.get(token);
        if (!t || t.claimed || (t.expiresAt && Date.parse(t.expiresAt) <= Date.now())) {
          json(res, { error: "Pairing code is invalid, already used, or expired." }, 400);
          return;
        }
        const session = crypto.randomBytes(32).toString("hex");
        sessions.set(session, t.deviceId);
        const device = devices.get(t.deviceId);
        device?.sessions.add(session);
        t.claimed = true;
        scheduleSave();
        const secure = secureCookie(req);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie":
            `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict` +
            (secure ? "; Secure" : "")
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- the app shell: "/" is the session gate. Paired phones get the
      // client; anyone else gets the pairing landing page. The /app/* assets
      // themselves are ungated (the landing page and the shell both load).
      if (method === "GET" && pathname === "/") {
        const sd = sessionDevice(req);
        let text;
        try {
          text = await fs.readFile(path.join(webDir, "index.html"), "utf8");
        } catch {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...WEB_HEADERS
        });
        res.end(sd ? text : landingPage());
        return;
      }

      // --- static web assets (the same client the local server serves) ---
      const asset = method === "GET" ? ASSETS[pathname] : null;
      if (asset) {
        const [name, type] = asset;
        let text;
        try {
          text = await fs.readFile(path.join(webDir, name), "utf8");
        } catch {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          ...WEB_HEADERS
        });
        res.end(text);
        return;
      }

      // --- session gate: everything below requires a paired session ---
      const sd = sessionDevice(req);
      if (!sd) {
        json(res, { error: "Not paired — open a pairing link from `2f pair`." }, 401);
        return;
      }
      const { deviceId } = sd;
      const device = sd.device;
      const online = deviceOnline(device);
      const staleHeader = online ? {} : { "x-0x2f-stale": "1" };

      if (method === "GET" && pathname === "/api/status") {
        json(
          res,
          {
            mode: "relay",
            mac: online ? "online" : "offline",
            base: device.base,
            stale: !online
          },
          200,
          staleHeader
        );
        return;
      }

      // --- live events (SSE) ---
      if (method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");
        let set = sseClients.get(deviceId);
        if (!set) {
          set = new Set();
          sseClients.set(deviceId, set);
        }
        set.add(res);
        req.on("close", () => {
          set.delete(res);
          if (set.size === 0) sseClients.delete(deviceId);
        });
        return;
      }

      // --- bounded last-known event cache ---
      if (method === "GET" && pathname === "/api/events/history") {
        const events = {};
        for (const [taskId, ring] of device.events) events[taskId] = ring;
        json(res, { base: device.base, events }, 200, staleHeader);
        return;
      }

      // --- read routes: forward to the Mac when online, else stale cache ---
      if (method === "GET" && pathname === "/api/tasks") {
        if (online) {
          respondForwarded(res, await forwardCommand(deviceId, "list", undefined, undefined, req.headers["x-0x2f-request-id"]));
        } else {
          json(res, device.tasks, 200, staleHeader);
        }
        return;
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (method === "GET" && taskMatch) {
        const id = Number(taskMatch[1]);
        if (online) {
          respondForwarded(res, await forwardCommand(deviceId, "get", id, undefined, req.headers["x-0x2f-request-id"]));
        } else {
          const task = device.tasks.find(t => t.id === id);
          if (!task) {
            json(res, { error: `Task ${id} not found.` }, 404, staleHeader);
          } else {
            json(
              res,
              { ...task, runs: Array.isArray(task.runs) ? task.runs : [], result: null },
              200,
              staleHeader
            );
          }
        }
        return;
      }

      const runMatch = pathname.match(/^\/api\/tasks\/(\d+)\/runs\/(\d+)$/);
      if (method === "GET" && runMatch) {
        const id = Number(runMatch[1]);
        const run = Number(runMatch[2]);
        if (online) {
          respondForwarded(res, await forwardCommand(deviceId, "getRun", id, { run }, req.headers["x-0x2f-request-id"]));
        } else {
          const task = device.tasks.find(t => t.id === id);
          const record = task && Array.isArray(task.runs) ? task.runs.find(r => r.run === run) : null;
          if (!record) {
            json(res, { error: `Task ${id} has no run ${run}.` }, 404, staleHeader);
          } else {
            json(res, { ...record, result: null }, 200, staleHeader);
          }
        }
        return;
      }

      // --- cached provider descriptors / routing (refreshed on every hello) ---
      if (method === "GET" && pathname === "/api/providers") {
        json(res, device.providers, 200, staleHeader);
        return;
      }
      if (method === "GET" && pathname === "/api/routing") {
        json(res, device.routing, 200, staleHeader);
        return;
      }

      // --- mutating routes: never queued; offline is an explicit 503 ---
      if (!online) {
        json(res, offlineError().body, 503);
        return;
      }

      if (method === "POST" && pathname === "/api/tasks") {
        const body = JSON.parse(await readBody(req));
        respondForwarded(
          res,
          await forwardCommand(deviceId, "create", undefined, body, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      if (method === "POST" && pathname === "/api/refine") {
        const body = JSON.parse(await readBody(req));
        respondForwarded(
          res,
          await forwardCommand(deviceId, "refine", undefined, { text: body.text }, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const rerunMatch = pathname.match(/^\/api\/tasks\/(\d+)\/rerun$/);
      if (method === "POST" && rerunMatch) {
        const body = JSON.parse(await readBody(req));
        respondForwarded(
          res,
          await forwardCommand(deviceId, "rerun", Number(rerunMatch[1]), body, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const allowMatch = pathname.match(/^\/api\/tasks\/(\d+)\/allow$/);
      if (method === "POST" && allowMatch) {
        respondForwarded(
          res,
          await forwardCommand(deviceId, "allow", Number(allowMatch[1]), undefined, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const rejectMatch = pathname.match(/^\/api\/tasks\/(\d+)\/reject$/);
      if (method === "POST" && rejectMatch) {
        respondForwarded(
          res,
          await forwardCommand(deviceId, "reject", Number(rejectMatch[1]), undefined, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const answerMatch = pathname.match(/^\/api\/tasks\/(\d+)\/answer$/);
      if (method === "POST" && answerMatch) {
        const body = JSON.parse(await readBody(req));
        respondForwarded(
          res,
          await forwardCommand(deviceId, "answer", Number(answerMatch[1]), body, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const noteMatch = pathname.match(/^\/api\/tasks\/(\d+)\/note$/);
      if (method === "POST" && noteMatch) {
        const body = JSON.parse(await readBody(req));
        respondForwarded(
          res,
          await forwardCommand(deviceId, "note", Number(noteMatch[1]), body, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      const closeMatch = pathname.match(/^\/api\/tasks\/(\d+)\/close$/);
      if (method === "POST" && closeMatch) {
        respondForwarded(
          res,
          await forwardCommand(deviceId, "close", Number(closeMatch[1]), undefined, req.headers["x-0x2f-request-id"])
        );
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      log.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
      } else {
        res.destroy();
      }
    }
  });

  // --- binding --------------------------------------------------------------

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  });

  async function start() {
    await loadState();
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const actualPort = server.address().port;
    const url = `http://${host}:${actualPort}`;
    return {
      server,
      wss,
      url,
      port: actualPort,
      // Test/observation seam: the relay's current in-memory view.
      state: { devices, tokens, sessions },
      close: async () => {
        clearInterval(pingTimer);
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        try {
          await flushSave();
        } catch {
          /* best effort */
        }
        for (const device of devices.values()) {
          try {
            device.ws?.close();
          } catch {
            /* already closing */
          }
        }
        for (const set of sseClients.values()) {
          for (const res of set) res.destroy();
        }
        wss.close();
        await new Promise(resolve => server.close(resolve));
      }
    };
  }

  return { start, wss, server };
}

// --- pairing pages ----------------------------------------------------------

function pairPage(token) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>0x2F · pair</title>
<style>
  html, body { margin: 0; height: 100%; background: #e4e8ec; }
  body { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; color: #2f2f2f; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 420px; width: 100%; margin: 24px; padding: 28px 26px; background: #f6f8fa; border: 1px solid #ccd4da; }
  .k { font-size: 10px; letter-spacing: .2em; color: #5c6771; font-weight: 600; }
  .status { margin-top: 18px; font-size: 14px; line-height: 1.6; color: #2f2f2f; }
  .err { color: #b8532a; }
</style>
</head><body>
<div class="card">
  <div class="k">0X2F / PAIR</div>
  <div class="status" id="status">Connecting…</div>
</div>
<script>
  const token = ${JSON.stringify(token)};
  const status = document.getElementById("status");
  async function step() {
    try {
      const res = await fetch("/api/pair/" + encodeURIComponent(token));
      const info = await res.json();
      if (info.claimed) {
        status.textContent = "Already paired — opening 0x2F…";
        location.href = "/";
      } else if (info.registered) {
        status.textContent = "Paired — opening 0x2F…";
        const claim = await fetch("/api/pair/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token })
        });
        if (claim.ok) location.href = "/";
        else { status.textContent = "Pairing failed — the code may have expired. Run 2f pair again."; status.className += " err"; }
      } else {
        status.textContent = "Waiting for your Mac to connect…";
        setTimeout(step, 1500);
      }
    } catch {
      status.textContent = "Relay unreachable — check the address.";
      status.className += " err";
      setTimeout(step, 3000);
    }
  }
  step();
</script>
</body></html>`;
}

function landingPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>0x2F · pair</title>
<style>
  html, body { margin: 0; height: 100%; background: #e4e8ec; }
  body { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; color: #2f2f2f; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 420px; width: 100%; margin: 24px; padding: 28px 26px; background: #f6f8fa; border: 1px solid #ccd4da; }
  .k { font-size: 10px; letter-spacing: .2em; color: #5c6771; font-weight: 600; }
  .hint { margin-top: 14px; font-size: 13px; line-height: 1.6; color: #37424c; }
  input { display: block; width: 100%; margin-top: 16px; padding: 12px; font-family: inherit; font-size: 16px; border: 1px solid #c6d3ea; background: #fff; outline: none; border-radius: 0; }
  input:focus { border-color: #2f5fa8; }
  button { margin-top: 12px; padding: 13px 20px; font-family: inherit; font-size: 11px; letter-spacing: .16em; background: #2f2f2f; color: #f6f8fa; border: none; cursor: pointer; }
  .err { color: #b8532a; margin-top: 12px; font-size: 12px; }
</style>
</head><body>
<div class="card">
  <div class="k">0X2F / PAIR</div>
  <div class="hint">Run <b>2f pair</b> on your Mac and open the link it prints — or paste the pairing code below.</div>
  <input id="token" autocomplete="off" spellcheck="false" placeholder="pairing code" />
  <button id="go">PAIR</button>
  <div class="err" id="err"></div>
</div>
<script>
  const input = document.getElementById("token");
  const err = document.getElementById("err");
  async function claim() {
    const token = input.value.trim();
    if (!token) return;
    err.textContent = "";
    try {
      const res = await fetch("/api/pair/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token })
      });
      if (res.ok) { location.href = "/"; return; }
      const info = await res.json().catch(() => ({}));
      err.textContent = info.error || "Pairing failed.";
    } catch {
      err.textContent = "Relay unreachable.";
    }
  }
  document.getElementById("go").addEventListener("click", claim);
  input.addEventListener("keydown", e => { if (e.key === "Enter") claim(); });
</script>
</body></html>`;
}

// --- CLI entry ---------------------------------------------------------------

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const opt = key => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(opt("--port") ?? 8080);
  const host = opt("--host") ?? "127.0.0.1";
  const webDir = opt("--web") ?? path.resolve(fileURLToPath(new URL("../src/web/", import.meta.url)));
  const dataFile = opt("--data") ?? path.resolve(fileURLToPath(new URL("./data/state.json", import.meta.url)));
  const relay = createRelayServer({ webDir, dataFile, host, port });
  const handle = await relay.start();
  console.log(`0x2F Relay: http://${host}:${handle.port}`);
  console.log(`  web client: ${webDir}`);
  console.log(`  state:      ${dataFile}`);
  console.log("Terminate TLS in front of this (Caddy/nginx). The Mac connects outbound; no inbound ports are needed.");
}
