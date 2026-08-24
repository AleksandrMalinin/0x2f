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

It starts (or reuses) the 0x2F runtime, generates a one-time high-entropy
token, and prints a short-lived URL. Open that URL on your phone once; it
gets a session scoped to this Mac. `2f pair --off` disables remote control.

One phone at a time per Mac; re-running `2f pair` rotates the token and
re-pairs.

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

Mac → relay: `hello` (deviceSecret + pairing token), `snapshot` (listWork),
`event` (normalized Work events), `ack` (command results — the same JSON the
local API returns). Relay → Mac: `command` (ops map 1:1 onto the local API:
list, get, getRun, create, rerun, allow, reject, answer, note, close,
refine, providers, routing).

Every mutating command carries a client-generated `requestId`; the Mac keeps
a bounded idempotency cache and never executes the same key twice. `deviceId`
is protocol identity, deliberately separate from credentials, so
authentication can evolve without replacing the transport.

See `../src/relay/protocol.mjs` for the canonical definitions.

## Tests

```bash
cd .. && npm test          # includes relay/agent tests (test/relay.test.mjs)
```
