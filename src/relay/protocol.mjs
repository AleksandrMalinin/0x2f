// Remote control protocol — the wire contract between the Mac agent, the
// relay (an opaque broker), and the phone client.
//
// Two frame kinds share the version number:
//
//   hello frames  { protocolVersion, deviceId, requestId, type, payload }
//                 Mac ↔ relay transport authentication only (deviceSecret).
//
//   relay frames  { v, type: "relay", from, requestId, iv, data }
//                 Opaque end-to-end envelopes between the Mac and the phone.
//                 The relay routes them and correlates requestIds, but cannot
//                 read or forge them (see src/web/e2e.mjs). `from` is the
//                 phoneId (phone → Mac) or the deviceId (Mac → phone);
//                 `iv`/`data` are the AES-256-GCM ciphertext.
//
// End-to-end plaintext (encrypted inside the envelope):
//   phone → Mac  { cmd: "pair-hello", token, phoneId, ts }   (one-time, at
//                 pairing — binds + consumes the ceremony) or
//                 { cmd: "command", op, taskId?, body?, requestId, ts }
//                 where op ∈ COMMAND_OPS + "snapshot"; ts is the phone's
//                 clock, validated by the Mac (±5 min) against a persisted
//                 requestId → ack cache for replay protection.
//   Mac → phone  { cmd: "ack", ok, status, body? } | { cmd: "ack", ok: false,
//                 status, error }  (same requestId as the command) or
//                 { cmd: "event", event } | { cmd: "snapshot", tasks,
//                 eventsByTask, providers, routing, serverTime }
//
// The Mac executes commands ONLY after GCM verification of the envelope with
// the confirmed phone's key — the relay cannot construct a valid command.

export const PROTOCOL_VERSION = 2;

// The 0x2f API surface version the agent implements. Bumped whenever the
// command op set or ack shapes change.
export const API_VERSION = "0.7";

// Ops map 1:1 onto the local HTTP API, plus "snapshot" (the phone's initial
// remote state pull — the redacted projection of tasks + recent events +
// providers + routing). "snapshot" is remote-only; it has no local route.
export const COMMAND_OPS = Object.freeze([
  "list",
  "get",
  "getRun",
  "create",
  "rerun",
  "allow",
  "reject",
  "answer",
  "note",
  "close",
  "refine",
  "providers",
  "routing",
  "snapshot"
]);

// Ops that mutate Task state. Informational today (the phone re-pulls state
// after them via the client's STATE_EVENTS handling); kept for documentation.
export const MUTATING_OPS = Object.freeze([
  "create",
  "rerun",
  "allow",
  "reject",
  "answer",
  "note",
  "close"
]);

export function makeFrame(type, deviceId, requestId, payload) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    requestId,
    type,
    payload
  };
}

// Parse + validate an incoming hello frame. Returns null for anything that is
// not well-formed. A well-formed frame with a DIFFERENT protocolVersion is
// returned with `_protocolMismatch: true` so the receiver can answer with an
// explicit version error instead of silently dropping it.
export function parseFrame(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.deviceId !== "string" || !raw.deviceId) return null;
  if (typeof raw.requestId !== "string" || !raw.requestId) return null;
  if (typeof raw.type !== "string" || !raw.type) return null;
  if (raw.payload === undefined || raw.payload === null) return null;
  if (typeof raw.payload !== "object") return null;
  return { ...raw, _protocolMismatch: raw.protocolVersion !== PROTOCOL_VERSION };
}

// Build an opaque relay frame (Mac ↔ phone envelope).
export function makeRelayFrame(from, requestId, { iv, data }) {
  return { v: PROTOCOL_VERSION, type: "relay", from, requestId, iv, data };
}

// Parse + validate an opaque relay frame. Returns null when malformed.
export function parseRelayFrame(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (raw.v !== PROTOCOL_VERSION) return null;
  if (raw.type !== "relay") return null;
  if (typeof raw.from !== "string" || !raw.from) return null;
  if (typeof raw.requestId !== "string" || !raw.requestId) return null;
  if (typeof raw.iv !== "string" || !raw.iv) return null;
  if (typeof raw.data !== "string" || !raw.data) return null;
  return raw;
}
