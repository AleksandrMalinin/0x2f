// Remote control agent — the outbound link from a local 0x2F runtime to the
// 0x2F relay, and the Mac-side enforcement point of the E2E remote-control
// protocol.
//
// The agent is an in-process module of the UI runtime (server-entry.mjs). It
// deliberately contains NO Task logic: it subscribes to the existing
// normalized event bus, projects events to the REMOTE (redacted) shape, and
// executes remote commands through the SHARED core actions
// (core/actions.mjs).
//
// Trust model (Phase 3A): the relay is an OPAQUE BROKER. Every command, ack,
// event and snapshot is an AES-256-GCM envelope (src/web/e2e.mjs) protected
// by the pairing key — the shared secret derived from the short code the user
// typed into the trusted client page. The relay cannot read or forge any of
// it. A remote command executes ONLY after:
//
//   1. GCM verification with the confirmed phone's key (authenticity);
//   2. the requestId is not in the persisted ack cache, or a fresh timestamp
//      is inside the ±5 min window (replay protection, survives restart);
//   3. the op is executed by the shared actions, serially, with the ack
//      cached under the requestId so a legitimate retry returns the SAME ack
//      and never executes twice.
//
// The pairing ceremony is bound and consumed: a `pair-hello` is accepted only
// while pairing is pending AND its token matches the current config token AND
// the token has not expired; after confirmation a replayed pair-hello cannot
// re-establish trust.
//
//   config file  <workspace>/.work/relay.json
//     { url, enabled, deviceId, deviceSecret, token, tokenExpiresAt,
//       agentName, code?, phoneId?, pairing? }
//   ack cache    <workspace>/.work/relay-acks.json  (mode 0600)

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  API_VERSION,
  COMMAND_OPS,
  makeFrame,
  parseFrame,
  makeRelayFrame,
  parseRelayFrame
} from "./protocol.mjs";
import { validateRelayUrl } from "./pair.mjs";
import { WorkError } from "../core/errors.mjs";
import { deriveKeyRaw, importKey, encrypt, decrypt } from "../web/e2e.mjs";
import { projectSnapshot, projectEvent, projectTask, projectRun, projectResult } from "./project.mjs";

const HELLO_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 90000;
const CONFIG_POLL_MS = 2000;

// Replay + idempotency (survives Mac/runtime restart — persisted to disk).
const TS_WINDOW_MS = 5 * 60 * 1000; // commands older than this are stale
const ACK_MAX = 1000; // bounded ack cache
const ACK_TTL_MS = 24 * 60 * 60 * 1000; // retries/duplicates within a day
const ACK_SAVE_DEBOUNCE_MS = 500;

const SNAPSHOT_EVENTS_PER_TASK = 200; // recent remote events in a snapshot

export function createRelayAgent({
  runtime,
  configPath,
  log = console,
  configPollMs = CONFIG_POLL_MS,
  now = Date.now
}) {
  const info =
    typeof log === "function"
      ? log
      : typeof log?.log === "function"
        ? (...a) => log.log(...a)
        : () => {};
  const warn =
    typeof log?.warn === "function"
      ? (...a) => log.warn(...a)
      : typeof log === "function"
        ? log
        : () => {};
  const error =
    typeof log?.error === "function"
      ? (...a) => log.error(...a)
      : typeof log === "function"
        ? log
        : () => {};

  let cfg = null; // last loaded config (null = disabled/absent)
  let ws = null;
  let state = "idle"; // idle | connecting | online | reconnecting | unpaired
  let attempt = 0;
  let lastError = null;
  let stopped = false;
  let unsubscribe = null;
  let configTimer = null;
  let reconnectTimer = null;
  let keepaliveTimer = null;
  let lastPongAt = 0;
  let seenConfig = ""; // connection-relevant config fingerprint
  let sessionKey = null; // CryptoKey derived from code + token (AES-GCM)
  let ackCache = null; // Map requestId -> { ack, at } (persisted)
  let ackSaveTimer = null;
  let commandChain = Promise.resolve();

  // --- ack cache (replay protection that survives restart) ------------------

  const ackCachePath = () => path.join(path.dirname(path.dirname(configPath)), ".work", "relay-acks.json");

  async function loadAckCache() {
    try {
      const raw = JSON.parse(await fs.readFile(ackCachePath(), "utf8"));
      const map = new Map();
      for (const [id, entry] of Object.entries(raw ?? {})) {
        if (entry && typeof entry.at === "number" && now() - entry.at <= ACK_TTL_MS) {
          map.set(id, entry);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async function saveAckCache() {
    try {
      const obj = Object.fromEntries([...ackCache.entries()].map(([id, e]) => [id, e]));
      await fs.mkdir(path.dirname(ackCachePath()), { recursive: true });
      await fs.writeFile(ackCachePath(), JSON.stringify(obj) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.chmod(ackCachePath(), 0o600);
    } catch (err) {
      error(`relay: could not persist the ack cache: ${err.message}`);
    }
  }

  function scheduleAckSave() {
    if (ackSaveTimer) return;
    ackSaveTimer = setTimeout(() => {
      ackSaveTimer = null;
      saveAckCache();
    }, ACK_SAVE_DEBOUNCE_MS);
  }

  function rememberAck(requestId, ack) {
    ackCache.set(requestId, { ack, at: now() });
    if (ackCache.size > ACK_MAX) {
      // Drop the oldest entries beyond the bound.
      const oldest = [...ackCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of oldest.slice(0, ackCache.size - ACK_MAX)) ackCache.delete(id);
    }
    scheduleAckSave();
  }

  // --- config ---------------------------------------------------------------

  async function writeConfig(next) {
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(next, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.chmod(configPath, 0o600);
    } catch (err) {
      error(`relay: could not write config: ${err.message}`);
    }
  }

  async function loadConfig() {
    try {
      const text = await fs.readFile(configPath, "utf8");
      const c = JSON.parse(text);
      if (!c || c.enabled === false) return null;
      if (!c.url || !c.deviceId || !c.deviceSecret) return null;
      const urlError = validateRelayUrl(c.url);
      if (urlError) {
        warn(`relay: not connecting — ${urlError}`);
        return null;
      }
      return c;
    } catch {
      return null;
    }
  }

  // What requires reconnecting the WebSocket (identity/transport changes).
  function connectionKey(c) {
    if (!c) return "";
    return [c.url, c.deviceId, c.deviceSecret, c.enabled].join("\n");
  }

  // What requires re-deriving the E2E key (a new pairing ceremony).
  function cryptoKey(c) {
    if (!c) return "";
    return [c.code ?? "", c.token ?? ""].join("\n");
  }

  async function applyKey(next) {
    if (!next?.code || !next?.token) {
      sessionKey = null;
      return;
    }
    try {
      const raw = await deriveKeyRaw(next.code, next.token);
      sessionKey = await importKey(raw);
    } catch (err) {
      error(`relay: could not derive the pairing key: ${err.message}`);
      sessionKey = null;
    }
  }

  // --- transport ------------------------------------------------------------

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // Encrypt + send one Mac → phone envelope.
  async function sendEnvelope(plaintext, requestId) {
    // Snapshot: the frame must be addressed from the SAME device identity the
    // payload was encrypted for, and `cfg` can be reassigned (or nulled) by
    // the config poller during the await below.
    const config = cfg;
    if (!sessionKey || !config) return false;
    try {
      const { iv, data } = await encrypt(sessionKey, plaintext, {
        from: config.deviceId,
        requestId
      });
      return send(makeRelayFrame(config.deviceId, requestId, { iv, data }));
    } catch (err) {
      error(`relay: could not encrypt a message: ${err.message}`);
      return false;
    }
  }

  function wsUrl(config) {
    const base = config.url.replace(/\/+$/, "");
    return base.replace(/^http/, "ws") + "/ws";
  }

  function connect() {
    if (stopped || !cfg || ws || state === "connecting") return;
    // This socket belongs to the config that opened it. The handlers below
    // fire later (on "open", on the hello ack), by which time the poller may
    // have replaced or nulled `cfg` — a socket must not identify itself with
    // a device identity other than the one it was dialled for.
    const config = cfg;
    state = "connecting";
    lastError = null;
    let sock;
    try {
      sock = new WebSocket(wsUrl(config));
    } catch (error) {
      lastError = error.message;
      state = "reconnecting";
      scheduleReconnect();
      return;
    }
    ws = sock;

    const helloTimer = setTimeout(() => {
      if (state === "connecting") {
        lastError = "hello timeout";
        sock.close();
      }
    }, HELLO_TIMEOUT_MS);

    sock.on("open", () => {
      send(
        makeFrame("hello", config.deviceId, crypto.randomUUID(), {
          protocolVersion: PROTOCOL_VERSION,
          apiVersion: API_VERSION,
          agentName: config.agentName ?? "0x2f-mac",
          deviceSecret: config.deviceSecret,
          token: config.token ?? null,
          tokenExpiresAt: config.tokenExpiresAt ?? null
        })
      );
    });

    sock.on("pong", () => {
      lastPongAt = Date.now();
    });

    sock.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      const frame = parseFrame(text);
      if (frame) {
        if (frame._protocolMismatch) {
          lastError = `protocol version mismatch (relay speaks ${frame.protocolVersion}, agent speaks ${PROTOCOL_VERSION})`;
          error(`relay: ${lastError}`);
          state = "reconnecting";
          try {
            sock.close();
          } catch {
            /* already closing */
          }
          return;
        }
        if (frame.type === "hello") {
          clearTimeout(helloTimer);
          onHelloAck(frame);
        } else {
          warn(`relay: unexpected frame type "${frame.type}"`);
        }
        return;
      }
      const relayFrame = parseRelayFrame(text);
      if (relayFrame) {
        onRelayFrame(relayFrame);
        return;
      }
      warn("relay: dropped malformed frame");
    });

    sock.on("close", () => {
      clearTimeout(helloTimer);
      if (ws === sock) ws = null;
      const wasOnline = state === "online";
      if (wasOnline) info("relay: connection lost — reconnecting");
      state = "reconnecting";
      scheduleReconnect();
    });

    sock.on("error", error => {
      lastError = error instanceof Error ? error.message : String(error);
    });
  }

  function scheduleReconnect() {
    if (stopped || !cfg) return;
    if (state === "unpaired") return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const base = Math.min(60000, 1000 * 2 ** attempt);
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(base * jitter);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function onHelloAck(frame) {
    // Deferred socket callback: the poller may have nulled `cfg` between the
    // hello being sent and this ack arriving. The state transitions below are
    // still correct in that case — only the log line needs a config to read.
    const config = cfg;
    const p = frame.payload;
    if (p.ok) {
      state = "online";
      attempt = 0;
      lastError = null;
      if (config) {
        info(
          `relay: online (${config.url})` +
            (config.pairing === "pending" ? " — waiting for the phone to pair" : "")
        );
      }
      return;
    }
    lastError = p.error ?? "hello rejected";
    if (p.error === "unregistered") {
      state = "unpaired";
      error(`relay: unpaired — run \`2f pair\` to pair this Mac (${lastError})`);
    } else {
      state = "reconnecting";
      error(`relay: hello rejected (${lastError})`);
      scheduleReconnect();
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  // --- the E2E channel ------------------------------------------------------

  function confirmed() {
    return Boolean(cfg && cfg.pairing === "confirmed" && cfg.phoneId && sessionKey);
  }

  async function onRelayFrame(frame) {
    if (!sessionKey) return; // no pairing key — nothing to verify against
    const plaintext = await decrypt(sessionKey, frame, {
      from: frame.from,
      requestId: frame.requestId
    });
    if (!plaintext || typeof plaintext !== "object") {
      // Wrong key, tampered payload, or a mismatched from/requestId — the
      // relay cannot produce a valid envelope, so this is dropped.
      return;
    }
    if (plaintext.cmd === "pair-hello") {
      await onPairHello(frame, plaintext);
      return;
    }
    if (plaintext.cmd === "command") {
      queueCommand(frame, plaintext);
    }
  }

  // Bind + consume the pairing ceremony: accepted only while pending, with
  // the exact current token, and before the token expires. A replayed
  // pair-hello (after confirmation or rotation) cannot establish trust.
  async function onPairHello(frame, plaintext) {
    // ONE consistent snapshot for the whole ceremony. `cfg` is module-level
    // and the config poller reassigns it every CONFIG_POLL_MS — to null when
    // the relay is disabled or its config file disappears. Validating `cfg`
    // and then reading it again after an await is a use-after-null: the
    // poll can land during `writeConfig` and turn the next line into a
    // TypeError. Everything below reads `config`, never `cfg`.
    const config = cfg;
    const valid =
      config &&
      config.pairing === "pending" &&
      plaintext.token === config.token &&
      typeof plaintext.phoneId === "string" &&
      plaintext.phoneId.length >= 8 &&
      frame.from === plaintext.phoneId &&
      (!config.tokenExpiresAt || Date.parse(config.tokenExpiresAt) > Date.now());
    if (!valid) {
      warn("relay: rejected a pair-hello — pairing is not pending or the token does not match");
      return;
    }
    config.phoneId = plaintext.phoneId;
    config.pairing = "confirmed";
    await writeConfig(config);
    // The config this ceremony validated may have stopped being the live one
    // while that write was in flight (the relay was disabled, or its config
    // was removed). The pairing is on disk, but this agent has nothing live
    // to serve it from — so drop it quietly instead of telling the phone it
    // is paired. A confirmed pairing the Mac cannot honor is worse than none.
    //
    // A normal pairing never trips this: `pairing`/`phoneId` are part of
    // neither connectionKey nor cryptoKey, so the poller leaves `cfg`
    // pointing at this same object after our write.
    if (cfg !== config) {
      warn("relay: the configuration changed while pairing — not confirming to the phone");
      return;
    }
    info(`relay: phone paired (${config.phoneId}) — remote control is on`);
    await sendEnvelope({ cmd: "ack", ok: true, status: 200, body: { phoneId: config.phoneId } }, frame.requestId);
  }

  // --- commands -------------------------------------------------------------

  function queueCommand(frame, plaintext) {
    const { requestId, op, taskId, body, ts } = plaintext;
    if (!confirmed()) {
      // A command arriving while the pairing is not confirmed used to be
      // silently dropped — the phone's request then hung until the relay's
      // command timeout, with no signal and no state change. Answer honestly
      // instead (when a key exists to encrypt with); the phone surfaces the
      // error and reconciles with the authoritative state.
      sendEnvelope(
        {
          cmd: "ack",
          ok: false,
          status: 401,
          error: "The Mac is not accepting remote commands right now (pairing not confirmed)."
        },
        requestId
      );
      return;
    }
    if (frame.from !== cfg.phoneId) return; // envelope not from our phone

    const cached = ackCache.get(requestId);
    if (cached) {
      // Duplicate delivery (retry, double tap, reconnect) — the action already
      // ran; answer with the stored acknowledgement, never execute again.
      sendEnvelope({ cmd: "ack", ...cached.ack }, requestId);
      return;
    }
    if (typeof ts !== "number" || Math.abs(now() - ts) > TS_WINDOW_MS) {
      // A command with an old timestamp cannot be a fresh legitimate request —
      // this is the replay bound once the ack cache evicts the requestId.
      sendEnvelope(
        { cmd: "ack", ok: false, status: 400, error: "Command is stale or replayed." },
        requestId
      );
      return;
    }
    commandChain = commandChain
      .then(async () => {
        const result = await runCommand({ op, taskId, body });
        rememberAck(requestId, result);
        await sendEnvelope({ cmd: "ack", ...result }, requestId);
      })
      .catch(async error => {
        const result = { ok: false, status: 500, error: String(error?.message ?? error) };
        await sendEnvelope({ cmd: "ack", ...result }, requestId);
      });
  }

  function ok(status, body) {
    return { ok: true, status, body };
  }

  function fail(status, error) {
    return { ok: false, status, error };
  }

  function currentProviders() {
    try {
      return runtime.providers.listProviders().map(p => ({
        id: p.id,
        displayName: p.displayName,
        integrationType: p.integrationType,
        available: runtime.providers.available(p.id)
      }));
    } catch {
      return [];
    }
  }

  function currentRouting() {
    try {
      const config = runtime.router.config;
      return {
        default: config?.default ?? runtime.providers.defaultProviderId,
        prefer: config?.prefer ?? []
      };
    } catch {
      return { default: null, prefer: [] };
    }
  }

  // The phone's initial/reconnect state pull: the redacted projection of
  // tasks + recent events per task + provider descriptors + routing + the
  // Mac clock (for phone clock-skew correction on commands).
  async function buildSnapshot() {
    const tasks = await runtime.actions.listWork();
    const eventsByTask = {};
    const resultsByTask = {};
    for (const task of tasks) {
      const all = await runtime.store.readEvents(task.slug);
      eventsByTask[String(task.id)] = all.slice(-SNAPSHOT_EVENTS_PER_TASK);
      // The safe user-facing result for READY tasks, carried on the task
      // projection itself (projectTask gates it to states that show a result,
      // so a stale result.md never leaks onto a failed task).
      resultsByTask[task.id] = await runtime.store.readTaskResult(task);
    }
    return projectSnapshot({
      tasks,
      resultsByTask,
      eventsByTask,
      providers: currentProviders(),
      routing: currentRouting(),
      base: runtime.store.base,
      // §01/§02: the same machine identity the local runtime shows —
      // preferring the name the user set at pairing time (cfg.agentName,
      // which itself defaults to os.hostname() — see pair.mjs), falling back
      // to this process's own hostname when no config is loaded yet.
      node: cfg?.agentName ?? os.hostname?.() ?? null,
      serverTime: Date.now()
    });
  }

  async function runCommand({ op, taskId, body }) {
    if (!COMMAND_OPS.includes(op)) {
      return fail(400, `Unknown remote op: "${op}".`);
    }
    const base = runtime.store.base;
    try {
      switch (op) {
        case "list":
          return ok(200, (await runtime.actions.listWork()).map(t => projectTask(t, base)));
        case "get": {
          const full = await runtime.actions.getWork(taskId);
          return ok(200, projectTask(full, base, full.result));
        }
        case "getRun": {
          const full = await runtime.actions.getRun(taskId, Number(body?.run));
          return ok(200, { ...projectRun(full, base), result: projectResult(full.result, base) });
        }
        case "create":
          return ok(
            201,
            await runtime.actions.createWork({
              brief: body?.brief,
              provider: body?.provider,
              model: body?.model
            })
          );
        case "rerun":
          return ok(
            201,
            await runtime.actions.rerunWork(taskId, {
              provider: body?.provider,
              model: body?.model
            })
          );
        case "allow":
          return ok(202, await runtime.actions.allowWork(taskId));
        case "reject":
          return ok(202, await runtime.actions.rejectWork(taskId));
        case "answer":
          return ok(202, await runtime.actions.answerWork(taskId, { answer: body?.answer }));
        case "note":
          return ok(202, await runtime.actions.noteWork(taskId, { note: body?.note }));
        case "close":
          return ok(200, await runtime.actions.closeWork(taskId));
        case "refine":
          return ok(200, await runtime.refine.refineTaskPrompt(body?.text ?? ""));
        case "providers":
          return ok(200, currentProviders());
        case "routing":
          return ok(200, currentRouting());
        case "snapshot":
          return ok(200, await buildSnapshot());
        default:
          return fail(400, `Unhandled remote op: "${op}".`);
      }
    } catch (error) {
      if (error instanceof WorkError) {
        return fail(error.status ?? 400, error.message);
      }
      return fail(500, error instanceof Error ? error.message : String(error));
    }
  }

  // --- events ---------------------------------------------------------------

  function onBusEvent(event) {
    if (state !== "online" || !confirmed()) return;
    const projected = projectEvent(event, runtime.store.base);
    if (!projected) return;
    sendEnvelope({ cmd: "event", event: projected }, crypto.randomUUID());
  }

  // --- lifecycle ------------------------------------------------------------

  async function tickConfig() {
    const next = await loadConfig();
    const connKey = connectionKey(next);
    const cryptoChanged = cryptoKey(next) !== cryptoKey(cfg);

    if (connKey !== seenConfig) {
      seenConfig = connKey;
      const disable = cfg && next === null;
      cfg = next;
      if (cryptoChanged) await applyKey(next);
      if (!cfg) {
        if (ws) {
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          ws = null;
        }
        state = "idle";
        attempt = 0;
        sessionKey = null;
        if (disable) info("relay: remote control disabled");
        return;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        ws = null;
      }
      state = "idle";
      attempt = 0;
      connect();
    } else if (cryptoChanged) {
      // New pairing code/token without a transport change: re-derive the key
      // in place; the pending ceremony waits for the phone's pair-hello.
      cfg = next;
      await applyKey(next);
    } else if (cfg && state === "idle") {
      connect();
    }
  }

  function start() {
    if (stopped) return agent;
    loadAckCache().then(cache => {
      ackCache = cache;
    });
    unsubscribe = runtime.events.on(onBusEvent);
    configTimer = setInterval(tickConfig, configPollMs);
    keepaliveTimer = setInterval(() => {
      if (state === "online" && ws) {
        if (lastPongAt && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
          lastError = "keepalive timeout";
          try {
            ws.terminate();
          } catch {
            /* already gone */
          }
        } else {
          try {
            ws.ping();
          } catch {
            /* send failure — close will surface it */
          }
        }
      }
    }, PING_INTERVAL_MS);
    tickConfig();
    return agent;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(configTimer);
    clearInterval(keepaliveTimer);
    clearTimeout(reconnectTimer);
    if (ackSaveTimer) {
      clearTimeout(ackSaveTimer);
      ackSaveTimer = null;
    }
    if (unsubscribe) unsubscribe();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      ws = null;
    }
    state = "idle";
    if (ackCache) saveAckCache();
  }

  function status() {
    return {
      state,
      url: cfg?.url ?? null,
      deviceId: cfg?.deviceId ?? null,
      pairing: cfg?.pairing ?? null,
      phoneId: cfg?.phoneId ?? null,
      lastError
    };
  }

  const agent = { start, stop, status };
  return agent;
}
