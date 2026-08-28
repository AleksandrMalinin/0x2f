// 0x2F Relay — the connectivity layer between a phone and a local 0x2F
// runtime on the Mac. An OPAQUE BROKER, not an execution authority.
//
//   Phone browser ── HTTPS ──► 0x2F Relay ◄── outbound WSS ── Mac
//
// This module is the SHARED relay implementation, used two ways:
//
//   - hosted (private deployment): relay/server.mjs is the standalone entry
//     point behind TLS (Caddy/nginx), state in relay/data/state.json — never
//     shipped in the npm package;
//   - LAN pairing (part of the local product): the Mac's runtime
//     server mounts it in-process (src/server.mjs, `mount: true`) so a phone
//     on the same Wi-Fi talks to the Mac directly through the same protocol.
//
// Trust model: every command, ack, event and snapshot between the
// phone and the Mac is an end-to-end AES-256-GCM envelope (src/web/e2e.mjs)
// keyed by the pairing secret, which the relay never sees. The relay can
// ROUTE envelopes and report availability, but it cannot construct a valid
// command, cannot decrypt any payload, and holds NO task/event/result
// content. Commands are never queued: while the Mac is offline they fail
// immediately with 503.
//
// What the relay knows (and persists in the relay state file, mode 0600):
//   - pairing tokens (one-time, always expiring) and phone sessions (30-day
//     TTL, generation-bound — see the credential lifecycle below);
//   - device identity (deviceSecret) and online/offline state, for routing;
//   - plaintext envelope routing metadata: from, requestId, sizes, timing.
//
// Credential lifecycle:
//   - deviceSecret   the Mac's long-lived credential to the relay; rotated by
//                    the Mac on EVERY `2f pair` via /api/devices/rotate
//                    (authorized by the current secret).
//   - pairing token  128-bit one-time bootstrap credential, always with an
//                    expiry; claimed exactly once by a phone.
//   - phone session  issued by claiming a token; TTL (30 days) and bound to
//                    the device generation: re-pairing (rotate) or `2f pair
//                    --off` (revoke) bumps the generation and clears all
//                    sessions and tokens, so stale sessions can never
//                    silently become valid again after a reconnect.
//
// The relay never serves the web client or pairing page: that trusted
// surface lives on the client origin (the local runtime by default; a static
// host in deployment), OUTSIDE this process's control.
//
// Routes:
//   GET  /api/pair/:token        { registered, claimed, expiresAt } (public)
//   POST /api/pair/claim         { token, phoneId? } -> session secret
//   POST /api/devices/rotate     { deviceId, deviceSecret, nextSecret,
//                                  token, tokenExpiresAt } (Mac-authenticated)
//   POST /api/devices/revoke     { deviceId, deviceSecret } (Mac-authenticated)
//   GET  /api/status             { mode: "relay", mac: online|offline }
//   POST /api/command            { requestId, from, iv, data } — forward an
//                                 encrypted phone envelope to the Mac and
//                                 return the encrypted ack envelope
//   GET  /api/events             SSE — the Mac's encrypted envelopes, forwarded
//                                 verbatim to the phone
//   /ws                          the Mac agent channel (hello + relay frames)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  API_VERSION,
  makeFrame,
  parseFrame,
  parseRelayFrame
} from "./protocol.mjs";

const SESSION_COOKIE = "0x2f_session";
const COMMAND_TIMEOUT_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const PAIR_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // phone sessions live 30 days
const MAX_BODY_BYTES = 1_000_000;

// Rate limits (fixed window, per key). Pairing claims are IP-bound (they are
// the only unauthenticated mutating surface — a brute-forced token is
// infeasible, but a flood is noise); command forwarding is session-bound.
const DEFAULT_RATE_LIMITS = {
  claim: { windowMs: 60_000, max: 10 },
  command: { windowMs: 60_000, max: 120 }
};

// Cross-origin: the phone client lives on the client origin (never here) and
// authenticates with a bearer session secret — not cookies — so `*` is safe:
// a foreign page cannot produce a valid session secret or a valid envelope.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600"
};

export function createRelayServer({
  dataFile = null,
  host = "127.0.0.1",
  port = 0,
  log = console,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  saveDelayMs = 500,
  sessionTtlMs = SESSION_TTL_MS,
  tokenTtlMs = PAIR_TTL_MS,
  now = Date.now,
  rateLimits = DEFAULT_RATE_LIMITS,
  mount = false
} = {}) {
  const devices = new Map(); // deviceId -> device state (below)
  const tokens = new Map(); // pairing token -> { deviceId, expiresAt, claimed }
  const sessions = new Map(); // session secret -> { deviceId, generation, expiresAt, phoneId? }
  const pending = new Map(); // requestId -> { deviceId, resolvers: [], timer }
  const sseClients = new Map(); // deviceId -> Set<http.ServerResponse>
  const rateBuckets = new Map(); // `${kind}:${key}` -> { count, resetAt }

  // device = { deviceSecret, online, ws, generation, lastSeenAt }

  // A fixed-window limiter: true when the key has exceeded its budget. Buckets
  // are pruned on size so a flood of distinct keys cannot grow memory without
  // bound.
  function rateLimited(kind, key) {
    const rule = rateLimits?.[kind];
    if (!rule || !key) return false;
    const nowMs = now();
    const bucketKey = `${kind}:${key}`;
    const b = rateBuckets.get(bucketKey);
    if (!b || nowMs >= b.resetAt) {
      if (rateBuckets.size > 10_000) rateBuckets.clear();
      rateBuckets.set(bucketKey, { count: 1, resetAt: nowMs + rule.windowMs });
      return false;
    }
    b.count += 1;
    return b.count > rule.max;
  }

  // --- persistence (tokens, sessions, device identity — NO task content) ----

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
      version: 3,
      tokens: Object.fromEntries([...tokens.entries()].map(([t, v]) => [t, v])),
      sessions: Object.fromEntries([...sessions.entries()]),
      devices: Object.fromEntries(
        [...devices.entries()].map(([id, d]) => [
          id,
          { deviceSecret: d.deviceSecret, generation: d.generation, lastSeenAt: d.lastSeenAt }
        ])
      )
    };
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.writeFile(dataFile, JSON.stringify(snapshot) + "\n", {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.chmod(dataFile, 0o600);
  }

  async function loadState() {
    if (!dataFile) return;
    let raw;
    try {
      raw = await fs.readFile(dataFile, "utf8");
    } catch {
      return;
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
    for (const [session, record] of Object.entries(saved.sessions ?? {})) {
      if (typeof record === "string") {
        sessions.set(session, { deviceId: record, generation: 1, expiresAt: now() + sessionTtlMs });
      } else if (record && typeof record.deviceId === "string") {
        sessions.set(session, {
          deviceId: record.deviceId,
          generation: record.generation ?? 1,
          expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : now() + sessionTtlMs,
          ...(typeof record.phoneId === "string" ? { phoneId: record.phoneId } : {})
        });
      }
    }
    for (const [id, d] of Object.entries(saved.devices ?? {})) {
      devices.set(id, {
        deviceSecret: d.deviceSecret ?? "",
        online: false,
        ws: null,
        generation: d.generation ?? 1,
        lastSeenAt: d.lastSeenAt ?? null
      });
    }
  }

  // --- helpers --------------------------------------------------------------

  function json(res, value, status = 200, extraHeaders = {}) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...CORS,
      ...extraHeaders
    });
    res.end(JSON.stringify(value));
  }

  function sendSse(res, frame) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  async function readBody(req, maxBytes = MAX_BODY_BYTES) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Request body too large (max ${maxBytes} bytes).`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`Request body too large (max ${maxBytes} bytes).`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function parseCookies(req) {
    const out = {};
    try {
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      }
    } catch {
      /* malformed cookie */
    }
    return out;
  }

  function sessionSecret(req) {
    const cookie = parseCookies(req)[SESSION_COOKIE];
    if (cookie) return cookie;
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
    return null;
  }

  // The session device for a request, or null when not paired. A session is
  // valid only while it exists, has not expired, and belongs to the device's
  // CURRENT generation.
  function sessionDevice(req) {
    const session = sessionSecret(req);
    if (!session) return null;
    const record = sessions.get(session);
    if (!record) return null;
    if (record.expiresAt && now() >= record.expiresAt) {
      sessions.delete(session);
      return null;
    }
    const device = devices.get(record.deviceId);
    if (!device) return null;
    if (record.generation !== device.generation) return null;
    return { deviceId: record.deviceId, device, session };
  }

  function deviceOnline(device) {
    return Boolean(device?.online && device?.ws && device.ws.readyState === 1);
  }

  function offlineError() {
    return {
      status: 503,
      body: { error: "Mac is offline — actions are unavailable until it reconnects." }
    };
  }

  // Register (or refresh) a pairing token, ALWAYS with an expiry.
  function registerToken(token, deviceId, payloadExpiresAt) {
    let expiresAt;
    if (typeof payloadExpiresAt === "string") {
      const parsed = new Date(payloadExpiresAt);
      if (!Number.isNaN(parsed.getTime())) expiresAt = parsed.toISOString();
    }
    if (!expiresAt) expiresAt = new Date(now() + tokenTtlMs).toISOString();
    tokens.set(token, { deviceId, expiresAt, claimed: false });
    scheduleSave();
  }

  // Retire every credential of a device (re-pair / revoke): bump the
  // generation (invalidating all phone sessions) and drop its sessions and
  // tokens. The deviceSecret is NOT touched here.
  function revokeDeviceCredentials(deviceId, device) {
    device.generation += 1;
    for (const [session, record] of [...sessions.entries()]) {
      if (record.deviceId === deviceId) sessions.delete(session);
    }
    for (const [token, record] of [...tokens.entries()]) {
      if (record.deviceId === deviceId) tokens.delete(token);
    }
    if (device.ws && device.ws.readyState === 1) {
      try {
        device.ws.close(1008, "credentials rotated or revoked");
      } catch {
        /* already closing */
      }
    }
    scheduleSave();
  }

  // --- the Mac's outbound WebSocket -----------------------------------------

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
      device = existing;
      if (typeof payload.token === "string" && payload.token && !tokens.has(payload.token)) {
        registerToken(payload.token, deviceId, payload.tokenExpiresAt);
      }
    } else if (existing && existing.deviceSecret !== secret) {
      return reject("device identity conflict — secret does not match");
    } else {
      const token = typeof payload.token === "string" && payload.token.length >= 8 ? payload.token : "";
      if (!token) return reject("unregistered");
      const seen = tokens.get(token);
      if (seen) {
        if (seen.deviceId && seen.deviceId !== deviceId) {
          return reject("pairing token is bound to another device");
        }
        if (seen.claimed) return reject("pairing token already used");
      }
      registerToken(token, deviceId, payload.tokenExpiresAt);
      device = {
        deviceSecret: secret,
        online: false,
        ws: null,
        generation: 1,
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

  // A close from a STALE socket (replaced by a newer connection, or a
  // reconnect racing the old socket's close) must not clobber the newer
  // connection's online state.
  function markOffline(deviceId, ws) {
    const device = devices.get(deviceId);
    if (!device) return;
    if (ws && device.ws !== ws) return;
    device.online = false;
    device.ws = null;
    device.lastSeenAt = new Date().toISOString();
    for (const [requestId, p] of [...pending.entries()]) {
      if (p.deviceId === deviceId) {
        clearTimeout(p.timer);
        pending.delete(requestId);
        for (const r of p.resolvers) r(offlineError());
      }
    }
    scheduleSave();
  }

  // A Mac relay frame: either the ack for a phone's pending command (resolve
  // the HTTP request) or a Mac → phone envelope (fan out to the phone's SSE).
  function handleAgentRelayFrame(deviceId, frame) {
    const p = pending.get(frame.requestId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(frame.requestId);
      for (const r of p.resolvers) r(frame);
      return;
    }
    for (const res of sseClients.get(deviceId) ?? []) sendSse(res, frame);
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
      const text = data.toString();
      const frame = parseFrame(text);
      if (frame) {
        if (frame.type === "hello") {
          if (deviceId) return;
          const id = authenticate(ws, frame);
          if (id) {
            clearTimeout(helloTimer);
            deviceId = id;
          }
          return;
        }
        if (frame._protocolMismatch) return;
        if (!deviceId || frame.deviceId !== deviceId) return;
        return;
      }
      const relayFrame = parseRelayFrame(text);
      if (!relayFrame || !deviceId) return;
      handleAgentRelayFrame(deviceId, relayFrame);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (deviceId) markOffline(deviceId, ws);
    });

    ws.on("error", () => {
      /* close will follow */
    });

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

  // Forward a phone envelope to the Mac and resolve with the Mac's encrypted
  // ack envelope (or an offline/timeout error). Never queues: while the Mac
  // is offline the phone gets an immediate 503.
  function forwardRelayFrame(deviceId, frame) {
    return new Promise(resolve => {
      const device = devices.get(deviceId);
      if (!deviceOnline(device)) {
        resolve(offlineError());
        return;
      }
      const id = frame.requestId;
      const existing = pending.get(id);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const result = { status: 504, body: { error: "Timed out waiting for the Mac." } };
        for (const r of p.resolvers) r(result);
      }, commandTimeoutMs);
      pending.set(id, { deviceId, resolvers: [resolve], timer });
      let sent = false;
      try {
        device.ws.send(JSON.stringify(frame));
        sent = true;
      } catch {
        sent = false;
      }
      if (!sent) {
        clearTimeout(timer);
        const entry = pending.get(id);
        pending.delete(id);
        const result = offlineError();
        for (const r of entry?.resolvers ?? []) r(result);
      }
    });
  }

  // The relay's HTTP request handler. Standalone (relay/server.mjs --port)
  // it is mounted on its own http server; in LAN mode (src/server.mjs) the
  // Mac's runtime server mounts it so a phone on the same Wi-Fi talks to the
  // Mac directly through the SAME protocol — the hosted flow, byte for byte.
  async function handler(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // --- pairing (public) ---
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
        const ip = req.socket.remoteAddress ?? "unknown";
        if (rateLimited("claim", ip)) {
          json(res, { error: "Too many pairing attempts — try again shortly." }, 429);
          return;
        }
        const body = JSON.parse(await readBody(req));
        const token = typeof body.token === "string" ? body.token : "";
        const t = tokens.get(token);
        if (!t || t.claimed || (t.expiresAt && Date.parse(t.expiresAt) <= now())) {
          json(res, { error: "Pairing code is invalid, already used, or expired." }, 400);
          return;
        }
        const device = devices.get(t.deviceId);
        const session = crypto.randomBytes(32).toString("hex");
        sessions.set(session, {
          deviceId: t.deviceId,
          generation: device?.generation ?? 1,
          expiresAt: now() + sessionTtlMs,
          ...(typeof body.phoneId === "string" && body.phoneId ? { phoneId: body.phoneId } : {})
        });
        t.claimed = true;
        scheduleSave();
        // The session secret is returned in the body so the cross-origin phone
        // client can authenticate with an Authorization: Bearer header; the
        // cookie is kept for same-site development flows.
        const secure = req.headers["x-forwarded-proto"] === "https";
        const maxAge = Math.floor(sessionTtlMs / 1000);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          ...CORS,
          "set-cookie":
            `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
            (secure ? "; Secure" : "")
        });
        res.end(JSON.stringify({ ok: true, session }));
        return;
      }

      // --- device lifecycle (Mac-authenticated by the deviceSecret) ---
      if (method === "POST" && pathname === "/api/devices/rotate") {
        const body = JSON.parse(await readBody(req));
        const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
        const device = devices.get(deviceId);
        if (!device || device.deviceSecret !== body.deviceSecret) {
          json(res, { error: "Unknown device or bad deviceSecret." }, 401);
          return;
        }
        if (typeof body.nextSecret !== "string" || body.nextSecret.length < 16) {
          json(res, { error: "nextSecret must be a non-empty credential." }, 400);
          return;
        }
        revokeDeviceCredentials(deviceId, device);
        device.deviceSecret = body.nextSecret;
        if (typeof body.token === "string" && body.token) {
          registerToken(body.token, deviceId, body.tokenExpiresAt);
        }
        scheduleSave();
        json(res, { ok: true, generation: device.generation });
        return;
      }

      if (method === "POST" && pathname === "/api/devices/revoke") {
        const body = JSON.parse(await readBody(req));
        const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
        const device = devices.get(deviceId);
        if (!device || device.deviceSecret !== body.deviceSecret) {
          json(res, { error: "Unknown device or bad deviceSecret." }, 401);
          return;
        }
        revokeDeviceCredentials(deviceId, device);
        scheduleSave();
        json(res, { ok: true });
        return;
      }

      // --- session gate: everything below requires a paired phone ---
      const sd = sessionDevice(req);
      if (!sd) {
        json(res, { error: "Not paired — open a pairing link from `2f pair`." }, 401);
        return;
      }
      const { deviceId, device } = sd;
      const online = deviceOnline(device);

      if (method === "GET" && pathname === "/api/status") {
        json(res, { mode: "relay", mac: online ? "online" : "offline" });
        return;
      }

      // The single remote-control surface: encrypted envelopes only. The
      // relay cannot see inside them — it correlates by requestId and routes.
      if (method === "POST" && pathname === "/api/command") {
        if (rateLimited("command", sd.session)) {
          json(res, { error: "Too many requests — try again shortly." }, 429);
          return;
        }
        const body = JSON.parse(await readBody(req));
        const frame = parseRelayFrame(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "relay",
          from: body.from,
          requestId: body.requestId,
          iv: body.iv,
          data: body.data
        }));
        if (!frame) {
          json(res, { error: "Malformed command envelope." }, 400);
          return;
        }
        if (!online) {
          json(res, offlineError().body, 503);
          return;
        }
        const result = await forwardRelayFrame(deviceId, frame);
        if (result.status) {
          json(res, result.body, result.status);
        } else {
          // result is the Mac's encrypted ack envelope.
          json(res, result);
        }
        return;
      }

      if (method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...CORS
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

      res.writeHead(404, { ...CORS });
      res.end("Not found");
    } catch (error) {
      log.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
      } else {
        res.destroy();
      }
    }
  }

  const server = http.createServer(handler);

  // --- binding --------------------------------------------------------------

  // WebSocket upgrades (the Mac agent's outbound channel). Standalone this
  // is wired to the relay's own server; in LAN mount mode the runtime server
  // forwards its /ws upgrades here.
  function handleUpgrade(req, socket, head) {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  }
  server.on("upgrade", handleUpgrade);

  async function closeRelay() {
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

  async function start() {
    await loadState();
    if (mount) {
      // Mount mode (LAN pairing): the relay never listens on its own socket;
      // the host process (the Mac's runtime server) serves handler/upgrade.
      return {
        server,
        wss,
        url: null,
        port: null,
        state: { devices, tokens, sessions, flushSave },
        handler,
        handleUpgrade,
        close: closeRelay
      };
    }
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
      state: { devices, tokens, sessions, flushSave },
      handler,
      handleUpgrade,
      close: closeRelay
    };
  }

  return { start, wss, server, handler, handleUpgrade };
}
