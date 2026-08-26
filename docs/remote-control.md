# 0x2F Remote Control — setup & testing walkthrough

Control 0x2F from your phone. v0.5 is **LAN-first**: the phone and the Mac
must be on the same local network — no relay, no tunnels, no accounts.

```text
Phone browser ── http://<mac's LAN IP>:4242 ──► Mac runtime
                (pairing page + E2E-encrypted envelopes)
```

- **Local 0x2F owns work.** Tasks, runs, agents, repositories and credentials
  stay on the Mac.
- **The Mac's runtime owns connectivity.** During pairing it becomes its own
  local relay: a phone on the same Wi-Fi gets the pairing page and speaks the
  same E2E-encrypted protocol the hosted relay uses — one remote-control
  implementation, two transports.
- **Web owns control.** The phone runs the same web client (the Attention
  Stack) and issues commands end-to-end encrypted; the Mac verifies every
  envelope (GCM, freshness, idempotency) before executing anything.

The hosted-relay path (for future remote use, or your own deployment) still
exists unchanged: `2f pair --relay https://…` / `--client https://…`, or the
`0X2F_RELAY_URL` / `0X2F_CLIENT_ORIGIN` env vars. Deployment details live in
[`deploy/README.md`](../deploy/README.md).

---

## Prerequisites

- Node.js ≥ 20 and a checkout of the 0x2F repository (this repo)
- The Mac and the phone on the **same Wi-Fi / local network**
- One terminal

---

## Step 1 — Create a test workspace

```bash
mkdir -p ~/test-2f && cd ~/test-2f
2f init
```

This creates `.work/` — 0x2F's state directory (tasks, events, configs). It
is gitignored and never committed.

---

## Step 2 — Pair

```bash
2f pair
```

No flags, no IPs to find, no relay to configure. `2f pair` detects the Mac's
private LAN address, enables the pairing surface on that interface, rotates
the Mac's credential, and prints:

```
0x2F PAIR

same Wi-Fi required

  http://192.168.1.163:4242/pair?relay=http%3A%2F%2F192.168.1.163%3A4242&token=XXXX...&device=...

code  ZEPQQ-N4WH8-NG4D
It expires ... and is one-time — a second phone re-pairs with 2f pair again.
```

> ⚠️ If a runtime for another workspace is already running on port 4242, add a
> dedicated port: `2f pair --port 4301`.

Verify the agent is connected:

```bash
tail -5 .work/ui.log
# expected line: relay: online (http://192.168.1.163:4242) — waiting for the phone to pair
```

---

## Step 3 — Open the pairing URL on your phone

On the phone (same Wi-Fi), open the printed URL and type the code. The dashes
are optional — `ZEPQQ-N4WH8-NG4D` and `ZEPQQN4WH8NG4D` are the same code.

**Quick check on the same Mac instead:** open the printed URL in a browser and
type the code — exercises the entire loop except the second device.

macOS may ask to allow incoming connections for `node` — allow it.

---

## Step 4 — Run the control loop

1. The phone shows an empty task list.
2. **Terminal:** `2f new "remote check"` → the task appears on the phone
   within a second as **WORKING**, then **READY** or **FAILED**.
3. Open the task — you see the execution trace, the ACTIVITY / FILES /
   COMMANDS sections, and the result.
4. On a READY task: **NOTE** (add a constraint) → **SEND BACK** (re-runs with
   the note in the next run's context via Task Continuity) → wait for READY
   again → **ACCEPT**.

---

## Step 5 — Offline test ("the Mac goes away")

Stop the runtime:

```bash
pkill -f "server-entry.mjs"
```

On the phone, within a couple of seconds: the **MAC OFFLINE** banner appears
over the phone's own last-known state, action buttons are disabled, and
mutating requests answer `503 Mac is offline…` (never queued — this is
deliberate: an explicit failure beats "you tapped SEND BACK now and it runs
15 minutes later").

To bring the Mac back, restart the runtime (`2f pair` or `2f ui
--no-browser`); the agent reconnects and the phone shows fresh state by
itself. No re-pairing is needed — a plain reconnect (same device credentials,
same pairing generation) never revokes the phone session.

---

## Step 6 — Revoking remote access

```bash
2f pair --off
```

This is a real revocation: the Mac asks its relay to kill every phone session
and pairing token, the agent disconnects, and the LAN surface closes within a
second (normal `2f` / `2f ui` stay loopback-only the whole time). The phone is
locked out immediately — even if the Mac reconnects with the same
credentials, the old sessions stay dead. Sessions also expire on their own
after 30 days. To control the Mac again, run `2f pair` (this rotates the
credential and the E2E key; the previous phone must claim the new code).

Re-running `2f pair` at any time rotates the device credential + token and the
E2E key, and retires the previous phone — that is how you switch phones.

---

## Step 7 — Hosted relay (future/remote, or your own deployment)

LAN is the v0.5 default. The hosted path is preserved and unchanged:

```bash
2f pair --relay https://relay.example.com --client https://app.example.com
```

or via environment: `0X2F_RELAY_URL` / `0X2F_CLIENT_ORIGIN`. A future release
can make `2f pair` choose the transport automatically — the pairing semantics
(URL + one-time code, token, session, E2E key) are identical.

---

## Automated tests

```bash
cd /path/to/0x2f
npm test        # the full suite, including relay/agent + pairing-security + lan-mode tests
npm run check   # syntax-check every source and test file
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No .work project found` | command run outside a workspace | `cd` into the project → `2f init` |
| `No private LAN address found` | the Mac has no private IPv4 (no Wi-Fi / no LAN) | connect to Wi-Fi and re-run `2f pair`, or use `--relay` for remote pairing |
| `The relay has not confirmed …` | the runtime is not up, or a foreign runtime owns the port | check `.work/ui.log`; pair with `--port <n>` if another workspace's runtime is on 4242 |
| Phone can't open the URL / "not found" | the phone is not on the same Wi-Fi, or the URL was truncated | re-run `2f pair`; verify the phone is on the same network as the Mac |
| `Agent watches the wrong .work/relay.json` | a runtime on port 4242 belongs to another workspace | pair with `--port 4301` |
| `Relay URL must use https://…` | a public plain-HTTP relay address was given | use `https://`, or `http://127.0.0.1` for loopback / a private-LAN address for LAN dev |
| `503 Mac is offline` on actions | the Mac is unreachable — by design | restart the runtime and wait for reconnection |
| Phone locked out after `2f pair --off` / re-pair | revocation or credential rotation — by design | run `2f pair` again and claim the new code on the phone |

---

## Security boundary (short version)

Pairing grants a phone a **session** (30-day TTL) that can observe the
REDACTED task/event projection and issue the same commands the local UI can —
but only while the Mac's agent is connected (offline commands fail
immediately, never queued) and only after the Mac verifies each command's
AES-GCM tag, freshness and idempotency. Every command, ack, event and
snapshot is end-to-end encrypted with a key derived from the pairing code, so
a passive observer on the Wi-Fi sees only ciphertext. Pairing tokens are
one-time and expire (10 min); the deviceSecret and the E2E key are rotated on
every `2f pair`; `2f pair --off` and re-pairing revoke all phone sessions.

**LAN mode is explicit and bounded.** The LAN surface exists only while a LAN
pairing is active (`2f pair` writes the config; `2f pair --off` closes it
within a second), only on private-LAN addresses (RFC 1918: 10/8, 172.16/12,
192.168/16), and serves only the static client + the relay protocol — the
normal local API stays loopback-only, so `2f ui` is never reachable from
other LAN devices. Plain `http://` on the LAN is the documented same-Wi-Fi
tradeoff: an active attacker on the network could intercept the pairing page
(the pairing code is typed into it), so LAN pairing is for trusted networks.
The hosted relay remains HTTPS-only.
