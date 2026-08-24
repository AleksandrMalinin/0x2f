// Remote control protocol — the Mac ↔ relay wire contract.
//
// One versioned JSON envelope for every frame, both directions:
//
//   { protocolVersion, deviceId, requestId, type, payload }
//
//   protocolVersion   the wire protocol this frame speaks (hard gate)
//   deviceId          the stable local 0x2F instance id (never a credential)
//   requestId         correlation id — for `command`/`ack` it is the
//                     client-generated idempotency key
//   type              hello | snapshot | event | ack | command
//   payload           type-specific object
//
// Mac → relay:
//   hello     { protocolVersion, apiVersion, agentName, deviceSecret, token }
//             deviceSecret is the long-lived Mac credential (generated at
//             first pairing); token is the current one-time pairing token
//             (used only to register an unregistered device, never to
//             authenticate an already-registered one).
//   snapshot  { base, tasks, at }            listWork shape
//   event     { event }  |  { events: [...] }  normalized Work event(s)
//   ack       { ok: true, status, body } | { ok: false, status, error }
//             body is exactly what the local HTTP API would have returned.
//
// Relay → Mac:
//   hello     { ok: true, protocolVersion, apiVersion, serverTime }
//             | { ok: false, error, protocolVersion? }
//   command   { op, taskId?, body }
//             op ∈ the existing local API routes: list, get, getRun, create,
//             rerun, allow, reject, answer, note, close, refine, providers,
//             routing. The Mac executes it through the SHARED core actions —
//             the relay layer never reimplements Task logic.
//
// Frame identity is deliberately split: `deviceId`/`requestId` are stable
// protocol concepts, while authentication (deviceSecret/token) lives in the
// hello payload, so auth can evolve without replacing the transport.

export const PROTOCOL_VERSION = 1;

// The 0x2f API surface version the agent implements. Bumped whenever the
// command op set or ack shapes change. The relay records it and surfaces
// mismatch loudly; it is NOT a hard gate like protocolVersion.
export const API_VERSION = "0.6";

// Ops map 1:1 onto the local HTTP API. The relay and agent share this list so
// a new surface operation can never silently diverge from core actions.
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
  "routing"
]);

// Ops that mutate Task state. After one of these the agent pushes a fresh
// snapshot so the relay's last-known view cannot drift from canonical state.
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

// Parse + validate an incoming frame string. Returns null for anything that
// is not a well-formed frame (the caller decides whether that is an ignore or
// a fatal error). A well-formed frame with a DIFFERENT protocolVersion is
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
