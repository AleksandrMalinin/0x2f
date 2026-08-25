# 0x2F Remote Control — setup & testing walkthrough

Control 0x2F from your phone while away from the laptop. The Mac keeps
running the work; the phone is a compact control surface.

```text
Phone browser ── HTTPS + existing API semantics ──► 0x2F Relay ◄── outbound
                                                      WebSocket ── Mac
```

- **Local 0x2F owns work.** Tasks, runs, agents, repositories and credentials
  stay on the Mac. The relay never becomes the Task source of truth.
- **Relay owns connectivity only.** It routes encrypted envelopes and reports
  availability. It is disposable, holds no task content, and a restart never
  loses Task state.
- **Web owns control.** The phone runs the same web client (served by the
  client origin — never the relay) and issues commands end-to-end encrypted.

This document walks the full flow from a clean machine to the first remote
`ACCEPT`. Deployment details live in [`relay/README.md`](../relay/README.md).

---

## Prerequisites

- Node.js ≥ 20
- A checkout of the 0x2F repository (this repo)
- Two terminals: **A** keeps the relay running (leave it open), **B** runs
  the `2f` commands

---

## Step 0 — Install dependencies (once)

**Terminal A:**

```bash
cd /path/to/0x2f          # repository root
npm install               # installs ws for the agent and the test suite
cd relay
npm install               # installs ws for the relay
```

If the `2f` command is not on your PATH, install the CLI globally from the
repository root: `npm install -g .`

---

## Step 1 — Start the relay

**Terminal A** (keep it open):

```bash
cd /path/to/0x2f/relay
node server.mjs --port 8080 --data ./data/state.json
```

Expected output:

```
0x2F Relay: http://127.0.0.1:8080
```

**Terminal B** — verify the relay is alive:

```bash
curl -m 2 http://127.0.0.1:8080/api/pair/test
# expected: {"registered":false,"claimed":false,"expiresAt":null}
```

If you get `Failed to connect`, the relay is not running — see the
troubleshooting table below.

---

## Step 2 — Create a test workspace

**Terminal B:**

```bash
mkdir -p ~/test-2f && cd ~/test-2f
2f init
```

This creates `.work/` — 0x2F's state directory (tasks, events, configs). It
is gitignored and never committed.

---

## Step 3 — Pair the Mac with the relay

**Terminal B, inside the workspace** (`~/test-2f`):

```bash
2f pair --relay http://127.0.0.1:8080
```

Expected output — no warnings (the URL points at the CLIENT ORIGIN — the
local runtime by default — and carries the relay + token; the code is typed
into that trusted page and never crosses the relay):

```
Open this URL on your phone (the pairing page is served by the
client origin — never by the relay):
  http://127.0.0.1:4242/pair?relay=http%3A%2F%2F127.0.0.1%3A8080&token=XXXX...&device=...

Pairing code:  XXXXXXXXXXXXXX
It expires ...
```

Verify the agent actually connected:

```bash
tail -5 .work/ui.log
# expected line: relay: online (http://127.0.0.1:8080)
```

> ⚠️ If a runtime for another workspace is already running on port 4242, add
> a dedicated port to the pairing command: `2f pair --relay http://127.0.0.1:8080 --port 4301`.
> The agent binds to the workspace whose runtime is running.

---

## Step 4 — Open the pairing URL on your "phone"

**Option A — quick check on the same Mac:** open the printed URL in a
browser, type the pairing code into the page, and the app opens paired. This
exercises the entire loop except the actual second network.

**Option B — a real phone on the same Wi-Fi:** restart the relay with network
access, then pair with the Mac's LAN address — but remember the relay URL
must be `https://` unless it is explicit localhost. For a home-network smoke
test either run the relay on the same machine you open the browser on
(`http://127.0.0.1:8080`), or put the relay behind TLS (Caddy/nginx, see
`relay/README.md`) and pair with that URL:

```bash
node server.mjs --port 8080 --host 0.0.0.0 --data ./data/state.json   # behind TLS
```

macOS may ask to allow incoming connections for `node` — allow it.

---

## Step 5 — Run the control loop

1. The browser shows an empty task list.
2. **Terminal B:** `2f new "remote check"` → the task appears on the "phone"
   within a second as **WORKING**, then **READY** or **FAILED**.
3. Open the task — you see the execution trace, the ACTIVITY / FILES /
   COMMANDS sections, and the result.
4. On a READY task: **NOTE** (add a constraint) → **SEND BACK** (re-runs with
   the note in the next run's context via Task Continuity) → wait for READY
   again → **ACCEPT**.

---

## Step 6 — Offline test ("left the laptop")

**Terminal B:**

```bash
pkill -f "server-entry.mjs"
```

On the phone, within a couple of seconds: the **MAC OFFLINE** banner appears
over the phone's own last-known state, action buttons are disabled, and
mutating requests answer `503 Mac is offline…` (never queued — this is
deliberate: an explicit failure beats "you tapped SEND BACK now and it runs
15 minutes later").

To bring the Mac back, restart the runtime (`2f pair …` or `2f ui
--no-browser`); the agent reconnects and the phone shows fresh state by
itself. No re-pairing is needed — a plain reconnect (same device credentials,
same pairing generation) never revokes the phone session.

## Step 7 — Revoking remote access

```bash
2f pair --off
```

This is a real revocation, not just a local disconnect: the Mac asks the
relay to kill every phone session and pairing token for this Mac, and the
agent disconnects. The phone is locked out immediately — even if the Mac
reconnects afterwards with the same credentials, the old sessions stay dead.
Sessions also expire on their own after 30 days. To control the Mac from a
phone again, run `2f pair` again (this rotates the Mac's credential and
starts a fresh pairing; the previous phone must claim the new code).

Re-running `2f pair` at any time rotates the device credential + token and
the E2E key, and retires the previous phone — that is how you switch phones.

## Step 8 — Stop

- Relay: `Ctrl+C` in terminal A.
- The relay state file (`relay/data/state.json`) is a disposable cache — you
  can delete it; Tasks on the Mac are unaffected. It holds live credentials
  (device secrets, session cookies, pairing tokens), is written `0600`, and
  must never be copied or committed.

---

## Automated tests

```bash
cd /path/to/0x2f
npm test        # the full suite (345 tests), including relay/agent + pairing-security tests
npm run check   # syntax-check every source and test file
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No .work project found` | command run outside a workspace | `cd` into the project → `2f init` |
| `The relay has not confirmed … (fetch failed)` | relay is not running / unreachable | start the relay (Step 1), `curl`-verify, re-run `2f pair` |
| `No relay: online` in `.work/ui.log` | relay unreachable, or the token expired (10 min) | bring the relay up, re-run `2f pair` |
| `Agent watches the wrong .work/relay.json` | a runtime on port 4242 belongs to another workspace | pair with `--port 4301` |
| `Relay URL must use https://…` | a plain-HTTP relay address was given | use `https://`, or `http://127.0.0.1` for localhost dev |
| Pairing page says the link is incomplete | the client origin is unreachable or the URL was truncated | run `2f pair` again and use `--client <url>` for a deployed client origin |
| `The relay rejected the current device credential` | relay state was reset / identity mismatch | `2f pair` falls back to a fresh identity automatically |
| Phone cannot open `http://…` | wrong network / no TLS | an HTTPS deployment, or localhost dev |
| `503 Mac is offline` on actions | the Mac is unreachable — by design | restart the runtime and wait for reconnection |
| Phone locked out after `2f pair --off` / re-pair | revocation or credential rotation — by design | run `2f pair` again and claim the new code on the phone |

---

## Security boundary (short version)

Pairing grants a phone a **session** (30-day TTL) that can observe the
REDACTED task/event projection and issue the same commands the local UI can —
but only while the Mac's agent is connected (offline commands fail
immediately, never queued) and only after the Mac verifies each command's
AES-GCM tag, freshness and idempotency. **The relay is an untrusted
transport**: every command, ack, event and snapshot is end-to-end encrypted
with a key derived from the pairing code (which the relay never sees), so a
compromised relay can neither read remote task content nor execute actions on
the Mac. Pairing tokens are one-time and expire (10 min); the deviceSecret and
the E2E key are rotated on every `2f pair`; `2f pair --off` and re-pairing
revoke all phone sessions at the relay. See
[`relay/README.md`](../relay/README.md) for the full statement.
