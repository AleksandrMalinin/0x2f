// `2f pair` — one-time device pairing for remote control.
//
// Accountless by design: pairing is a short-lived, high-entropy token printed
// by the Mac, bound to the Mac's outbound relay connection, and presented by
// the phone exactly once. No accounts, no passwords, no relay-side identity.
//
// Transports (v0.5):
//   - LAN (default): the phone and the Mac are on the same local network.
//     `2f pair` detects the Mac's private LAN address, writes the LAN
//     transport into `.work/relay.json`, and the runtime becomes the Mac's
//     OWN relay (src/server.mjs) — the phone talks to http://<lan-ip>:<port>
//     directly through the same protocol the hosted relay speaks.
//   - Hosted (future/remote): `--relay <url>` / `--client <url>` (or the
//     0X2F_RELAY_URL / 0X2F_CLIENT_ORIGIN env vars) pair through your hosted
//     relay, unchanged.
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
//   - The relay URL must be https://, or http:// for loopback and private-LAN
//     (10/8, 172.16/12, 192.168/16) development. On the LAN the deviceSecret
//     crosses the local Wi-Fi in plaintext — that is the explicit, documented
//     tradeoff of the same-Wi-Fi boundary; public addresses must always use
//     https://.
//   - `2f pair --off` calls the relay's revoke endpoint so remote access is
//     actually revoked (sessions + tokens die at the relay), then disables
//     the local connection. Sessions also expire on their own (30 days).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { ensureRuntime } from "../ui.mjs";
import { generateCode } from "../web/e2e.mjs";
import { defaultRelayUrl, defaultClientOrigin } from "./defaults.mjs";
import { isPrivateLanIp, detectLanAddress } from "./lan.mjs";

export const PAIR_TTL_MS = 10 * 60 * 1000;
// Loopback hosts may use plain http:// — the secret crosses the wire only
// on the local machine.
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
// development and private-LAN (same-Wi-Fi) pairing. Everything else is
// refused — the deviceSecret must not cross an unauthenticated network path.
export function validateRelayUrl(relayUrl) {
  let parsed;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return "Relay URL is not a valid URL.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && (LOOPBACK_HOSTS.has(parsed.hostname) || isPrivateLanIp(parsed.hostname))) {
    return null;
  }
  return "Relay URL must use https:// (http:// is allowed only for localhost and private-LAN development).";
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
  lan = false,
  networkInterfaces,
  killImpl = killRuntime,
  tokenTtlMs = PAIR_TTL_MS,
  waitMs = 30000,
  pollMs = 750,
  fetchImpl = fetch,
  ensure = ensureRuntime,
  log = console
} = {}) {
  const configPath = path.join(base, ".work", "relay.json");
  const cfg = await readConfig(configPath);

  // Transport choice: --lan forces LAN; --relay / --client / the hosted env
  // vars force the hosted relay; otherwise v0.5 pairs over the local network
  // (LAN-first). The pairing semantics — URL + one-time code, token, session,
  // E2E key — are identical across transports.
  const explicitHosted = Boolean(url || client || process.env["0X2F_RELAY_URL"] || process.env["0X2F_CLIENT_ORIGIN"]);
  const transport = lan || !explicitHosted ? "lan" : "hosted";

  let relayUrl;
  let clientOrigin;
  let lanPort = port;
  if (transport === "lan") {
    const lanIp = detectLanAddress(networkInterfaces);
    if (!lanIp) {
      throw new Error(
        "No private LAN address found — connect this Mac to Wi-Fi (or a local " +
          "network) and re-run `2f pair`, or pass --relay <https://…> for remote pairing."
      );
    }
    // The Mac's runtime IS the relay on the LAN: one origin, one port. The
    // phone loads the pairing page and speaks the relay protocol to the same
    // URL — the hosted flow, byte for byte. If the requested port is owned by
    // another workspace's runtime, pick the next free one automatically — the
    // user only ever opens the printed URL.
    lanPort = await pickLanPort(base, port, fetchImpl);
    if (lanPort !== port) {
      log.warn(
        `Port ${port} is used by another 0x2F runtime or process — pairing on port ${lanPort} instead.`
      );
    }
    relayUrl = `http://${lanIp}:${lanPort}`;
    clientOrigin = relayUrl;
  } else {
    relayUrl = (url ?? cfg.url ?? defaultRelayUrl()).replace(/\/+$/, "");
    clientOrigin = (client ?? cfg.clientOrigin ?? defaultClientOrigin()).replace(/\/+$/, "");
  }
  if (!relayUrl) {
    throw new Error(
      "Relay URL is required — pass --relay <https://relay.example.com> the first time you pair."
    );
  }
  const urlError = validateRelayUrl(relayUrl);
  if (urlError) throw new Error(urlError);

  // The phone client origin: where the pairing page + client live. In hosted
  // mode the relay never serves it — the E2E trust surface is outside the
  // relay's control. On the LAN the Mac itself serves both (it IS the trusted
  // party there); local development can pass `--client http://127.0.0.1:<port>`.
  if (!/^https?:\/\//.test(clientOrigin)) {
    throw new Error("Client origin must start with https:// (or http:// for localhost).");
  }

  cfg.url = relayUrl;
  cfg.clientOrigin = clientOrigin;
  cfg.transport = transport;
  cfg.enabled = true;
  cfg.deviceId ??= crypto.randomUUID();
  cfg.agentName ??= os.hostname?.() ?? "0x2f-mac";

  const token = crypto.randomBytes(16).toString("base64url");
  const tokenExpiresAt = new Date(Date.now() + tokenTtlMs).toISOString();
  // The E2E pairing code: typed into the trusted client page, never sent
  // anywhere. Key = PBKDF2(code, salt = token) on both the Mac and the phone.
  const code = generateCode();

  // LAN mode: the Mac's runtime IS the relay, so on a RE-PAIR the relay must
  // be up before the rotate call can reach it. Write the LAN config first
  // (keeping the current secret/token — the previous pairing stays intact if
  // the rotate then fails), bring the runtime up, rotate, and only then
  // finalize the config with the new credential. Hosted mode is unchanged:
  // the hosted relay is external and always reachable.
  if (transport === "lan" && cfg.deviceSecret) {
    await writeConfig(configPath, {
      ...cfg,
      url: relayUrl,
      clientOrigin,
      transport,
      enabled: true
    });
    await ensureLanRuntime({ base, port: lanPort, ensure, fetchImpl, killImpl });
  }

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
        // The relay is unreachable: fail closed — the previous credentials
        // remain valid (in LAN mode the config still holds the OLD secret and
        // token, so an existing phone pairing is untouched).
        const lanHint =
          transport === "lan"
            ? " (LAN mode: the Mac's runtime hosts the relay — check .work/ui.log)"
            : "";
        throw new Error(
          `Could not rotate this Mac's credential at the relay (${error.message}). ` +
            `Is the relay reachable${lanHint}? Nothing was changed — retry when it is.`
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

  // The runtime runs the relay agent; start (or reuse) it. In LAN mode the
  // runtime must be serving the LAN surface (a runtime started before pairing
  // binds loopback only, so restart it once — it re-reads this config and
  // comes up LAN-enabled). On a LAN re-pair the runtime is already up from
  // the pre-rotate step; ensureLanRuntime reuses it and the agent picks up
  // the new config on its next poll.
  if (transport === "lan") {
    await ensureLanRuntime({ base, port: lanPort, ensure, fetchImpl, killImpl });
  } else {
    await ensure({ base, port });
  }

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
    const hint =
      transport === "lan"
        ? ` (the LAN pairing surface at ${relayUrl} is not answering — is the runtime up? ` +
          "check .work/ui.log)"
        : url
          ? ""
          : ` (the hosted relay at ${relayUrl} may not be deployed or reachable — set ` +
            "0X2F_RELAY_URL or pass --relay; see deploy/README.md)";
    log.warn(
      `The relay has not confirmed the pairing token yet (${lastError ?? "no answer"})${hint}. ` +
        "The runtime may still be starting, or the relay may be unreachable. " +
        "The token will register as soon as the agent connects — you can still open the URL on your phone."
    );
  }

  return { url: pairUrl, token, code, expiresAt: cfg.tokenExpiresAt, registered, transport };
}

// Stop the detached runtime for this workspace+port. Used by LAN mode to
// restart a loopback-only runtime so it comes up serving the LAN surface.
// The command line is the identity (same pattern the verify script uses).
function killRuntime(base, port) {
  const child = spawn("pkill", ["-f", `server-entry.mjs ${base} ${port}`]);
  child.on("error", () => {});
  return child;
}

// In LAN mode the runtime hosts the relay, so it must be running with the
// LAN surface before pairing can proceed. Start (or reuse) it; a runtime
// started before pairing binds loopback only, so restart it once — the fresh
// spawn re-reads the config and comes up LAN-enabled.
async function ensureLanRuntime({ base, port, ensure, fetchImpl, killImpl }) {
  const e1 = await ensure({ base, port });
  let lanUp = false;
  try {
    const h = await fetchImpl(`http://127.0.0.1:${port}/api/health`).then(r =>
      r.ok ? r.json() : null
    );
    lanUp = Boolean(h?.lan);
  } catch {
    /* runtime may still be starting — the fresh spawn below handles it */
  }
  if (e1.status === "reused" && !lanUp) {
    await killImpl(base, port);
    // The kill is a signal — the dying runtime still owns the port for a
    // moment, and a probe in that window would reuse it (and then vanish).
    // Wait until the port is actually free before the fresh spawn.
    await waitForPortDown(port);
    await ensure({ base, port });
  }
}

// What is on a port, for LAN port selection:
//   "free"    nothing answers (or the fetch failed) — spawn here;
//   "same"    THIS workspace's 0x2F runtime — reuse it (it will be restarted
//             in place if it is not LAN-enabled);
//   "foreign" another workspace's 0x2F runtime — never touch it;
//   "other"   some non-0x2F process owns the port.
async function probeLanPort(base, port, fetchImpl) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
    if (!res.ok) return { kind: "other" };
    const h = await res.json();
    if (h?.ok !== true || h?.mode !== "local") return { kind: "other" };
    return h.base === base ? { kind: "same" } : { kind: "foreign" };
  } catch {
    return { kind: "free" };
  }
}

// Pick the port the LAN pairing will use: the requested port when it is free
// or owned by THIS workspace's runtime (which `2f pair` may restart in
// place), otherwise the next free port. A foreign runtime keeps serving its
// own workspace — the phone just opens whatever port the printed URL says.
async function pickLanPort(base, port, fetchImpl, maxProbe = 20) {
  for (let p = port; p < port + maxProbe; p++) {
    const probe = await probeLanPort(base, p, fetchImpl);
    if (probe.kind === "free" || probe.kind === "same") return p;
  }
  throw new Error(
    `No free port found for LAN pairing (tried ${port}–${port + maxProbe - 1}). ` +
      "Stop some processes and re-run `2f pair`."
  );
}

// True when nothing is listening on the port (a TCP connect is refused).
function portFree(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const socket = net.connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

async function waitForPortDown(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portFree(port)) return;
    if (Date.now() > deadline) return; // give up — ensure() surfaces the real state
    await sleep(100);
  }
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
