# 0x2F hosted endpoints — deployment

> **0x2F is LAN-first**: plain `2f pair` pairs a phone on the same Wi-Fi with
> no hosted infrastructure at all (the Mac's runtime becomes its own local
> relay — see `docs/remote-control.md`). This document is the **hosted**
> deployment: the future/remote path (and your own custom relay), reached
> with `2f pair --relay https://… --client https://…` or the
> `0X2F_RELAY_URL` / `0X2F_CLIENT_ORIGIN` env vars.

This is the minimal deployment that makes **`2f pair` just work on a real
phone**: the command prints a phone-openable **https** URL and a one-time
pairing code, no LAN IPs, no Caddy/nginx knowledge, no manual setup on the
user's side.

```text
Phone browser ── https ──► app.your.domain (client origin: static web client)
        │                      │ (the user types the pairing code into THIS page)
        ▼                      ▼
   relay.your.domain ◄── outbound wss ── Mac agent
   (routes only E2E-encrypted envelopes)
```

## Why two origins, not one service

The current trust model promises: **a compromised relay can neither read
phone ↔ Mac content nor forge commands**, because every envelope is
AES-256-GCM keyed by the pairing code, "which the relay never sees" — the
user types the code into a page the relay does not serve.

That last clause is load-bearing. If one service served both the relay API
*and* the pairing page/web client, a compromised relay could serve a
tampered pairing page, capture the code as it is typed, derive the E2E key,
and decrypt everything and forge commands. The origin split between the
client and the relay is therefore **necessary for the E2E guarantee**, not
administrative overhead — so the minimal model keeps exactly two origins:

| Origin | What it is | Why it is safe |
|---|---|---|
| `app.0x2f.dev` (client origin) | the static web client (pairing page + remote UI), built by `deploy/client/build.mjs` | no state, no secrets, no Node — a compromised relay cannot serve altered code from here |
| `relay.0x2f.dev` | the existing `relay/server.mjs` behind TLS | routes ciphertext only; the Mac connects **outbound** (no inbound ports, no NAT, no static IP) |

Everything else is already built and unchanged: the pairing ceremony, the
E2E key derivation, session/revocation, and `pair --off`.

## Why this is safe enough

1. **E2E phone ↔ Mac protection is untouched.** The code is typed into a
   page served by the client origin (not the relay); the key is derived
   in-browser; the relay routes AES-GCM ciphertext and correlates requestIds
   only. A compromised relay still cannot read or forge.
2. **HTTPS everywhere.** Both defaults are `https://`. The Mac's
   `deviceSecret` crosses TLS only. Plain `http://` remains blocked for
   anything but explicit loopback (`validateRelayUrl`) — insecure LAN HTTP is
   not re-enabled.
3. **The relay stays private.** It is not part of the npm package
   (`package.json` ships only `src/`); it is deployed separately, behind TLS.
4. **Revocation intact.** `2f pair --off` and credential rotation hit the
   relay over the network exactly as before; sessions still expire on their
   own (30 days) and re-pairing still retires the previous phone.
5. **The default flow stays `2f pair`.** Plain `2f pair` pairs over the local
   network (LAN-first); the hosted endpoints (`src/relay/defaults.mjs`) are
   used when `--relay` / `--client` or the `0X2F_RELAY_URL` /
   `0X2F_CLIENT_ORIGIN` env vars are given.

## Deploy (≈5 minutes, one small VPS)

1. **Build the client bundle** and upload it to your static host (or the
   VPS):

   ```bash
   node deploy/client/build.mjs        # -> deploy/client/dist/
   # static host: upload deploy/client/dist to the web root.
   # self-host:   scp -r deploy/client/dist root@vps:/srv/0x2f/client
   ```

2. **Run the relay** on the VPS (install `relay/`'s deps first): pick one of

   ```bash
   # systemd (deploy/relay.service) + Caddy, or manually:
   cd relay && npm install
   node server.mjs --port 8080 --host 127.0.0.1 --data /srv/0x2f/relay/state.json
   ```

3. **TLS**: edit `deploy/Caddyfile` (replace `app.0x2f.dev` /
   `relay.0x2f.dev` with your own hostnames), point both DNS records at the
   VPS, and run Caddy — it provisions Let's Encrypt certificates itself.
   The static client is served by Caddy; the relay process only ever sees
   `127.0.0.1`.

4. **Point the CLI at your deployment** (per machine, or bake your hostnames
   into `src/relay/defaults.mjs`):

   ```bash
   export 0X2F_RELAY_URL=https://relay.your.domain
   export 0X2F_CLIENT_ORIGIN=https://app.your.domain
   2f pair
   ```

   Open the printed URL on your phone, type the code — done. Nothing else.

## Verify without a phone (or with one)

`node scripts/verify-phone.mjs` starts the relay + client locally, exposes
both through public HTTPS quick tunnels (cloudflared, or localhost.run as a
fallback — real TLS, no account), runs the pairing ceremony and the
phone-side protocol client through the public URLs, and prints the pairing
URL + code. You can open that URL on your physical phone while the script
runs (`--manual` waits until the phone claims it). If the free tunnel
services are rate-limited or unavailable, `--local-tls` runs the identical
flow deterministically over local https (self-signed cert, two distinct
origins) — the same code paths minus the public DNS leg.

## Running the runtime on a dedicated always-on host

The 0x2F **runtime** (the local HTTP/SSE server that owns the Web UI, remote
control and startup recovery) is a foreground process:
`node src/server-entry.mjs <base> <port>` or the equivalent `2f serve
[port]`. It is deliberately NOT a detached daemon — a process supervisor
keeps it alive, which is what makes a mini PC / Mac mini a self-healing host:

- **Recovers from reboot/crash.** On startup the runtime marks every task
  left `working` with a dead worker pid as `failed` with the `crashed`
  classification (see `src/recover.mjs`), so a reboot never leaves an
  ambiguous "WORKING with no live run". Run history and any persisted
  `externalSessionId` are preserved; the task reruns normally afterward.
- **Graceful shutdown.** SIGTERM/SIGINT close the runtime cleanly (relay
  agent, HTTP server) and exit 0 **without terminating detached workers** —
  an in-flight run keeps executing and writes its outcome to the task state
  while the supervisor brings the runtime back up.
- **LAN pairing keeps working.** `2f pair` restarts a loopback-only runtime
  with SIGTERM; the supervisor respawns it, it re-reads `.work/relay.json`,
  and the LAN surface comes up on its own.

Two thin, equivalent service templates are provided — use whichever OS your
host runs; neither is the default:

| Host | Unit | Install |
|---|---|---|
| Linux (systemd) | `deploy/0x2f.service` | `sudo cp deploy/0x2f.service /etc/systemd/system/0x2f.service && sudo systemctl daemon-reload && sudo systemctl enable --now 0x2f` |
| macOS (launchd) | `deploy/0x2f.plist` | `cp deploy/0x2f.plist ~/Library/LaunchAgents/dev.0x2f.runtime.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.0x2f.runtime.plist` |

Both run `src/server-entry.mjs <base> <port>` under the logged-in/configured
user. **Run as the same user whose provider logins are valid** — claude,
codex and dsh keep credentials in that user's `$HOME` (provider auth is done
once, over SSH, and persists headless; re-auth after token expiry is the one
operation that still needs a terminal on the host). One runtime per
repository: add another unit on another port for a second workspace. Reserve
a static DHCP address for the host so the LAN pairing URL survives reconnects
(reconnects never require re-pairing; only a changed IP or the 30-day session
expiry does).

Logs: `journalctl -u 0x2f` (systemd), the `StandardOutPath` file (launchd),
or `.work/ui.log` / `.work/tasks/<slug>/run.log` inside the repository.
Update: `npm update -g 0x2f` then `systemctl restart 0x2f` /
`launchctl kickstart -k gui/$(id -u)/dev.0x2f.runtime` — project `.work/`
state survives updates untouched.
