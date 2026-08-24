# 0x2F Remote Control — setup & testing walkthrough

Control 0x2F from your phone while away from the laptop. The Mac keeps
running the work; the phone is a compact control surface.

```text
Phone browser ── HTTPS + existing API semantics ──► 0x2F Relay ◄── outbound
                                                      WebSocket ── Mac
```

- **Local 0x2F owns work.** Tasks, runs, agents, repositories and credentials
  stay on the Mac. The relay never becomes the Task source of truth.
- **Relay owns connectivity.** It forwards normalized events and proxies
  commands. It is disposable — a restart never loses Task state.
- **Web owns control.** The phone runs the same web client and speaks the
  same API semantics as the local UI.

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

Expected output — no warnings:

```
Pair this phone (open this URL on your phone):
  http://127.0.0.1:8080/pair/XXXX...
The pairing code expires ...
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
browser. The pairing page confirms the code automatically and opens the app.
This exercises the entire loop except the actual second network.

**Option B — a real phone on the same Wi-Fi:** restart the relay with network
access, then pair with the Mac's LAN address.

**Terminal A** (Ctrl+C, then):

```bash
node server.mjs --port 8080 --host 0.0.0.0 --data ./data/state.json
```

Find the Mac's LAN IP: `ipconfig getifaddr en0` (e.g. `192.168.1.5`), then
pair and open the URL from the phone:

```bash
2f pair --relay http://192.168.1.5:8080
```

macOS may ask to allow incoming connections for `node` — allow it. This is
plain HTTP without TLS, fine for a home-network smoke test; for "left home"
scenarios you need an HTTPS deployment (see `relay/README.md`).

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

On the phone, within a couple of seconds: the **MAC OFFLINE** banner appears,
action buttons are disabled, and mutating requests answer `503 Mac is
offline…` (never queued — this is deliberate: an explicit failure beats "you
tapped SEND BACK now and it runs 15 minutes later").

To bring the Mac back, restart the runtime (`2f pair …` or `2f ui
--no-browser`); the agent reconnects and the phone shows fresh state by
itself. No re-pairing is needed — the phone session is bound to the
`deviceId`, not to the token.

---

## Step 7 — Stop

- Relay: `Ctrl+C` in terminal A.
- Remote control: `2f pair --off` (the agent disconnects).
- The relay state file (`relay/data/state.json`) is a disposable cache — you
  can delete it; Tasks on the Mac are unaffected.

---

## Automated tests

```bash
cd /path/to/0x2f
npm test        # the full suite (323 tests), including 22 relay/agent integration tests
npm run check   # syntax-check every source and test file
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No .work project found` | command run outside a workspace | `cd` into the project → `2f init` |
| `The relay has not confirmed … (fetch failed)` | relay is not running / unreachable | start the relay (Step 1), `curl`-verify, re-run `2f pair` |
| No `relay: online` in `.work/ui.log` | relay unreachable, or the token expired (10 min) | bring the relay up, re-run `2f pair` |
| Agent watches the wrong `.work/relay.json` | a runtime on port 4242 belongs to another workspace | pair with `--port 4301` |
| Phone cannot open `http://…` | wrong network / no TLS | Option B (LAN, `--host 0.0.0.0`) or an HTTPS deployment |
| `503 Mac is offline` on actions | the Mac is unreachable — by design | restart the runtime and wait for reconnection |

---

## Security boundary (short version)

The relay necessarily observes what the remote surface needs to render —
task status, normalized events, progress/result text, file paths, NEEDS YOU
details. It never receives provider credentials, repository contents, or
execution authority: a mutating command only runs while the Mac's agent is
connected, and offline commands fail immediately instead of queueing. There
is no E2E encryption beyond HTTPS/WSS — see
[`relay/README.md`](../relay/README.md) for the full statement.
