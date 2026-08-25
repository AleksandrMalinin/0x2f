// Test-side phone client — drives the REAL relay + REAL agent over the E2E
// protocol (the same wire contract the browser client speaks), so the tests
// exercise the actual trust boundaries.

import {
  deriveKeyRaw,
  importKey,
  b64encode,
  encrypt,
  decrypt,
  randomId
} from "../src/web/e2e.mjs";

export async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// The complete pairing ceremony from the phone side: claim the relay session
// and confirm with the Mac via a signed pair-hello (retried while the Mac is
// offline). Returns a ready phone client.
export async function pairPhone({ relayUrl, token, deviceId, code, pollMs = 50, timeoutMs = 6000 }) {
  const raw = await deriveKeyRaw(code, token);
  const key = await importKey(raw);
  const phoneId = "phone-" + Math.random().toString(36).slice(2, 14);

  const claimRes = await fetch(`${relayUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, phoneId })
  });
  if (!claimRes.ok) {
    throw new Error(`claim failed: ${claimRes.status}`);
  }
  const { session } = await claimRes.json();

  const requestId = randomId();
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const plaintext = { cmd: "pair-hello", token, phoneId, ts: Date.now() };
      const { iv, data } = await encrypt(key, plaintext, { from: phoneId, requestId });
      const res = await fetch(`${relayUrl}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + session },
        body: JSON.stringify({ requestId, from: phoneId, iv, data })
      });
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        const err = new Error(info.error ?? `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const frame = await res.json();
      const ack = await decrypt(key, frame, { from: deviceId, requestId });
      if (!ack || ack.ok !== true) throw new Error("pair-hello was not confirmed");
      break;
    } catch (error) {
      if (error.status !== 503 || Date.now() > deadline) {
        throw error;
      }
      lastError = error;
      await sleep(pollMs);
    }
  }
  void lastError;
  return createPhoneClient({ relayUrl, session, phoneId, deviceId, key, raw });
}

// Map a local API path onto the remote op set (mirrors src/web/remote.mjs).
export function mapPath(path, method = "GET") {
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

export function createPhoneClient({ relayUrl, session, phoneId, deviceId, key, raw }) {
  const authHeaders = { "content-type": "application/json", authorization: "Bearer " + session };
  let clockOffset = 0;

  async function command(op, { taskId, body } = {}, { requestId = randomId(), ts } = {}) {
    const plaintext = {
      cmd: "command",
      op,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(body ? { body } : {}),
      requestId,
      ts: ts ?? Date.now() + clockOffset
    };
    const { iv, data } = await encrypt(key, plaintext, { from: phoneId, requestId });
    const res = await fetch(`${relayUrl}/api/command`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ requestId, from: phoneId, iv, data })
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      const err = new Error(info.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const frame = await res.json();
    const ack = await decrypt(key, frame, { from: deviceId, requestId });
    if (!ack) throw new Error("The Mac's response failed verification.");
    if (ack.ok === false) {
      const err = new Error(ack.error ?? "Mac action failed");
      err.status = ack.status ?? 500;
      throw err;
    }
    return ack.body;
  }

  return {
    relayUrl,
    session,
    phoneId,
    deviceId,
    key,
    raw,
    setClockOffset(offset) {
      clockOffset = offset;
    },
    command,
    api(path, opts = {}) {
      const mapped = mapPath(path, opts.method ?? "GET");
      if (!mapped) throw new Error(`Unsupported remote path: ${path}`);
      return command(mapped.op, { taskId: mapped.taskId, body: opts.body ?? mapped.body });
    },
    snapshot() {
      return command("snapshot");
    },
    async status() {
      const res = await fetch(`${relayUrl}/api/status`, {
        headers: { authorization: "Bearer " + session }
      });
      return res.json();
    },
    // Decrypt Mac envelopes from the SSE stream; resolves when aborted.
    async events(onMessage, { signal } = {}) {
      const res = await fetch(`${relayUrl}/api/events`, {
        headers: { authorization: "Bearer " + session },
        signal
      });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
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
          const dataLine = block.split("\n").find(line => line.startsWith("data:"));
          if (!dataLine) continue;
          let frame;
          try {
            frame = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          const plaintext = await decrypt(key, frame, {
            from: deviceId,
            requestId: frame.requestId
          });
          if (plaintext && typeof plaintext === "object") onMessage(plaintext);
        }
      }
    },
    keyB64: raw ? b64encode(raw) : null
  };
}
