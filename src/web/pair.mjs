// The pairing ceremony, running on the TRUSTED client origin (never the
// relay): derive the E2E key from the code the user types, claim the relay
// session, and confirm the pairing with a signed pair-hello the Mac verifies.
// The code never leaves this page — only the derived key material is used.

import {
  deriveKeyRaw,
  importKey,
  encrypt,
  decrypt,
  b64encode,
  randomId
} from "/app/e2e.mjs";

const STORE_KEY = "0x2f.remote";

const params = new URLSearchParams(location.search);
const relayUrl = params.get("relay");
const token = params.get("token");
const deviceId = params.get("device");

const input = document.getElementById("code");
const go = document.getElementById("go");
const statusEl = document.getElementById("status");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = "pair-status" + (isError ? " err" : "");
}

function setBusy(busy) {
  go.disabled = busy;
  input.disabled = busy;
}

// A single command attempt; the requestId is fixed so a retry never double-
// executes even if the first attempt actually reached the Mac.
async function sendCommand(key, phoneId, requestId, plaintext) {
  const { iv, data } = await encrypt(key, plaintext, { from: phoneId, requestId });
  const res = await fetch(`${relayUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + sessionSecret },
    body: JSON.stringify({ requestId, from: phoneId, iv, data })
  });
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    const err = new Error(info.error ?? "HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  const frame = await res.json();
  const ack = await decrypt(key, frame, { from: deviceId, requestId });
  if (!ack) throw new Error("Could not verify the Mac's confirmation.");
  return ack;
}

let sessionSecret = null;

async function pair(code) {
  if (!relayUrl || !token || !deviceId) {
    setStatus("This pairing link is incomplete — run 2f pair again.", true);
    return;
  }
  setBusy(true);
  try {
    setStatus("Deriving the pairing key…");
    const raw = await deriveKeyRaw(code, token);
    const key = await importKey(raw);
    const phoneId = randomId();

    setStatus("Claiming the relay session…");
    const claimRes = await fetch(`${relayUrl}/api/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, phoneId })
    });
    if (!claimRes.ok) {
      const info = await claimRes.json().catch(() => ({}));
      setStatus(info.error ?? "Pairing failed — the code may be invalid, already used, or expired.", true);
      return;
    }
    const { session } = await claimRes.json();
    sessionSecret = session;

    // Confirm with the Mac: a signed pair-hello. While the Mac is offline the
    // relay answers 503; retry with the SAME requestId (idempotent) — never
    // queue on the relay, never execute twice.
    const requestId = randomId();
    setStatus("Confirming with your Mac…");
    for (;;) {
      try {
        const ack = await sendCommand(key, phoneId, requestId, {
          cmd: "pair-hello",
          token,
          phoneId,
          ts: Date.now()
        });
        if (!ack.ok) {
          setStatus(ack.error ?? "Your Mac declined the pairing.", true);
          return;
        }
        break;
      } catch (error) {
        if (error.status === 503) {
          setStatus("Waiting for your Mac to come online… (this retries automatically)");
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        setStatus(error.message, true);
        return;
      }
    }

    // Paired. Hand the session + key to the app and open the remote surface.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ relayUrl, session, phoneId, deviceId, key: b64encode(raw) })
    );
    location.href = "/";
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
}

go.addEventListener("click", () => {
  const code = input.value.trim().toUpperCase();
  if (!code) return;
  pair(code);
});
input.addEventListener("keydown", e => {
  if (e.key === "Enter") go.click();
});
input.focus();
