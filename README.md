# 0x2F

0x2F is a local work router for coding agents. Give it engineering work —
"Inspect why retries restart the whole run" — and it routes the task to a
coding harness on your machine, runs it in the background, and tracks it
through the lifecycle until you close it. **You work in terms of tasks, not
agent sessions.**

`0x2F` is hex for the ASCII `/` (47). The CLI is `2f`.

Node.js ≥ 20, one dependency (`ws`), no build step, local-first.

```text
                          0x2F

   Desktop                          Mobile
   2f CLI · Web UI             phone browser
        \                     (remote control,
         \   one task,          via your relay —
          \  many runs           outbound WS)
           \                      /
            └──────────┬─────────┘
                       │
        ┌──────────────┴──────────────┐
        │         Task runtime        │
        │   state · runs · events     │
        │   permissions · decisions   │
        └──────────────┬──────────────┘
                       │  one worker per run
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
   claude-code      codex          deepseek-harness   gemini
                        │ any ACP / command agent
        └──────────────┼──────────────┘
                       ▼
              your local project
```

The task is the persistent unit of work. Each run is one disposable agent
session through one harness. 0x2F keeps the task coherent across runs, exposes
what the agent is doing, surfaces decisions when human attention is required,
and lets you intervene — without treating every agent session as a separate
piece of work.

## Why it exists

A coding harness gives you an agent session: you start one, watch it, and
either accept its output or start another session that has forgotten
everything. 0x2F inverts that. The **task** is the object — a description of
engineering work that persists in the repository. Agent sessions are
disposable execution underneath it. A task can be run again through a
different harness, corrected with notes, and continued with prior results in
context — because the task, not the session, is what 0x2F keeps.

## How a task works

```text
                    ┌────────────────────────────────────┐
                    ▼                                    │
 WORKING ───────────────► READY / FAILED ────────────────┘
    │                                (2f close → DONE)
    │  the agent needs a human
    ▼
 NEEDS YOU
   ├─ PERMISSION  → 2f allow | 2f reject
   │                the same run/session continues
   └─ DECISION    → 2f answer (recorded with the task)
                    rerun the task to continue with it in context
```

A task that hits something the agent cannot decide alone becomes **NEEDS YOU**.
`2f open <id>` (or the Web UI) shows what it is asking for. There are two
distinct interactions:

- **PERMISSION** — a concrete operation needing authorization (an edit, a
  command). `2f allow <id>` / `2f reject <id>` answers it and the same run
  continues.
- **DECISION** — the agent cannot continue without your judgment.
  `2f answer <id> "<your answer>"` records your answer with the task. A
  decision is never allow/rejected.

The decision request is a machine-read protocol, not prose. Agents signal one
by ending with:

```text
## Needs human decision
REQUIRED: yes
QUESTION: <the concrete question a human must answer>
```

Anything else — a bare heading, "None", "No decision required", or any prose —
is treated as **no** decision, so a finished run completes READY instead of
interrupting you for work that did not need you.

`2f close <id>` (or **CLOSE** in the Web UI) removes any task from active
attention — a wrong NEEDS YOU, a non-resumable one, a FAILED or READY run you
no longer want. It never resumes the provider and never starts a new
execution.

## One task, many runs

Every execution is recorded as a **run** under the task, so the same task can
be run again — through a different harness, for comparison:

```text
Task  "Investigate why retries restart the whole run"
  ├── run 01 · claude-code         a fresh session
  ├── run 02 · deepseek-harness    a fresh session
  └── run 03 · claude-code         a fresh session, with your notes
                                   and prior results in context
```

```bash
2f rerun 1 --provider deepseek-harness   # run 02 under task #1
2f open 1 --run 2                        # one run's factual detail
```

A new run is a **continuation of the task, not a blank attempt**: its input
(`runs/<n>/prompt.md`) is rebuilt from current task state — the original
request plus your constraints/answers and prior runs' results, verification
and changed files — and handed to a fresh provider session. The task is
persistent; provider sessions are disposable. Add a constraint with
`2f note <id> "<constraint>"` (or `2f answer` on a decision block); it becomes
part of the next run's context, with no manual copying. The original
`prompt.md` is never overwritten.

## The terminal client

`2f tui` is the full-screen surface: the whole ledger on the left, the
selected task in full on the right, and — pinned to the bottom of the detail
pane — the one action that task is waiting for.

```bash
2f tui                     # or: 2f tui --light
```

It is a client, not a second runtime. It builds the same runtime every other
command builds, calls the same shared actions, and tails the same event logs
the Web server tails — so a run finishing in the background, a `2f allow`
typed in another terminal and a tap on your phone all land in it live, and
anything you do in it lands everywhere else.

The keymap is the surface's own, not a file manager's:

| key | what it does |
| --- | --- |
| `j` `k` | move between tasks (`g` / `G` jump to first / last) |
| `J` `K` | scroll the task detail |
| `tab` | filter — all · needs you · failed · ready · working |
| `/` | search by title, brief or number |
| `↵` | the one action this task is waiting for (shown bottom-left) |
| `x` | the alternative — reject · save only · send back · drop |
| `d` | changes — the real diff of the working tree, or the planned write |
| `c` | note or correct — kept on the task, carried into every later run |
| `p` | point the next run at another provider |
| `t` | expand the trace of the current run |
| `n` | new task (`⇧↵` inserts a newline, `⌥↵` expands your note into a brief, `↵` starts it) |
| `?` | the key list · `q` detaches — runs keep executing without you |

`↵` is deliberately not "open": on a permission it ALLOWS, on a decision it is
ANSWER & CONTINUE, on a READY task it ACCEPTS, on a FAILED one it RETRIES. The
alternative under `x` is the other half of the same pair. Both go through the
shared actions, so the TUI can never allow something the CLI would refuse.

## Desktop + mobile

The CLI, the TUI and the Web are three surfaces over the same core:

```bash
2f ui                      # or: 2f ui <port>, 2f ui --no-browser
```

`2f ui` behaves like opening a local application: if a 0x2F runtime is already
healthy on `http://127.0.0.1:4242` (localhost only) it reuses it; otherwise it
starts the runtime in the background, waits until it is healthy, and opens the
UI. Runtime output lands in `.work/ui.log`. The browser calls the same shared
actions over a local HTTP/SSE API and subscribes to the same normalized
events.

Control 0x2F from your phone on the **same Wi-Fi** — the Mac keeps running
the work; the phone is a compact control surface:

```bash
2f pair
```

No flags, no IPs to find, no relay to configure. `2f pair` detects the Mac's
private LAN address, enables the pairing surface on that interface (and only
while pairing is active), and prints a phone-openable URL **plus a one-time
pairing code**:

```
0x2F PAIR

same Wi-Fi required

  http://192.168.1.163:4242/pair?relay=…&token=…&device=…

code  ZEPQQ-N4WH8-NG4D
```

Open the URL on your phone and type the code into the trusted page (served by
the Mac itself). The phone then speaks the same Web UI against the Mac: see
NEEDS YOU / WORKING / READY / FAILED, open a task, and ANSWER / ALLOW /
REJECT / NOTE / SEND BACK / ACCEPT. Every command, ack, event and snapshot is
end-to-end encrypted (AES-256-GCM keyed by the pairing code) — the same
encrypted channel the hosted relay uses, so a passive observer on the Wi-Fi
sees only ciphertext. While the Mac is offline the phone shows its own
last-known state with a **MAC OFFLINE** banner and disables actions; commands
are never queued, and a retried command reuses its `requestId` so it can
never execute twice.

Pairing tokens are one-time and expire in 10 minutes; phone sessions live 30
days and are revoked by `2f pair --off` (a real revocation — the LAN surface
closes within a second, and normal `2f` / `2f ui` stay loopback-only the whole
time) or by re-pairing, which also rotates the Mac's credential and the E2E
key. The LAN surface serves only the pairing client + relay protocol on
private-LAN addresses (RFC 1918) — the normal local API is never reachable
from other devices on the network.

For **remote control away from the LAN** (future use, or your own
deployment), the hosted relay path is unchanged: `2f pair --relay https://…`
/ `--client https://…`, or the `0X2F_RELAY_URL` / `0X2F_CLIENT_ORIGIN` env
vars (see [`deploy/README.md`](deploy/README.md)). The hosted relay is
**private infrastructure, not part of the local product**: a small standalone
app that forwards encrypted envelopes, holds no task state, and is never
shipped in the npm package. Deployment details live in
[`relay/README.md`](https://github.com/AleksandrMalinin/0x2f/blob/main/relay/README.md);
a full setup-and-test walkthrough is in
[`docs/remote-control.md`](https://github.com/AleksandrMalinin/0x2f/blob/main/docs/remote-control.md).

## Install

Requires **Node.js ≥ 20** and at least one coding harness on your PATH:
[Claude Code](https://code.claude.com/docs) (`claude`) is the built-in
default, [Codex](https://github.com/openai/codex) (`codex`),
[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (`dsh`)
and [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
are also built in, and any ACP-compatible agent or headless executable
can be added per project (see [Providers](#providers)). 0x2F itself is one
small package — `ws` is its only dependency, no build step, no accounts, no
daemon.

```bash
npm install -g 0x2f        # the `2f` command lands on your PATH
```

`npx --yes 0x2f ...` works for a one-off, but install globally for regular
use — `2f` is a local app you invoke repeatedly, not a one-shot script.

## Quick start

Inside the repository you want to work on:

```bash
2f init                          # create .work/ with project.md and rules.md
2f new "Investigate why retries restart the whole run"
2f                               # list tasks
2f open 1                        # run detail, history, result
2f tui                           # open the terminal client (full screen)
2f ui                            # open the Web UI (starts the local runtime)
```

To run a task with the built-in Codex provider, install the
[Codex CLI](https://github.com/openai/codex), sign in, and select it explicitly:

```bash
codex login
2f providers                     # confirm: codex  native  yes
2f new "Audit the auth flow" --provider codex
```

Codex runs headlessly with workspace-write sandboxing by default and supports
same-thread resume. Its structured-event and permission boundaries are
documented in [`docs/codex-capability-map.md`](docs/codex-capability-map.md).

To run a task with the built-in Gemini CLI provider, install the
[Gemini CLI](https://github.com/google-gemini/gemini-cli), authenticate once
(run `gemini` interactively, or set `GEMINI_API_KEY` / Vertex credentials),
and select it explicitly:

```bash
gemini          # first run: sign in interactively
2f providers    # confirm: gemini  native  yes
2f new "Audit the auth flow" --provider gemini
```

Gemini runs headlessly (`-p --skip-trust -o stream-json`), auto-approves
file edits (`--approval-mode auto_edit`; override with `GEMINI_APPROVAL_MODE`),
and supports same-session resume by UUID. Its structured-event, permission
and resume boundaries are documented in
[`docs/gemini-capability-map.md`](docs/gemini-capability-map.md).

`2f init` creates `.work/` with `project.md`, `rules.md`, `knowledge.md`,
`decisions.md` and `providers/` — edit `project.md` and `rules.md` once;
every task prompt is built from them. It also tells you which provider will
run, or what to install if none is available.

If `2f new` refuses with "Execution provider ... is unavailable", no harness
is on PATH — install one, or configure a provider (see
[Providers](#providers)).

## Where your work lives

Everything 0x2F knows about a project lives in `.work/` inside that
repository — nothing is stored globally, and nothing leaves your machine
unless you opt into remote pairing:

| What | Where |
| --- | --- |
| task state + run history | `.work/tasks/<slug>/` |
| project context every prompt is built from | `project.md` · `rules.md` · `knowledge.md` · `decisions.md` |
| routing policy (optional — you author it; `2f init` does not create it) | `.work/routing.json` |
| extra providers | `.work/providers/*.json` |
| UI runtime log | `.work/ui.log` |
| pairing credentials (only if you pair) | `.work/relay.json` |

Delete `.work/` to remove 0x2F's state from a project — your source files
are never touched.

## Updating and uninstalling

```bash
npm update -g 0x2f              # or: npm install -g 0x2f@latest
npm uninstall -g 0x2f           # removes the CLI; project .work/ stays
```

Project `.work/` state survives uninstalls — it belongs to the project, not
to the install.

## Providers

0x2F has three provider integration paths behind one contract:

| Integration | What it is | Use |
| --- | --- | --- |
| **Native** | Deep adapter for one harness's specific capabilities | `claude-code` (permissions → `needs_you` → same-session resume), `codex` (structured exec events + thread resume), `deepseek-harness`, `gemini` (structured stream events + UUID session resume) |
| **ACP** | One generic provider speaking the [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio | Any ACP-compatible agent — Cursor, OpenCode — configured by manifest |
| **Command** | One generic provider for headless executables | Any CLI that takes a prompt and prints a result — configured by manifest |

`claude-code`, `codex`, `deepseek-harness` and `gemini` are built in.
Everything else is added **declaratively**: drop one JSON manifest into
`.work/providers/` and it becomes a provider — no source changes:

```json
{
  "id": "cursor",
  "displayName": "Cursor",
  "transport": "acp",
  "command": ["agent", "acp"]
}
```

ACP manifests may set `"permissions"`: `"interactive"` (default — a permission
request pauses the run and asks you), `"deny"`, or `"approve"` (headless
auto-resolution). Command manifests must pass the task through the `{prompt}`
placeholder. Commands are spawned as argv arrays, never through a shell.
Verified example manifests live in [`examples/providers/`](https://github.com/AleksandrMalinin/0x2f/blob/main/examples/providers/README.md);
`2f providers` lists every provider with its integration type and availability.

By default `2f new` uses the configured routing default. When it is `auto`,
0x2F picks the harness deterministically: available providers first, then the
ids listed in `.work/routing.json` in order, then registry order. It does not
read the task text and never claims a provider is "best" — the decision is
persisted with the run and shown by `2f open` / the Web UI. Override any time:

```bash
2f new "Audit the auth flow" --provider auto        # deterministic routing
2f new "Audit the auth flow" --provider claude-code # explicit
```

```json
// .work/routing.json
{
  "default": "auto",                       // "auto" or a provider id
  "prefer": ["claude-code", "deepseek-harness"]
}
```

`routing.json` is optional and hand-authored. `2f init` does not create it,
and `2f new` runs fine without it — the routing default (or an explicit
`--provider`) applies until you write the file yourself. No command edits it;
edit the JSON directly if you want non-default routing policy.

## Architecture

```text
CLI · TUI · Web · phone
    │   shared actions + normalized events
    ▼
Work Core          lifecycle · actions · runs · events · store
    │
    ▼
Router             AUTO: availability + routing config (deterministic)
    │
    ▼
Execution node     local machine (spawns the detached worker)
    │
    ▼
Provider           native · ACP · command
    │
    ▼
Coding harness     claude-code · codex · dsh · gemini · cursor · any command
```

No surface implements lifecycle or provider logic — the CLI, the terminal
client (`src/tui/`) and the browser all call the same shared actions (`src/core/actions.mjs`) and read the same
normalized events (`src/core/events.mjs`). Everything a task needs persists
under `.work/` in the repository you run 0x2F in: task state and run history
(`.work/tasks/<slug>/`), the project context every prompt is built from
(`project.md`, `rules.md`, `knowledge.md`, `decisions.md`), routing
(`routing.json`), and configured providers (`providers/*.json`).

Three distinctions that help read the code:

- **Task ≠ provider session.** A task persists; a session is metadata under
  one of its runs.
- **Provider ≠ execution node.** A harness runs on a machine; the node owns
  where execution happens (only `local` today).
- **Provider ≠ model.** A harness runs many models; 0x2F routes to harnesses.

```text
YOUR MACHINE                          PRIVATE INFRASTRUCTURE (yours)
─────────────                         ─────────────────────────────
local project       ◄── outbound ──►  relay (optional, for mobile)
agent processes          WebSocket    · pairing + forwarding only
task runtime                           · no task state, no credentials
desktop UI
```

Execution is local-only (the API binds to `127.0.0.1`, is token-authenticated
and refuses cross-site browser requests); remote control is an outbound
control layer, not remote execution.

## Current limitations

- **Execution is local-only.** There is no remote/mini-PC node yet. Remote
  control is an outbound control layer, not remote execution.
- **Remote control is v1.** No push notifications (the phone works while the
  app is open), no offline command queue by design; one phone at a time per
  Mac (re-pairing revokes the previous phone's session).
- **AUTO is deterministic policy routing**, not semantic selection — and there
  is no automatic failover (a routed run that fails is `failed`, not secretly
  retried elsewhere).
- **Runs of one task are strictly sequential.** No concurrent or
  multi-agent orchestration of a single task.
- **No evaluation.** Run history is for inspection — no scores, no winners,
  no recommendations.

## Development

No dependencies, no build step — the repo runs as-is:

```bash
npm test          # the test suite (node --test, 300+ tests)
npm run check     # syntax-check every source and test file
npm start         # run the CLI: node src/cli.mjs
```

See [`docs/development.md`](https://github.com/AleksandrMalinin/0x2f/blob/main/docs/development.md)
for the repository layout and how the pieces fit;
[`docs/architecture.md`](https://github.com/AleksandrMalinin/0x2f/blob/main/docs/architecture.md)
traces a task through the whole system.

## License

[MIT](LICENSE)
