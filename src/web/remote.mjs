// The remote transport adapter — the phone side of the E2E channel.
//
// In REMOTE mode the app is served by the client origin (not the relay) and
// talks to the relay as an opaque broker: commands are encrypted envelopes
// POSTed to /api/command, acks come back as encrypted envelopes, and Mac
// events/snapshots arrive over a fetch-based SSE stream (bearer-authenticated
// — EventSource cannot set headers). Nothing here trusts the relay: every
// response is GCM-verified against the pairing key before use.
//
// The app keeps a bounded last-known cache (localStorage) so the mobile
// Attention Stack still renders while the Mac is offline — the relay holds no
// content anymore.

import { importKey, b64decode, b64encode, encrypt, decrypt, randomId } from "./e2e.mjs";

export const REMOTE_STORE_KEY = "0x2f.remote";
export const REMOTE_CACHE_KEY = "0x2f.remote-cache";

export function loadRemoteState() {
  try {
    const raw = localStorage.getItem(REMOTE_STORE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || !state.relayUrl || !state.session || !state.phoneId || !state.deviceId || !state.key) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export function clearRemoteState() {
  try {
    localStorage.removeItem(REMOTE_STORE_KEY);
    localStorage.removeItem(REMOTE_CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

// Bounded last-known cache: { tasks, eventsByTask, providers, routing }.
export function loadRemoteCache() {
  try {
    const raw = localStorage.getItem(REMOTE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveRemoteCache(cache) {
  try {
    localStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota — the cache is best-effort */
  }
}

// Map a local API path onto the remote op set (mirrors src/server.mjs routes
// and src/relay/agent.mjs runCommand).
function mapPath(path, method) {
  const p = path.replace(/^\/api/, "");
  if (p === "/tasks" && method === "GET") return { op: "list" };
  if (p === "/tasks" && method === "POST") return { op: "create" };
  let m = p.match(/^\/tasks\/(\d+)$/);
  if (m) return { op: "get", taskId: Number(m[1]) };
  m = p.match(/^\/tasks\/(\d+)\/runs\/(\d+)$/);
  if (m) return { op: "getRun", taskId: Number(m[1]), body: { run: Number(m[2]) } };
  m = p.match(/^\/tasks\/(\d+)\/(rerun|allow|reject|answer|note|close)$/);
  if (m) return { op: m[2], taskId: Number(m[1]) };
  if (p === "/refine" && method === "POST") return { op: "refine" };
  if (p === "/providers") return { op: "providers" };
  if (p === "/routing") return { op: "routing" };
  return null;
}

export async function createRemoteClient(state, opts = {}) {
  const key = await importKey(b64decode(state.key));
  const authHeaders = { "content-type": "application/json", authorization: "Bearer " + state.session };

  // The phone's clock may drift from the Mac's; the snapshot carries the
  // Mac's serverTime and the client records the offset for command timestamps.
  let clockOffset = 0;
  // The Mac reconnects on its own after an offline period; a command sent
  // during the transition answers 503. Retry with the SAME requestId — the
  // Mac's persisted ack cache makes retries idempotent (one logical command,
  // one requestId, never double execution).
  const RETRY_503 = 3;
  const RETRY_DELAY_MS = 800;
  // A bounded command round-trip. The relay itself answers 504 after its own
  // command timeout (30s), so this is the backstop for a response lost in
  // transit — WITHOUT it, a dropped HTTP response leaves the phone's action
  // promise pending forever and the control surface stuck "disabled". The
  // failure is surfaced honestly and the caller reconciles with the Mac's
  // authoritative state; it is never a silent retry that could double-run.
  const COMMAND_TIMEOUT_MS = opts.commandTimeoutMs ?? 45_000;

  async function sendCommand(op, { taskId, body } = {}, { requestId = randomId(), ts } = {}) {
    const plaintext = {
      cmd: "command",
      op,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(body ? { body } : {}),
      requestId,
      ts: ts ?? Date.now() + clockOffset
    };
    const { iv, data } = await encrypt(key, plaintext, { from: state.phoneId, requestId });
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_503; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
      try {
        let res;
        try {
          res = await fetch(`${state.relayUrl}/api/command`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ requestId, from: state.phoneId, iv, data }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          let message = "HTTP " + res.status;
          try {
            message = (await res.json()).error || message;
          } catch {
            /* non-JSON error */
          }
          const err = new Error(message);
          err.status = res.status;
          throw err;
        }
        const frame = await res.json();
        const ack = await decrypt(key, frame, { from: state.deviceId, requestId });
        if (!ack) throw new Error("Could not verify the Mac's response.");
        if (ack.ok === false) {
          const err = new Error(ack.error ?? "Mac action failed");
          err.status = ack.status ?? 500;
          throw err;
        }
        return ack.body;
      } catch (error) {
        if (error?.name === "AbortError") {
          // The relay never answered within the bound — the response was lost
          // in transit. Surface it honestly (never silently retry: the Mac
          // may already have executed the action).
          throw Object.assign(
            new Error(
              "The Mac did not respond in time — the action may or may not have run. The task state has been refreshed."
            ),
            { status: 504 }
          );
        }
        if (error.status !== 503 || attempt >= RETRY_503) throw error;
        lastError = error;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw lastError ?? new Error("Command failed");
  }

  return {
    clockOffset,
    setClockOffset(offset) {
      clockOffset = offset;
    },

    // The same signature the local transport uses: api(path, { method, body }).
    async api(path, { method = "GET", body } = {}) {
      const mapped = mapPath(path, method);
      if (!mapped) throw new Error(`Unsupported remote path: ${path}`);
      return sendCommand(mapped.op, { taskId: mapped.taskId, body: body ?? mapped.body });
    },

    // The initial/reconnect state pull (redacted projection from the Mac).
    snapshot() {
      return sendCommand("snapshot");
    },

    async status() {
      const res = await fetch(`${state.relayUrl}/api/status`, {
        headers: { authorization: "Bearer " + state.session }
      });
      if (res.status === 401) throw Object.assign(new Error("Not paired"), { status: 401 });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    },

    // Fetch-based SSE (bearer auth): decrypt each Mac envelope and hand the
    // plaintext to onMessage. `onOpen` fires once the stream is established.
    // Resolves when the stream ends or is aborted.
    async events(onMessage, { signal, onOpen } = {}) {
      const res = await fetch(`${state.relayUrl}/api/events`, {
        headers: { authorization: "Bearer " + state.session },
        signal
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = block
            .split("\n")
            .find(line => line.startsWith("data:"));
          if (!dataLine) continue; // comments/keepalive
          let frame;
          try {
            frame = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          const plaintext = await decrypt(key, frame, {
            from: state.deviceId,
            requestId: frame.requestId
          });
          if (plaintext && typeof plaintext === "object") onMessage(plaintext);
        }
      }
    },

    // Serialize the last-known state for the offline cache.
    persistCache({ tasks, eventsByTask, providers, routing }) {
      saveRemoteCache({ tasks, eventsByTask, providers, routing });
    },

    loadCache() {
      return loadRemoteCache();
    },

    clear() {
      clearRemoteState();
    }
  };
}
