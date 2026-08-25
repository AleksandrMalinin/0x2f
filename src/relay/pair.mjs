// `2f pair` — one-time device pairing for remote control.
//
// Accountless by design: pairing is a short-lived, high-entropy token printed
// by the Mac, bound to the Mac's outbound relay connection, and presented by
// the phone exactly once. No accounts, no passwords, no relay-side identity.
//
// Credential lifecycle (hardened):
//   - `.work/relay.json` holds the stable deviceId + deviceSecret + the
//     current one-time pairing token. It is written with mode 0600: the
//     deviceSecret is the Mac's long-lived credential to the relay.
//   - EVERY `2f pair` rotates BOTH the deviceSecret and the token. The new
//     secret is registered at the relay through POST /api/devices/rotate,
//     authorized by the CURRENT deviceSecret — so only a party that already
//     holds the current secret can rotate it. Rotation also retires every old
//     phone session (re-pairing = a new phone) at the relay.
//   - The relay URL must be https://, or http:// for explicit localhost
//     development only (127.0.0.1 / localhost / [::1]). The deviceSecret
//     must never cross a plaintext network path.
//   - `2f pair --off` calls the relay's revoke endpoint so remote access is
//     actually revoked (sessions + tokens die at the relay), then disables
//     the local connection. Sessions also expire on their own (30 days).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ensureRuntime } from "../ui.mjs";
import { generateCode } from "../web/e2e.mjs";

export const PAIR_TTL_MS = 10 * 60 * 1000;
// Only loopback hosts may use plain http:// — the secret crosses the wire.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readConfig(configPath) {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

// Private state: mode 0600 (owner read/write only) — the file holds the
// deviceSecret and a live pairing token. Chmod even when the file exists, so
// a file left world-readable by an older version is tightened.
async function writeConfig(configPath, cfg) {
  const json = JSON.stringify(cfg, null, 2) + "\n";
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, json, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
}

// Validate the relay URL: https anywhere; http ONLY for explicit loopback
// development. Everything else is refused — the deviceSecret must not cross
// an unauthenticated network path.
export function validateRelayUrl(relayUrl) {
  let parsed;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return "Relay URL is not a valid URL.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return "Relay URL must use https:// (http:// is allowed only for localhost development).";
}

// Rotate the device credential at the relay: authorize with the CURRENT
// deviceSecret, present the nextSecret + a fresh one-time token. The relay
// retires every old session and token and registers the new token.
async function rotateDevice({ url, deviceId, deviceSecret, nextSecret, token, tokenExpiresAt, fetchImpl = fetch, log = console }) {
  const res = await fetchImpl(`${url}/api/devices/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      deviceSecret,
      nextSecret,
      token,
      tokenExpiresAt
    })
  });
  if (res.status === 401) {
    // The relay does not recognize this Mac (fresh relay, or the secret was
    // already rotated elsewhere). The caller decides whether to start a fresh
    // identity.
    const info = await res.json().catch(() => ({}));
    const err = new Error(`The relay rejected the current device credential (${info.error ?? "unauthorized"}).`);
    err.code = "ROTATE_REJECTED";
    throw err;
  }
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw new Error(`The relay refused the credential rotation (${info.error ?? res.status}).`);
  }
  return res.json();
}

export async function pairDevice({
  base,
  url,
  port = 4242,
  client,
  tokenTtlMs = PAIR_TTL_MS,
  waitMs = 30000,
  pollMs = 750,
  fetchImpl = fetch,
  ensure = ensureRuntime,
  log = console
} = {}) {
  const configPath = path.join(base, ".work", "relay.json");
  const cfg = await readConfig(configPath);

  const relayUrl = (url ?? cfg.url ?? "").replace(/\/+$/, "");
  if (!relayUrl) {
    throw new Error(
      "Relay URL is required — pass --relay <https://relay.example.com> the first time you pair."
    );
  }
  const urlError = validateRelayUrl(relayUrl);
  if (urlError) throw new Error(urlError);

  // The phone client origin: where the pairing page + client live. The relay
  // never serves it — the E2E trust surface is outside the relay's control.
  // Defaults to the local runtime (practical for local development: the same
  // machine's browser pairs with a local relay).
  const clientOrigin = (client ?? cfg.clientOrigin ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(clientOrigin)) {
    throw new Error("Client origin must start with https:// (or http:// for localhost).");
  }

  cfg.url = relayUrl;
  cfg.clientOrigin = clientOrigin;
  cfg.enabled = true;
  cfg.deviceId ??= crypto.randomUUID();
  cfg.agentName ??= os.hostname?.() ?? "0x2f-mac";

  const token = crypto.randomBytes(16).toString("base64url");
  const tokenExpiresAt = new Date(Date.now() + tokenTtlMs).toISOString();
  // The E2E pairing code: typed into the trusted client page, never sent
  // anywhere. Key = PBKDF2(code, salt = token) on both the Mac and the phone.
  const code = generateCode();

  if (cfg.deviceSecret) {
    // Re-pair: rotate the deviceSecret AND the token at the relay, authorized
    // by the current secret. If the relay no longer recognizes this Mac, start
    // a fresh identity (bootstrap) instead of getting stuck.
    const nextSecret = crypto.randomBytes(32).toString("base64url");
    try {
      await rotateDevice({
        url: relayUrl,
        deviceId: cfg.deviceId,
        deviceSecret: cfg.deviceSecret,
        nextSecret,
        token,
        tokenExpiresAt,
        fetchImpl
      });
      cfg.deviceSecret = nextSecret;
    } catch (error) {
      if (error?.code === "ROTATE_REJECTED") {
        log.warn(
          `relay: ${error.message} — starting a fresh device identity for this Mac.`
        );
        cfg.deviceId = crypto.randomUUID();
        cfg.deviceSecret = crypto.randomBytes(32).toString("base64url");
      } else {
        // The relay is unreachable: fail closed — the config is NOT rewritten,
        // so the previous credentials remain valid.
        throw new Error(
          `Could not rotate this Mac's credential at the relay (${error.message}). ` +
            "Is the relay reachable? Nothing was changed — retry when it is."
        );
      }
    }
  } else {
    // First pairing: a fresh identity. The relay registers it when the agent's
    // hello arrives; the token is the bootstrap credential.
    cfg.deviceSecret ??= crypto.randomBytes(32).toString("base64url");
  }

  cfg.token = token;
  cfg.tokenExpiresAt = tokenExpiresAt;
  cfg.code = code;
  cfg.phoneId = null;
  cfg.pairing = "pending";

  await writeConfig(configPath, cfg);

  // The runtime runs the relay agent; start (or reuse) it, then wait for the
  // agent's hello to register the token at the relay.
  await ensure({ base, port });

  const pairUrl =
    `${clientOrigin}/pair?relay=${encodeURIComponent(relayUrl)}` +
    `&token=${encodeURIComponent(token)}&device=${encodeURIComponent(cfg.deviceId)}`;
  const deadline = Date.now() + waitMs;
  let registered = false;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${relayUrl}/api/pair/${token}`);
      if (res.ok) {
        const info = await res.json();
        if (info.registered) {
          registered = true;
          break;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(pollMs);
  }

  if (!registered) {
    log.warn(
      `The relay has not confirmed the pairing token yet (${lastError ?? "no answer"}). ` +
        "The runtime may still be starting, or the relay may be unreachable. " +
        "The token will register as soon as the agent connects — you can still open the URL on your phone."
    );
  }

  return { url: pairUrl, token, code, expiresAt: cfg.tokenExpiresAt, registered };
}

export async function pairOff({ base, fetchImpl = fetch, timeoutMs = 4000, log = console }) {
  const configPath = path.join(base, ".work", "relay.json");
  const cfg = await readConfig(configPath);

  // Revoke at the relay FIRST: the Mac authenticates with its deviceSecret
  // and asks the relay to kill every phone session and pairing token. Best
  // effort — if the relay is unreachable, remote access still ends the moment
  // the agent disconnects, and sessions expire on their own (30 days).
  if (cfg.url && cfg.deviceId && cfg.deviceSecret) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${cfg.url.replace(/\/+$/, "")}/api/devices/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ deviceId: cfg.deviceId, deviceSecret: cfg.deviceSecret })
        });
        if (!res.ok) {
          log.warn(`relay: revoke returned ${res.status} — phone sessions may remain until they expire.`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      log.warn(
        `relay: could not reach the relay to revoke remote access (${error instanceof Error ? error.message : String(error)}) — ` +
          "phone sessions will expire on their own."
      );
    }
  }

  // Disable the local connection, drop the live token and the E2E ceremony
  // state (the identity — deviceId/deviceSecret — is kept for re-pairing).
  cfg.enabled = false;
  delete cfg.token;
  delete cfg.tokenExpiresAt;
  delete cfg.code;
  delete cfg.phoneId;
  delete cfg.pairing;
  await writeConfig(configPath, cfg);
  return configPath;
}
