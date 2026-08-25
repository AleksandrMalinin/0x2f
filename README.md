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
        ▼              ▼              ▼
   claude-code    deepseek-harness   any ACP /
                                    command agent
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

## Desktop + mobile

The CLI and the Web are two surfaces over the same core:

```bash
2f ui                      # or: 2f ui <port>, 2f ui --no-browser
```

`2f ui` behaves like opening a local application: if a 0x2F runtime is already
healthy on `http://127.0.0.1:4242` (localhost only) it reuses it; otherwise it
starts the runtime in the background, waits until it is healthy, and opens the
UI. Runtime output lands in `.work/ui.log`. The browser calls the same shared
actions over a local HTTP/SSE API and subscribes to the same normalized
events.

Control 0x2F from your phone while away from the laptop — the Mac keeps
running the work; the phone is a compact control surface:

```bash
2f pair --relay https://relay.example.com
```

The runtime connects **outbound** to the relay (works behind NAT), rotates
its device credential, prints a short-lived one-time pairing URL, and you
open it on your phone. The phone serves the same Web UI from the relay — see
NEEDS YOU / WORKING / READY / FAILED, open a task, and ANSWER / ALLOW /
REJECT / NOTE / SEND BACK / ACCEPT. While the Mac is offline the phone shows
the bounded last-known state with a **MAC OFFLINE** banner and disables
actions; commands are never queued, and a double tap can never execute an
action twice (unique `requestId` per command, idempotency on the Mac).

Pairing tokens are one-time and expire in 10 minutes; phone sessions live 30
days and are revoked by `2f pair --off` (a real revocation at the relay, not
just a local disconnect) or by re-pairing, which also rotates the Mac's
credential — so a stale phone session can never silently come back after the
Mac reconnects. The relay URL must be `https://` (plain `http://` only for
localhost development).

The relay is **private infrastructure, not part of the local product**: it is
a small standalone app that forwards normalized events and proxies commands,
and it never holds task state or provider credentials. Deployment details
live in [`relay/README.md`](relay/README.md); a full setup-and-test
walkthrough is in [`docs/remote-control.md`](docs/remote-control.md).

## Quick start

Prerequisites: Node.js ≥ 20 and at least one coding harness —
[Claude Code](https://code.claude.com/docs) (`claude`) is the built-in
default, [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)
(`dsh`) is also built in, and any ACP-compatible agent or headless executable
can be added per-project (see [Providers](#providers)).

0x2F is not published to a registry yet — install from source:

```bash
git clone https://github.com/AleksandrMalinin/0x2f.git
cd 0x2f
npm install -g .        # puts the `2f` command on your PATH
```

Then, inside the repository you want to work on:

```bash
2f init                          # create .work/ with project.md and rules.md
2f new "Investigate why retries restart the whole run"
2f                               # list tasks
2f open 1                        # run detail, history, result
```

`2f init` creates `.work/` with a `project.md` and `rules.md` — edit them
once; every task prompt is built from them.

## Providers

0x2F has three provider integration paths behind one contract:

| Integration | What it is | Use |
| --- | --- | --- |
| **Native** | Deep adapter for one harness's specific capabilities | `claude-code` (permissions → `needs_you` → same-session resume), `deepseek-harness` |
| **ACP** | One generic provider speaking the [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio | Any ACP-compatible agent — Gemini CLI, Cursor, OpenCode, Codex — configured by manifest |
| **Command** | One generic provider for headless executables | Any CLI that takes a prompt and prints a result — configured by manifest |

`claude-code` and `deepseek-harness` are built in. Everything else is added
**declaratively**: drop one JSON manifest into `.work/providers/` and it
becomes a provider — no source changes:

```json
{
  "id": "gemini",
  "displayName": "Gemini CLI",
  "transport": "acp",
  "command": ["gemini", "--acp"]
}
```

ACP manifests may set `"permissions"`: `"interactive"` (default — a permission
request pauses the run and asks you), `"deny"`, or `"approve"` (headless
auto-resolution). Command manifests must pass the task through the `{prompt}`
placeholder. Commands are spawned as argv arrays, never through a shell.
Verified example manifests live in [`examples/providers/`](examples/providers/README.md);
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

## Architecture

```text
CLI · Web
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
Coding harness     claude-code · dsh · gemini · cursor · any command
```

The CLI and the browser never implement lifecycle or provider logic — both
call the same shared actions (`src/core/actions.mjs`) and read the same
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

See [`docs/development.md`](docs/development.md) for the repository layout and
how the pieces fit; [`docs/architecture.md`](docs/architecture.md) traces a
task through the whole system.

## License

[MIT](LICENSE)
