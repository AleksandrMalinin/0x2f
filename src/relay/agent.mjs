// Remote control agent — the outbound link from a local 0x2F runtime to the
// 0x2F relay.
//
// The agent is an in-process module of the UI runtime (server-entry.mjs). It
// deliberately contains NO Task logic: it subscribes to the existing
// normalized event bus, forwards events, and executes remote commands through
// the SHARED core actions (core/actions.mjs). The relay layer never
// reimplements lifecycle, runs, or persistence.
//
//   config file  <workspace>/.work/relay.json
//     { url, enabled, deviceId, deviceSecret, token, tokenExpiresAt, agentName }
//
//   url           https://relay.example.com  (the agent connects to /ws)
//   deviceId      stable per-workspace id — protocol identity, never a
//                 credential
//   deviceSecret  long-lived Mac credential, generated at first pairing
//   token         current one-time pairing token (rotated by `2f pair`)
//
// The agent polls the config file, so `2f pair` can rotate the token or
// disable remote control while the runtime keeps running — no restart needed.
//
// Reliability contract:
//   - reconnect with exponential backoff + jitter; on every reconnect the
//     agent re-authenticates (hello), re-pushes the Task snapshot, and
//     backfills recent events, so the relay's view is restored from local
//     canonical state.
//   - commands execute strictly serially (consistent with 0x2f's sequential
//     runs), each with an idempotency key: a repeated requestId returns the
//     cached acknowledgement and never executes a mutating action twice.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  API_VERSION,
  COMMAND_OPS,
  MUTATING_OPS,
  makeFrame,
  parseFrame
} from "./protocol.mjs";
import { WorkError } from "../core/errors.mjs";

// Events that change what a task IS (task.json): after one of these the
// agent pushes a fresh snapshot so the relay's last-known view cannot drift
// from canonical state. progress/tool.started/file.changed never touch
// task.json and never trigger a snapshot.
const STATE_EVENTS = new Set([
  "task.created",
  "task.updated",
  "task.closed",
  "task.answered",
  "task.note",
  "needs_user",
  "permission.resolved",
  "run.completed",
  "run.failed"
]);

const MAX_IDEMPOTENT = 500; // bounded idempotency cache (per process lifetime)
const BACKFILL_EVENTS_PER_TASK = 500;
const BACKFILL_TOTAL = 5000;
const HELLO_TIMEOUT_MS = 10000;
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 90000;
const CONFIG_POLL_MS = 2000;
const SNAPSHOT_DEBOUNCE_MS = 150;

export function createRelayAgent({
  runtime,
  configPath,
  log = console,
  configPollMs = CONFIG_POLL_MS
}) {
  // Accept either a console-shaped object ({ log, warn, error }) or a plain
  // callable; never assume which the caller passed.
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
  let snapshotTimer = null;
  let keepaliveTimer = null;
  let lastPongAt = 0;
  let seenConfig = ""; // JSON snapshot of the last applied config

  const idempotent = new Map(); // requestId -> ack payload (bounded)
  let commandChain = Promise.resolve();

  // --- config ---------------------------------------------------------------

  async function loadConfig() {
    try {
      const text = await fs.readFile(configPath, "utf8");
      const c = JSON.parse(text);
      if (!c || c.enabled === false) return null;
      if (!c.url || !c.deviceId || !c.deviceSecret) return null;
      return c;
    } catch {
      return null;
    }
  }

  function configKey(c) {
    if (!c) return "";
    return [c.url, c.deviceId, c.deviceSecret, c.token ?? "", c.enabled].join("\n");
  }

  function wsUrl() {
    const base = cfg.url.replace(/\/+$/, "");
    return base.replace(/^http/, "ws") + "/ws";
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

  function connect() {
    if (stopped || !cfg || ws || state === "connecting") return;
    state = "connecting";
    lastError = null;
    let sock;
    try {
      sock = new WebSocket(wsUrl());
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
        makeFrame("hello", cfg.deviceId, crypto.randomUUID(), {
          protocolVersion: PROTOCOL_VERSION,
          apiVersion: API_VERSION,
          agentName: cfg.agentName ?? "0x2f-mac",
          deviceSecret: cfg.deviceSecret,
          token: cfg.token ?? null,
          providers: currentProviders(),
          routing: currentRouting()
        })
      );
    });

    sock.on("pong", () => {
      lastPongAt = Date.now();
    });

    sock.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(data.toString());
      if (!frame) {
        warn("relay: dropped malformed frame");
        return;
      }
      if (frame._protocolMismatch) {
        // The relay speaks a different wire protocol — explicit failure
        // instead of silent misbehavior; retry in case it upgrades.
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
      } else if (frame.type === "command") {
        queueCommand(frame);
      } else {
        warn(`relay: unexpected frame type "${frame.type}"`);
      }
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
    if (state === "unpaired") return; // wait for a token/config change
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
    const p = frame.payload;
    if (p.ok) {
      state = "online";
      attempt = 0;
      lastError = null;
      info(`relay: online (${cfg.url})`);
      sendSnapshot().then(() => sendBackfill());
      return;
    }
    // Rejected. "unregistered" means the relay has no record of this device
    // and no usable pairing token was presented — retrying is pointless
    // until `2f pair` rotates the token, so idle until the config changes.
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

  // --- snapshot / events ----------------------------------------------------

  function currentProviders() {
    try {
      return runtime.providers.listProviders().map(p => ({
        id: p.id,
        displayName: p.displayName,
        integrationType: p.integrationType,
        capabilities: p.capabilities,
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

  async function sendSnapshot() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const tasks = await runtime.actions.listWork();
      send(
        makeFrame("snapshot", cfg.deviceId, crypto.randomUUID(), {
          base: runtime.store.base,
          tasks,
          at: new Date().toISOString()
        })
      );
    } catch (error) {
      error(`relay: snapshot failed: ${error.message}`);
    }
  }

  // The relay's event ring is bounded and may have missed events while this
  // agent was disconnected; on every reconnect the agent backfills the recent
  // tail of each task's normalized log (one batched frame).
  async function sendBackfill() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const tasks = await runtime.actions.listWork();
      const events = {};
      let total = 0;
      for (const task of tasks) {
        if (total >= BACKFILL_TOTAL) break;
        const all = await runtime.store.readEvents(task.slug);
        const tail = all.slice(-BACKFILL_EVENTS_PER_TASK);
        if (tail.length) {
          events[String(task.id)] = tail;
          total += tail.length;
        }
      }
      if (Object.keys(events).length) {
        send(makeFrame("event", cfg.deviceId, crypto.randomUUID(), { events }));
      }
    } catch (error) {
      error(`relay: backfill failed: ${error.message}`);
    }
  }

  function scheduleSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      sendSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  function onBusEvent(event) {
    if (state !== "online") return;
    send(makeFrame("event", cfg.deviceId, crypto.randomUUID(), { event }));
    if (STATE_EVENTS.has(event.type)) scheduleSnapshot();
  }

  // --- commands -------------------------------------------------------------

  function queueCommand(frame) {
    const { requestId, payload } = frame;
    const cached = idempotent.get(requestId);
    if (cached) {
      // Duplicate delivery (double tap, network retry, reconnect) — the
      // action already ran; answer with the stored acknowledgement.
      send(makeFrame("ack", cfg.deviceId, requestId, cached));
      return;
    }
    commandChain = commandChain
      .then(async () => {
        const result = await runCommand(payload);
        if (idempotent.size >= MAX_IDEMPOTENT) {
          idempotent.delete(idempotent.keys().next().value);
        }
        idempotent.set(requestId, result);
        send(makeFrame("ack", cfg.deviceId, requestId, result));
        if (result.ok && MUTATING_OPS.includes(payload.op)) {
          await sendSnapshot();
        }
      })
      .catch(error => {
        // runCommand never throws; this is a guard for the chain itself.
        const result = { ok: false, status: 500, error: String(error?.message ?? error) };
        send(makeFrame("ack", cfg.deviceId, requestId, result));
      });
  }

  function ok(status, body) {
    return { ok: true, status, body };
  }

  function fail(status, error) {
    return { ok: false, status, error };
  }

  async function runCommand({ op, taskId, body }) {
    if (!COMMAND_OPS.includes(op)) {
      return fail(400, `Unknown remote op: "${op}".`);
    }
    try {
      switch (op) {
        case "list":
          return ok(200, await runtime.actions.listWork());
        case "get":
          return ok(200, await runtime.actions.getWork(taskId));
        case "getRun":
          return ok(200, await runtime.actions.getRun(taskId, Number(body?.run)));
        case "create":
          return ok(
            201,
            await runtime.actions.createWork({
              title: body?.title,
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

  // --- lifecycle ------------------------------------------------------------

  async function tickConfig() {
    const next = await loadConfig();
    const key = configKey(next);
    if (key !== seenConfig) {
      seenConfig = key;
      const changed = cfg && next && (cfg.url !== next.url || cfg.deviceId !== next.deviceId || cfg.deviceSecret !== next.deviceSecret || cfg.token !== next.token);
      cfg = next;
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
        return;
      }
      // Config appeared or changed (first pairing, token rotation, disable).
      // Drop the old connection (if any) and connect with the new identity.
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
    } else if (cfg && state === "idle") {
      connect();
    }
  }

  function start() {
    if (stopped) return agent;
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
    clearTimeout(snapshotTimer);
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
  }

  function status() {
    return {
      state,
      url: cfg?.url ?? null,
      deviceId: cfg?.deviceId ?? null,
      lastError
    };
  }

  const agent = { start, stop, status };
  return agent;
}
