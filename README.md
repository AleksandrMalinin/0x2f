# 0x2F

A local work router for coding agents. Give 0x2F engineering work — "Investigate
why retries restart the whole run" — and it routes the task to a coding harness
on your machine, runs it in the background, and tracks it through the lifecycle
until you close it. You work in terms of **tasks**, not agent sessions.

[0x2f.space](https://0x2f.space)

`0x2F` is hex for the ASCII `/` (47). The CLI is `2f`.

Zero-dependency Node.js, no build step, local-first.

## Install

Prerequisites:

- **Node.js ≥ 20**
- **At least one coding harness** to run work through:
  - [Claude Code](https://code.claude.com/docs) (`claude` on PATH) — the
    built-in default
  - [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (`dsh`)
    — also built in
  - Any ACP-compatible agent or headless executable — added per-project via a
    provider manifest (see [Providers](#providers))

0x2F is not published to a registry yet — install from source:

```bash
git clone https://github.com/AleksandrMalinin/0x2f.git
cd 0x2f
npm install -g .
```

This puts the `2f` command on your PATH.

## Quick start

```bash
2f init                          # create .work/ in this repository
2f new "Investigate why retries restart the whole run"
2f                               # list today's tasks
2f open 1                        # run detail, history, result
```

`2f init` creates `.work/` with a `project.md` and `rules.md` — edit them
once; every task prompt is built from them. Then create work and watch it:

```text
2f new "…"
    ↓
WORKING ──────→ READY              (2f open <id> for the result)
    ↓
NEEDS YOU ── 2f allow | 2f reject ──→ WORKING
```

A task that hits a permission or a decision the agent cannot make alone
becomes **NEEDS YOU**. `2f open <id>` shows what it is asking for. The two
are distinct interactions:

- **PERMISSION** — a concrete operation needing authorization (an edit, a
  command). `2f allow <id>` / `2f reject <id>` answers it and the same run
  continues.
- **DECISION** — the agent cannot continue without your judgment.
  `2f answer <id> "<your answer>"` records your answer with the task. A
  decision is never allow/rejected.

`2f close <id>` (or **CLOSE** in the Web UI) removes any Work from active
attention — a non-resumable NEEDS YOU, a wrong NEEDS YOU, a FAILED or READY
run you no longer want. It never resumes the provider and never starts a new
execution.

The decision request itself is a machine-read protocol, not prose. Agents
signal one by ending with:

```text
## Needs human decision
REQUIRED: yes
QUESTION: <the concrete question a human must answer>
```

Anything else — a bare heading, "None", "No decision required", or any prose —
is treated as **no** decision, so a finished run completes READY instead of
interrupting you for work that did not need you.

Tasks persist. Each execution is recorded as a **run** under the task, so the
same task can be run again — through a different harness, for comparison:

```bash
2f rerun 1 --provider deepseek-harness   # run 02 under task #1
2f open 1 --run 2                        # one run's factual detail
```

## AUTO routing

By default `2f new "…"` uses the configured routing default. When it is
`auto`, 0x2F picks the harness for you:

```bash
2f new "Audit the auth flow" --provider auto
```

AUTO v0 is deliberately deterministic: it selects among **available** providers
(executables that resolve on this machine), preferring the ids listed in
`.work/routing.json` in order, then registry order. It does **not** read the
task text semantically, and it never claims a provider is "best". The decision
is persisted with the run and shown by `2f open` / the Web UI
(`Routing: auto → claude-code (preferred compatible provider)`).

Override any time — provider selection is always explicit:

```bash
2f new "Audit the auth flow" --provider claude-code
```

Configure the default:

```json
// .work/routing.json
{
  "default": "auto",                       // "auto" or a provider id
  "prefer": ["claude-code", "deepseek-harness"]
}
```

## Providers

0x2F has three provider integration paths behind one contract:

| Integration | What it is | Use |
| --- | --- | --- |
| **Native** | Deep adapter for one harness's specific capabilities | `claude-code` (permissions → `needs_you` → same-session resume), `deepseek-harness` |
| **ACP** | One generic provider speaking the [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio | Any ACP-compatible agent — Gemini CLI, Cursor, OpenCode, Codex — configured by manifest |
| **Command** | One generic provider for headless executables | Any CLI that takes a prompt and prints a result — configured by manifest |

`claude-code` and `deepseek-harness` are built in. Everything else is added
**declaratively**: drop one JSON manifest into `.work/providers/` and it
becomes a provider — no source changes, no registry edits. `2f init` creates
the directory; verified manifests live in
[`examples/providers/`](examples/providers/README.md):

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

`2f providers` lists every provider with its integration type and availability.

## Web

```bash
2f ui                      # or: 2f ui <port>, 2f ui --no-browser
```

`2f ui` behaves like opening a local application. If a 0x2F runtime is
already healthy on `http://127.0.0.1:4242` (localhost only) it reuses it —
no second runtime is started, the existing UI opens in your default browser.
Otherwise it starts the runtime in the background, waits until it is
healthy, and opens the UI. Runtime output lands in `.work/ui.log`. If another
process owns the port, `2f ui` says so instead of failing with an opaque
EADDRINUSE. `--no-browser` keeps the server-only path (start or reuse the
runtime, print the URL, open nothing) for development and automation.

The CLI and the Web are two surfaces over the same Work core: the browser
calls the same shared actions over a local HTTP/SSE API, subscribes to the
same normalized events, and never touches provider processes or `.work/`
files itself.

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

Three distinctions that help read the code:

- **Work task ≠ provider session.** A task persists; a session is metadata
  under one of its runs.
- **Provider ≠ execution node.** A harness runs on a machine; the node owns
  where execution happens.
- **Provider ≠ model.** A harness runs many models; 0x2F routes to harnesses.

## Project structure

```text
src/
  cli.mjs             the 2f CLI — one client of the shared actions
  runtime.mjs         composes store + node + providers + router + actions
  worker.mjs          detached background worker: runs one task execution
  server.mjs          local HTTP/SSE API; serves the Web surface
  server-entry.mjs    detached UI runtime: `2f ui` spawns this in the background
  ui.mjs              `2f ui` launcher: probe, spawn, wait, open the browser
  project.mjs         workspace context (.work files, prompt assembly)
  render.mjs          CLI rendering
  core/
    actions.mjs       the single implementation of Work's business rules
    lifecycle.mjs     task state machine (working → needs_you → ready/failed → done)
    router.mjs        AUTO routing — deterministic provider selection
    runs.mjs          run history model (task └── runs)
    events.mjs        normalized event model, bus, log tailer
    store.mjs         persistence under .work/
  providers/
    index.mjs         provider registry (native + manifest providers)
    claude-code.mjs   native adapter
    deepseek-harness.mjs  native adapter
    acp.mjs           generic ACP provider
    command.mjs       generic command provider
    manifests.mjs     provider manifest loading + validation
  nodes/
    local.mjs         the local execution node (spawns the worker)
  web/
    index.html        Web shell
    app.js            browser client (fetch + SSE)
    ledger.mjs        pure event → ledger projection
examples/providers/   verified manifests (Gemini, Cursor, OpenCode, Codex, command)
test/                 node --test suite
```

## Configuration

Everything lives under `.work/` in the repository you run 0x2F in:

- `.work/routing.json` — AUTO routing (`default`, `prefer`)
- `.work/providers/*.json` — provider manifests
- `.work/project.md` · `.work/rules.md` · `.work/knowledge.md` ·
  `.work/decisions.md` — the project context every prompt is built from
- `.work/tasks/<slug>/` — task state: `task.json` (+ run records),
  `events.jsonl`, per-run results under `runs/<n>/result.md`

## Development

No dependencies, no build step — the repo runs as-is:

```bash
npm test          # the test suite (node --test)
npm run check     # syntax-check every source and test file
npm start         # run the CLI: node src/cli.mjs
```

`npm install -g .` installs the `2f` command globally; while hacking on the
repository, `npm link` keeps it pointing at your checkout.

## Current limitations

- **Execution is local-only.** The API binds to `127.0.0.1`; there is no
  remote/mini-PC node yet.
- **AUTO is deterministic policy routing**, not semantic selection — and there
  is no automatic failover (a routed run that fails is `failed`, not secretly
  retried elsewhere).
- **No multi-agent orchestration.** Runs of one task are strictly sequential.
- **No evaluation.** Run history is for inspection — no scores, no winners,
  no recommendations.

## License

[MIT](LICENSE)
