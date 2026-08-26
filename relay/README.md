# 0x2F Relay

The connectivity layer between a phone and a local 0x2F runtime on your Mac.
The relay is an **opaque broker**, not an execution authority.

```text
Phone client (client origin) ── HTTPS + E2E envelopes ──► 0x2F Relay ◄──
                          outbound WSS ── Mac agent (verifies every command)
```

**The relay can route and report availability. It cannot read, forge, or
store task content, and it cannot execute anything.** Every command, ack,
event and snapshot between the phone and the Mac is an end-to-end
AES-256-GCM envelope keyed by the pairing code — which the relay never sees
(the user types it into the trusted client page, which the relay does not
serve).

The implementation lives in `src/relay/server.mjs` and is shared: the local
product mounts it **in-process** for LAN-first pairing (v0.5 — a phone on the
same Wi-Fi talks to the Mac directly through the same protocol; see
[`docs/remote-control.md`](../docs/remote-control.md)), while this directory
is the **private hosted deployment** for future remote use — never shipped in
the npm package.

## Deployment requirements

- **Node.js ≥ 20** and the `ws` package (`npm install` inside this directory).
- **TLS in front of it.** The relay itself speaks plain HTTP/WS; terminate
  TLS with Caddy/nginx (recommended) or any reverse proxy. The Mac connects
  **outbound**, so no inbound ports, NAT rules, or static IPs are needed.
  A minimal Caddyfile:

  ```caddyfile
  relay.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```

- **The phone client is NOT served here.** The pairing page and the web
  client live on a separate **client origin** that you control (the hosted
  client origin by default — `src/relay/defaults.mjs`, see
  [`deploy/README.md`](../deploy/README.md); the local runtime
  `http://127.0.0.1:4242` for development). `2f pair --client <url>` points
  the pairing URL at it. Because the relay never serves the client, a
  compromised relay cannot substitute modified JavaScript at pairing time.
- **A state directory** (default `relay/data/state.json`) that persists across
  restarts: pairing tokens, phone sessions, and device identity only — **no
  task content**. It is written `0600`, is small and disposable, and losing it
  only means re-pairing the phone.

## Run

```bash
cd relay
npm install
node server.mjs --port 8080 --host 127.0.0.1 --data ./data/state.json
```

## Pairing

**v0.5 is LAN-first.** On the Mac, in the workspace you want remote control
over, run `2f pair` with no flags — it detects the Mac's private LAN address,
turns the Mac's runtime into its own local relay for the pairing window, and
prints a same-Wi-Fi URL + code (see
[`docs/remote-control.md`](../docs/remote-control.md)):

```bash
2f pair
```

The **hosted** path (future remote use, or your own deployment) is unchanged:
point the CLI at it with `--relay` / `--client` (or `0X2F_RELAY_URL` /
`0X2F_CLIENT_ORIGIN`) — the full runbook is in
[`deploy/README.md`](../deploy/README.md):

```bash
2f pair --relay https://relay.example.com --client https://client.example.com
```

It starts (or reuses) the 0x2F runtime, rotates the Mac's credential, prints a
short-lived URL **and a pairing code**. Open the URL on your phone (it loads
the trusted client page from the client origin) and type the code in; the
phone and the Mac each derive the E2E key from the code and confirm the
pairing with a signed handshake. `2f pair --off` revokes remote access at the
relay (see below).

**Transport policy:** the relay URL must be `https://`. Plain `http://` is
accepted only for explicit loopback development and private-LAN (RFC 1918)
pairing — the deviceSecret must not cross an unauthenticated path beyond the
same-Wi-Fi boundary.

## What pairing grants

A phone that completes pairing gets a session scoped to one Mac, and through
it the full remote-control surface: observe the REDACTED task/event projection
and issue the same commands the local UI can (`create`, `rerun`, `allow`,
`reject`, `answer`, `note`, `close`, `refine`, …). The Mac executes a remote
command **only after** verifying the envelope's AES-GCM tag with the confirmed
phone's key, its freshness (±5 min), and its `requestId` against the Mac's
persisted ack cache — so the relay cannot forge a command even if it is fully
compromised. Offline commands fail with 503, never queued.

## Credential lifetimes and revocation

| Credential | Lifecycle |
| --- | --- |
| `deviceSecret` | Long-lived Mac→relay transport credential. Rotated on **every** `2f pair` via `POST /api/devices/rotate`, authorized by the current secret. Never changes on plain reconnects. Stored in `.work/relay.json` (mode `0600`) on the Mac and in `state.json` (mode `0600`) here. |
| pairing token | 128-bit, one-time bootstrap credential. Always expires — the Mac's `tokenExpiresAt` (10 minutes) when provided, else the relay's TTL. Claimed once by a phone. |
| E2E key | Derived on both the Mac and the phone from the pairing code (PBKDF2-SHA256, 600k iterations) + the pairing token as salt. Rotated by every `2f pair` (new code). Never stored or transmitted via the relay. |
| phone session | Issued by claiming a token. Lives 30 days (`Max-Age` cookie or bearer secret + relay-side expiry) and is bound to the device's **generation**. |

- **Re-pairing** (`2f pair` again) rotates the secret + token + E2E key and
  bumps the device's generation, which retires every previous phone session
  and token — the old phone must re-claim the new token. This is what enforces
  *one phone at a time*.
- **Revoking** (`2f pair --off`) calls `POST /api/devices/revoke`
  (Mac-authenticated by the deviceSecret): every session and token for the
  device dies immediately, and the Mac drops its key. Even if the Mac
  reconnects with the same credentials afterwards, the pre-revocation
  sessions stay dead.
- **Reconnecting** (same `deviceSecret`, same generation — a Mac restart, an
  offline period) revokes nothing: the phone stays paired, as documented.

If the relay is unreachable when you run `2f pair --off`, revocation cannot be
delivered — the Mac disconnects anyway and the sessions expire on their own
(30 days). `relay/data/state.json` holds live credentials (deviceSecrets,
session secrets, pairing tokens): it is written `0600` and must never be
copied or committed.

## Security boundary — what this relay actually is

- It observes only: which device a session belongs to, online/offline state,
  and plaintext envelope routing metadata (`from`, `requestId`, sizes,
  timing).
- It **cannot** read command/task/event/result payloads (E2E encryption), and
  it **cannot** construct a valid command (GCM authentication — a forged or
  modified envelope is dropped by the Mac).
- It holds **no** task/event/result content and serves **no** client or
  pairing page.
- Commands are **never queued**: while the Mac is offline they fail
  immediately with 503.

Remaining assumptions (documented, not hidden): the Mac, the phone device,
and the client origin's served code are trusted. A relay that is malicious
**at the moment of pairing** and serves a modified client to the phone can
capture the code — the ceremony is the trust anchor. Ship the client from a
static origin you control (or a native app) to close this; a relay compromised
*after* pairing, or one that merely forwards, grants no authority.

## Remote protocol

Two frame kinds share `protocolVersion 2` (`../src/relay/protocol.mjs`):

- `hello` frames `{ protocolVersion, deviceId, requestId, type, payload }` —
  Mac ↔ relay transport authentication (deviceSecret).
- `relay` frames `{ v, type: "relay", from, requestId, iv, data }` — opaque
  end-to-end AES-256-GCM envelopes (see `../src/web/e2e.mjs`) between the
  phone and the Mac. The relay forwards phone envelopes to the Mac's `/ws`
  and Mac envelopes to the phone's SSE stream, correlating acks by
  `requestId`; it never inspects the ciphertext.

HTTP surface: `GET /api/pair/:token`, `POST /api/pair/claim`,
`POST /api/devices/rotate`, `POST /api/devices/revoke`,
`GET /api/status` (online/offline only), `POST /api/command` (forward an
envelope, return the encrypted ack), `GET /api/events` (SSE of Mac
envelopes). No static content.

## Tests

```bash
cd .. && npm test          # includes relay, e2e-security and pairing-security tests
```
