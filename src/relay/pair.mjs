// `2f pair` — one-time device pairing for remote control.
//
// Accountless by design: pairing is a short-lived, high-entropy token printed
// by the Mac, bound to the Mac's outbound relay connection, and presented by
// the phone exactly once. No accounts, no passwords, no relay-side identity.
//
// Flow:
//   1. ensure `.work/relay.json` exists with a stable deviceId + deviceSecret
//      (generated once; the secret is the Mac's long-lived credential to the
//      relay — pairing is the bootstrap, not the permanent identity model);
//   2. generate a fresh one-time token and write it into the config;
//   3. make sure the UI runtime is running (it runs the relay agent, which
//      polls the config and connects to the relay with the new token);
//   4. wait until the relay confirms the token is registered (the agent's
//      hello reached it);
//   5. print the pairing URL for the phone.
//
// `2f pair --off` disables remote control (the agent goes idle on its next
// config poll) without touching the device identity.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ensureRuntime } from "../ui.mjs";

export const PAIR_TTL_MS = 10 * 60 * 1000;

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

export async function pairDevice({
  base,
  url,
  port = 4242,
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
  if (!/^https?:\/\//.test(relayUrl)) {
    throw new Error("Relay URL must start with https:// (or http:// for local development).");
  }

  cfg.url = relayUrl;
  cfg.enabled = true;
  cfg.deviceId ??= crypto.randomUUID();
  cfg.deviceSecret ??= crypto.randomBytes(32).toString("base64url");
  cfg.agentName ??= os.hostname?.() ?? "0x2f-mac";
  const token = crypto.randomBytes(16).toString("base64url");
  cfg.token = token;
  cfg.tokenExpiresAt = new Date(Date.now() + tokenTtlMs).toISOString();

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  // The runtime runs the relay agent; start (or reuse) it, then wait for the
  // agent's hello to register the token at the relay.
  await ensure({ base, port });

  const pairUrl = `${relayUrl}/pair/${token}`;
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

  return { url: pairUrl, token, expiresAt: cfg.tokenExpiresAt, registered };
}

export async function pairOff({ base }) {
  const configPath = path.join(base, ".work", "relay.json");
  const cfg = await readConfig(configPath);
  cfg.enabled = false;
  delete cfg.token;
  delete cfg.tokenExpiresAt;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return configPath;
}
