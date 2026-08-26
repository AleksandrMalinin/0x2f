// End-to-end remote-control crypto — the phone ↔ Mac channel.
//
// One shared symmetric key per pairing, derived from a short human-entered
// code (typed into a trusted client page — NEVER transmitted) and the pairing
// token (relay-visible, used only as salt/domain separation). Every remote
// message (command, ack, event, snapshot) is an AES-256-GCM envelope that
// provides BOTH authentication and confidentiality in one primitive. The
// relay routes opaque envelopes and cannot read or forge them.
//
// This module runs in BOTH the browser client and the Node agent (Node ≥ 20
// exposes the same Web Crypto API), so there is exactly one implementation of
// the wire crypto — with one deliberate fallback:
//
//   WebCrypto's `subtle` API is only available in SECURE CONTEXTS (https, or
//   http://localhost). A phone pairing page served over plain http on the
//   Mac's LAN address is NOT a secure context, so `crypto.subtle` is absent
//   there. In that case this module falls back to the vendored pure-JS
//   implementation (@noble/hashes + @noble/ciphers in ./vendor/), which is
//   standard-compliant and byte-compatible with WebCrypto — the derived key
//   and the GCM envelopes are identical either way, so a phone on the LAN and
//   a Mac on https interop seamlessly.
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
import { hmac } from "./vendor/@noble/hashes/hmac.js";
import { sha256 } from "./vendor/@noble/hashes/sha2.js";
import { gcm } from "./vendor/@noble/ciphers/aes.js";

// 32 chars, no look-alikes: 0 O 1 I L are excluded.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 14;
// OWASP Password Storage Cheat Sheet: PBKDF2-HMAC-SHA256 → 600,000 iterations.
export const PBKDF2_ITERATIONS = 600_000;

const g = globalThis;

// Test hook: force the pure-JS fallback even where WebCrypto exists, so the
// LAN-phone code path is exercised by the suite. Production never calls it.
let forceNoble = false;
export function _forceNobleFallback(value = true) {
  forceNoble = Boolean(value);
}

// True when WebCrypto's subtle API is usable (secure contexts: https /
// localhost / Node). On a plain-http LAN page it is absent — the pure-JS
// fallback below produces identical results.
function hasSubtle() {
  if (forceNoble) return false;
  return typeof g.crypto?.subtle?.importKey === "function" && typeof g.crypto?.subtle?.deriveBits === "function";
}

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
  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();
  // Insecure contexts (plain-http LAN) lack crypto.randomUUID; build a v4
  // UUID from getRandomValues, which is available everywhere. Used for
  // request correlation only — never for key material.
  const b = g.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function generateCode(length = CODE_LENGTH) {
  const bytes = g.crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

// Display grouping for a pairing code ("ZEPQQ-N4WH8-NG4D"). Purely cosmetic —
// the derivation uses the RAW (ungrouped) code; the pairing page strips
// dashes/whitespace from whatever the user types, so both forms work.
export function formatCode(code) {
  const clean = String(code).replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const groups = clean.match(/.{1,5}/g);
  return groups ? groups.join("-") : clean;
}

// The pairing code → 32 raw key bytes. Same derivation on the Mac and the
// phone; only the user (and the two trusted devices) ever see the code.
export async function deriveKeyRaw(code, token) {
  const enc = new TextEncoder();
  if (hasSubtle()) {
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
  // Pure-JS fallback (plain-http LAN page): standard PBKDF2-HMAC-SHA256 —
  // identical bytes to the WebCrypto path above (pinned by tests). The loop
  // yields to a REAL macrotask every `yieldEvery` iterations, so the phone's
  // renderer can paint the pairing status instead of freezing for the seconds
  // the 600k iterations take (a microtask-only yield would starve it).
  return pbkdf2WithYield(enc.encode(code), enc.encode(token), {
    c: PBKDF2_ITERATIONS,
    dkLen: 32
  });
}

// PBKDF2-HMAC-SHA256 over the vendored hmac primitive, yielding to the event
// loop between batches. RFC 2898: U1 = PRF(P, S || INT_32_BE(i)); Ui =
// PRF(P, U(i-1)); T_i = U1 ^ U2 ^ … ^ Uc. SHA-256 output is 32 bytes.
async function pbkdf2WithYield(password, salt, { c, dkLen, yieldEvery = 2048 }) {
  const out = new Uint8Array(dkLen);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  const view = new DataView(block.buffer);
  for (let i = 1, pos = 0; pos < dkLen; i++, pos += 32) {
    view.setUint32(salt.length, i, false);
    const t = hmac(sha256, password, block); // U1
    let prev = t;
    for (let j = 1; j < c; j++) {
      const next = hmac(sha256, password, prev); // Uj
      for (let k = 0; k < t.length; k++) t[k] ^= next[k];
      prev = next;
      if (j % yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
    }
    out.set(t.subarray(0, Math.min(t.length, dkLen - pos)), pos);
  }
  return out;
}

// Wrap raw key bytes for encrypt/decrypt. Returns { subtle } when WebCrypto
// is usable (secure contexts), else { raw } for the pure-JS fallback — the
// wire format is identical either way.
export async function importKey(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (hasSubtle()) {
    return {
      subtle: await g.crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt"
      ])
    };
  }
  return { raw: bytes };
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
  const plain = new TextEncoder().encode(JSON.stringify(plaintext));
  let data;
  if (key?.subtle) {
    data = new Uint8Array(
      await g.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key.subtle, plain)
    );
  } else {
    data = gcm(key.raw, iv, aad).encrypt(plain);
  }
  return { iv: b64encode(iv), data: b64encode(data) };
}

// Decrypt an envelope; returns the plaintext object or null when the tag does
// not verify (wrong key, tampered data, or a mismatched from/requestId).
export async function decrypt(key, envelope, { from, requestId }) {
  try {
    const aad = buildAad({ from, requestId });
    let data;
    if (key?.subtle) {
      data = new Uint8Array(
        await g.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64decode(envelope.iv), additionalData: aad },
          key.subtle,
          b64decode(envelope.data)
        )
      );
    } else {
      data = gcm(key.raw, b64decode(envelope.iv), aad).decrypt(b64decode(envelope.data));
    }
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}
