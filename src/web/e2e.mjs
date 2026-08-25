// End-to-end remote-control crypto — the phone ↔ Mac channel.
//
// One shared symmetric key per pairing, derived from a short human-entered
// code (typed into a trusted client page — NEVER transmitted) and the pairing
// token (relay-visible, used only as salt/domain separation). Every remote
// message (command, ack, event, snapshot) is an AES-256-GCM envelope that
// provides BOTH authentication and confidentiality in one primitive. The
// relay routes opaque envelopes and cannot read or forge them.
//
// This module runs in BOTH the browser client (Web Crypto) and the Node
// agent (Node ≥ 20 exposes the same Web Crypto API), so there is exactly one
// implementation of the wire crypto.
//
// Envelope (JSON, plaintext routing header + opaque ciphertext):
//   { v, type: "relay", from, requestId, iv, data }
//   from        phoneId (phone → Mac) or deviceId (Mac → phone)
//   requestId   correlation + idempotency key (also inside AAD)
//   iv/data     AES-256-GCM ciphertext (tag appended by the primitive)
//
// Authenticated metadata (AAD) uses a FIXED byte encoding — a version byte
// followed by 1-byte-length-prefixed UTF-8 fields in a fixed order — so the
// two sides never depend on JSON canonicalization. Changing field order or
// adding fields is a protocol version bump.
//
// KDF parameters (validated, not guessed): PBKDF2-HMAC-SHA256 with 600,000
// iterations — the current OWASP recommendation for PBKDF2 (Password Storage
// Cheat Sheet). The code is 14 characters from a 32-character unambiguous
// alphabet (no 0/O/1/I/L) = ~70 bits of entropy; with 600k PBKDF2 iterations,
// offline brute force of a captured envelope is infeasible. Key derivation
// happens once per pairing on each side, so the iteration cost (~0.2–1 s) is
// paid only at pairing time.

import { PROTOCOL_VERSION } from "../relay/protocol.mjs";

// 32 chars, no look-alikes: 0 O 1 I L are excluded.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 14;
// OWASP Password Storage Cheat Sheet: PBKDF2-HMAC-SHA256 → 600,000 iterations.
export const PBKDF2_ITERATIONS = 600_000;

const g = globalThis;

function b64encode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return g.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = g.atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { b64encode, b64decode };

export function randomId() {
  return g.crypto.randomUUID();
}

export function generateCode(length = CODE_LENGTH) {
  const bytes = g.crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

// The pairing code → 32 raw key bytes. Same derivation on the Mac and the
// phone; only the user (and the two trusted devices) ever see the code.
export async function deriveKeyRaw(code, token) {
  const enc = new TextEncoder();
  const base = await g.crypto.subtle.importKey(
    "raw",
    enc.encode(code),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await g.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(token),
      iterations: PBKDF2_ITERATIONS
    },
    base,
    256
  );
  return new Uint8Array(bits);
}

// Wrap raw key bytes as an AES-GCM CryptoKey (usable for encrypt/decrypt).
export function importKey(raw) {
  return g.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}

// Fixed, unambiguous encoding of the authenticated metadata. Field order is
// part of the wire contract; a change is a protocol version bump.
export function buildAad({ from, requestId }) {
  const enc = new TextEncoder();
  const parts = [Uint8Array.from([PROTOCOL_VERSION])];
  for (const field of [String(from), String(requestId)]) {
    const b = enc.encode(field);
    if (b.length > 255) throw new Error("AAD field too long");
    parts.push(Uint8Array.from([b.length]), b);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Encrypt one plaintext object into { iv, data } (base64url strings).
export async function encrypt(key, plaintext, { from, requestId }) {
  const iv = g.crypto.getRandomValues(new Uint8Array(12)); // 96-bit GCM nonce
  const aad = buildAad({ from, requestId });
  const data = await g.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext))
  );
  return { iv: b64encode(iv), data: b64encode(new Uint8Array(data)) };
}

// Decrypt an envelope; returns the plaintext object or null when the tag does
// not verify (wrong key, tampered data, or a mismatched from/requestId).
export async function decrypt(key, envelope, { from, requestId }) {
  try {
    const aad = buildAad({ from, requestId });
    const data = await g.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(envelope.iv), additionalData: aad },
      key,
      b64decode(envelope.data)
    );
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}
