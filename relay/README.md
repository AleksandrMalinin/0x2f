# 0x2F Relay

The connectivity/control layer between a phone browser and a local 0x2F
runtime on your Mac.

```text
Phone browser ── HTTPS (existing API semantics) ──► 0x2F Relay ◄── outbound
                                                      WebSocket ── Mac
```

**Local 0x2F owns work. Relay owns connectivity. Web owns control.**

The relay is deliberately NOT cloud 0x2f: it never sees provider credentials,
arbitrary repository contents, or execution authority. It holds only a
bounded last-known snapshot/event cache per device — restorable from the Mac
on every reconnect — and is disposable: Task state lives on the Mac, never
here.

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

- **A state directory** (default `relay/data/state.json`) that persists across
  restarts: pairing tokens, phone sessions, and the last-known cache. It is
  small and disposable — losing it only means re-pairing the phone; Task
  state is never here.

## Run

```bash
cd relay
npm install
node server.mjs --port 8080 --host 127.0.0.1 --data ./data/state.json
```

The web client is served from `../src/web/` by default — deploy the whole
repository (or point `--web` at a copy of `src/web/`).

## Pairing

On the Mac, in the workspace you want remote control over:

```bash
2f pair --relay https://relay.example.com
```

It starts (or reuses) the 0x2F runtime, rotates the Mac's credential, prints
a short-lived URL, and the phone claims it once. `2f pair --off` revokes
remote access at the relay (see below).

**Transport policy:** the relay URL must be `https://`. Plain `http://` is
accepted only for explicit localhost development (`127.0.0.1`, `localhost`,
`[::1]`) — the deviceSecret must never cross an unauthenticated network path.

## What pairing grants

A phone that completes pairing gets a session scoped to one Mac, and through
it the full remote-control surface: observe task state and normalized events,
and issue the same commands the local UI can (`create`, `rerun`, `allow`,
`reject`, `answer`, `note`, `close`, `refine`, …). Commands only execute while
the Mac's agent is connected (offline commands fail with 503, never queued).
The relay does not receive provider credentials, repository contents, or any
credential beyond the pairing token / deviceSecret.

## Credential lifetimes and revocation

| Credential | Lifecycle |
| --- | --- |
| `deviceSecret` | Long-lived Mac→relay credential. Rotated on **every** `2f pair` via `POST /api/devices/rotate`, authorized by the current secret (only a holder of the current secret can rotate). Never changes on plain reconnects. Stored in `.work/relay.json` (mode `0600`) on the Mac and in `state.json` (mode `0600`) here. |
| pairing token | 128-bit, one-time bootstrap credential. Always expires — the Mac's `tokenExpiresAt` (10 minutes) when provided, else the relay's TTL. Claimed once by a phone; a second claim fails. |
| phone session | Issued by claiming a token. Lives 30 days (`Max-Age` cookie + relay-side expiry) and is bound to the device's **generation**. |

- **Re-pairing** (`2f pair` again) rotates the secret + token and bumps the
  device's generation, which retires every previous phone session and token —
  the old phone must re-claim the new token. This is what enforces *one phone
  at a time*.
- **Revoking** (`2f pair --off`) calls `POST /api/devices/revoke`
  (Mac-authenticated by the deviceSecret): every session and token for the
  device dies immediately. Sessions can never silently become valid again —
  even if the Mac reconnects with the same credentials afterwards, the
  pre-revocation sessions stay dead. Re-enabling is an explicit re-pair.
- **Reconnecting** (same `deviceSecret`, same generation — a Mac restart, an
  offline period) revokes nothing: the phone stays paired, as documented.
  Re-pairing is only needed when you rotate credentials or change phones.

If the relay is unreachable when you run `2f pair --off`, revocation cannot be
delivered — the Mac disconnects anyway and the sessions expire on their own
(30 days). `relay/data/state.json` holds live credentials (deviceSecrets,
session cookies, pairing tokens): it is written `0600` and must never be
copied or committed.

## Security boundary — documented, not pretended

The relay necessarily observes the Task/control information required to
render the remote surface: task status, normalized events, result/progress
text, file paths, and NEEDS YOU details. That is what it forwards. It must
**not** receive:

- provider credentials (they never leave the Mac);
- arbitrary repository contents (only small event payloads cross the wire);
- execution authority independent of the connected Mac (a mutating command
  only ever runs if the Mac's agent is connected; offline commands fail
  immediately with 503, they are never queued).

There is no E2E encryption beyond HTTPS/WSS. The pairing token is the only
credential a phone presents, and it is consumed on first use.

## Remote protocol

One versioned JSON envelope over the WebSocket (`/ws`):

```text
{ protocolVersion, deviceId, requestId, type, payload }
```

Mac → relay: `hello` (deviceSecret + pairing token + tokenExpiresAt),
`snapshot` (listWork), `event` (normalized Work events), `ack` (command
results — the same JSON the local API returns). Relay → Mac: `command` (ops
map 1:1 onto the local API: list, get, getRun, create, rerun, allow, reject,
answer, note, close, refine, providers, routing).

Every mutating command carries a client-generated `requestId`; the Mac keeps
a bounded idempotency cache and never executes the same key twice. `deviceId`
is protocol identity, deliberately separate from credentials, so
authentication can evolve without replacing the transport.

See `../src/relay/protocol.mjs` for the canonical definitions.

## Tests

```bash
cd .. && npm test          # includes relay/agent tests (test/relay.test.mjs)
```
