# 0x2F — Architecture

This document describes 0x2F as it is implemented: the object model, the
lifecycle, the layers, the surfaces, and the boundaries. It is written from
the code outward — file references point at the single place each behavior
lives. The root [README](../README.md) is the short version; this is the
trace.

## The object model

Three objects, in decreasing permanence:

```text
TASK          persistent engineering intent     (.work/tasks/<slug>/task.json)
  └── RUN     one attempt through one provider   (runs[] in task.json + runs/<n>/)
       └── SESSION   one disposable agent session (externalSessionId on a run)
```

- A **task** is the unit of work the user creates: a title, a prompt, a
  status, an execution target, and an ordered list of runs. It persists in
  `.work/` inside the repository it works on.
- A **run** is one execution of the task's intent through one provider. It
  records provider, node, workspace, model (when reliably known), timing,
  outcome, session id, and failure/block details. Runs are **strictly
  sequential** — two runs of one task never execute concurrently.
- A **session** is the provider's own agent session. It is metadata under a
  run (`externalSessionId`), only present when the provider surfaces one
  (Claude Code and ACP agents do; DeepSeek Harness headless does not).

The consequence: rerunning a task is a *continuation*, not a restart. The
task keeps its history, its user constraints, and its prior results; each run
gets a fresh provider session whose input is rebuilt from task state (see
[Task continuity](#5-task-continuity-rerun-and-context)).

Statuses (the task state machine, `src/core/lifecycle.mjs`):

```text
working ──► ready ──► done        (done via 2f close)
   │         └─► done
   └─► needs_you ──► working      (permission resumed, or a new run)
   └─► failed ──► done            (done via 2f close)
```

`needs_you` carries a `blockedOn` reason. Two reasons are implemented:

- `permission` — a concrete operation needs authorization (an edit, a
  command). Answered with ALLOW/REJECT; the same run continues.
- `decision` — the agent cannot continue without human judgment. Answered
  with ANSWER; the answer is recorded, and continuing means rerunning the
  task (no provider supports free-text decision continuation in place).

## Trace a task through the system

### 1. Creation

`2f new "…"` → `src/cli.mjs` → `createRuntime(base)` (`src/runtime.mjs`) →
`actions.createWork({ title, provider })` (`src/core/actions.mjs`).

`createWork`:

1. Resolves the execution target (`resolveTarget`): an explicit provider id,
   `"auto"` (deterministic routing), or the configured default. An explicitly
   requested provider that cannot run on this machine is refused *before any
   work is persisted*.
2. Builds the original prompt from project context (`buildPrompt`,
   `src/project.mjs`: project.md + rules.md + knowledge.md + decisions.md +
   the task title + the Work instructions, including the
   `## Needs human decision` protocol).
3. Persists the task (`store.createTask`) with an initial run record
   (`makeRunRecord`, `src/core/runs.mjs`), and writes the run's input to
   `runs/1/prompt.md`.
4. Hands execution to the execution node (`node.startExecution`), which spawns
   the detached worker (`src/worker.mjs`) — the same entrypoint a future
   remote node would run on another machine.
5. Records a normalized `task.created` event.

### 2. Execution

The worker (`src/worker.mjs`) is a separate process, spawned detached by
`src/nodes/local.mjs` with `(base, slug, run)` argv. It:

1. Builds the provider registry for the workspace (native providers +
   `.work/providers/*.json` manifests).
2. Reads the run's own input (`runs/<n>/prompt.md`, falling back to the
   original `prompt.md` for pre-run-history tasks).
3. Calls the provider contract: `provider.start({ cwd, prompt, onEvent })`
   (or `provider.resume(...)` for a resumed run).
4. Normalizes every provider signal through `onEvent` into Work events
   (`src/core/events.mjs`) and appends them to the task's
   `events.jsonl` — `run.started`, `progress`, `tool.started`,
   `file.changed`, `needs_user`, `permission.resolved`.
5. Applies the provider's normalized outcome (`applyOutcome`,
   `src/core/lifecycle.mjs`) to the task state: `ready` (result written to
   `result.md` and `runs/<n>/result.md`), `needs_you` (with `blockedOn`), or
   `failed` (with `error`).
6. Finalizes the run record (`finalizeRun`): outcome, real timing, session,
   attempts, failure/block details — and records the terminal event
   (`run.completed` / `run.failed` / `needs_user`).

### 3. Needs you

Two shapes of `needs_you`/permission, distinguished by `blockedOn.live`:

- **Interactive (live)** — an ACP agent with `"permissions": "interactive"`
  holds a `session/request_permission` request while its process stays alive.
  The provider emits `needs_user` with `blockedOn.live = true` and the worker
  persists `needs_you` state. `2f allow <id>` / `2f reject <id>` writes the
  grant to the task dir's `permission.json`; the provider polls that file,
  answers the *original* ACP request, and the **same execution continues** —
  no new worker, no session restart. The run record reopens (completion
  cleared).
- **Session-resume** — the run ended (e.g. Claude Code headless finished
  with a permission denial). `allowWork`/`rejectWork` resume the persisted
  provider session (`claude -p --resume <id>`, ACP `session/load`) through a
  fresh worker. Providers that cannot resume a session (`deepseek-harness`,
  `command`) refuse loudly — the capability is declared, never faked.

A `decision` block is answered with `answerWork` (`2f answer`): the answer is
persisted twice — `answer.json` (human-readable record) and the task's
context notes — and the task **stays `needs_you`**. It is not resumed in
place; the human decides next (rerun to continue with the answer in context,
or close).

### 4. Result and history

A `ready` run writes the result to `result.md` (the task-level file) and
`runs/<n>/result.md` (the run's own file), so a later run never destroys the
previous one. `2f open <id>` shows the task with its projected run history
(`taskRuns`, `src/core/runs.mjs`); `2f open <id> --run <n>` shows one run's
factual record. Tasks created before run history existed are interpreted as
one historical run without rewriting their files.

### 5. Task continuity (rerun and context)

`rerunWork` (`src/core/actions.mjs`) appends a new run record and builds that
run's input from current task state (`buildRunPrompt`, `src/project.mjs`):

```text
original task request (prompt.md — never overwritten)
  + user input        (task.context.notes — 2f note / 2f answer)
  + previous runs     (runs/<n>/result.md, verification, changed files
                       from file.changed events)
        ──► runs/<n>/prompt.md  (the exact input the fresh session received)
```

The next run therefore starts with the full task context — without any manual
copying — while every run's exact input stays auditable on disk.

## Layers and contracts

### Work Core — `src/core/`

- `actions.mjs` — the **single implementation of business rules**. Both the
  CLI and the HTTP API call these actions; neither implements its own
  create/allow/reject/close logic. Clients render state and invoke actions.
- `lifecycle.mjs` — the state machine (statuses, `blockedOn` reasons) and the
  decision protocol parser (`decisionSection`): the ONLY thing that produces
  a decision block is an explicit `REQUIRED: yes` + readable question; a bare
  heading, "None", or any prose means no decision.
- `runs.mjs` — run records, the legacy-task interpretation, and the
  current-run helper.
- `events.mjs` — the normalized event vocabulary (see below), the in-process
  bus, and the log tailer that turns new `events.jsonl` lines into live bus
  events (so a `2f allow` in a terminal reaches the open Web UI).
- `store.mjs` — the only module that knows where tasks live on disk; JSON
  files under `.work/`.
- `router.mjs` — AUTO routing: deterministic, availability + explicit policy.
- `errors.mjs` — `WorkError`, shared by CLI and API.

### Providers — `src/providers/`

One contract, three integration types (`src/providers/index.mjs`):

```text
{ id, displayName, integrationType, capabilities,
  async start({ cwd, prompt, onEvent }) -> normalized outcome,
  async resume({ cwd, externalSessionId, grant, onEvent }),  // if supportsResume
  cancel?() }
```

Normalized outcome shapes (`src/core/lifecycle.mjs`):

```text
{ status: "ready",    result }
{ status: "needs_you", reason, blockedOn, result? }
{ status: "failed",   error }
```

- **Native**: `claude-code.mjs` (stream-json, session resume,
  permission-denial detection, mutating-tool file.changed) and
  `deepseek-harness.mjs` (`dsh --profile headless`, one-shot, no structured
  events, no resume). Each file is the only place vendor shapes may appear.
- **ACP** (`acp.mjs`): one generic provider speaking Agent Client Protocol
  v1 over stdio — `initialize`, `session/new`, `session/load`,
  `session/prompt`, `session/request_permission` (interactive → live
  needs_you; `deny`/`approve` → headless auto-resolution), cancel.
- **Command** (`command.mjs`): a headless argv invocation; exit 0 + stdout →
  ready (honoring the decision protocol), non-zero → failed. Nothing else is
  inferred.

**Capability declarations** are honest, per provider:

```text
supportsResume · supportsStructuredEvents · supportsFileChanges ·
supportsCommands · supportsPermissionRequests · supportsSandbox ·
supportsStreaming · resultOnCompletion
```

A DeepSeek Harness run has no session id and no structured events — those
fields are absent, never fabricated, and the UI degrades by the declaration
(`src/web/ledger.mjs`). Providers never leak vendor shapes past their own
module.

**Manifests** (`src/providers/manifests.mjs`) add providers declaratively:
one strict JSON file per provider under `.work/providers/`. Validation
enforces argv arrays (never a shell string), the `{prompt}`/`{workspace}`
placeholders only, a fixed executable, and no redefinition of built-ins.

### The router — `src/core/router.mjs`

AUTO v0 is deliberately not an AI router: it selects among *available*
providers, preferring `.work/routing.json`'s `prefer` list in order, then
registry order. Same state + same policy → same decision. The decision
(`mode`, `reason`, `considered`) is persisted with the run, so "why did 0x2F
run this here?" is answered from the record, never reconstructed. No
automatic failover.

### The worker and the node — `src/worker.mjs`, `src/nodes/local.mjs`

The node is a machine boundary: "spawn the execution somewhere". The local
node spawns the detached worker (output to `run.log`); Work Core talks only
to the node contract. The workspace id stored on a task is logical
(`"local"` today); a future node resolves it to its own filesystem.

### Project context — `src/project.mjs`, `src/refine.mjs`

`buildPrompt` assembles the original task prompt from the workspace's
context files. `buildRunPrompt` projects accumulated task state into a new
run's input. `refine.mjs` is a pure text transform (the Web UI's **REFINE /
BRIEF**): it turns a rough composer note into a stronger brief by calling the
native CLIs in their narrowest text-only mode — it never creates a task,
never starts an execution, and never persists anything.

## The event vocabulary

`src/core/events.mjs` defines the only event types anything may emit or
consume:

```text
task.created  task.updated  task.closed  task.answered  task.note
run.started   progress      tool.started  file.changed   needs_user
permission.resolved  run.completed  run.failed
```

Events are appended as JSON lines to `.work/tasks/<slug>/events.jsonl` by
actions (task-level) and by the worker (run-level). The API layer tails these
logs and fans new lines out over SSE, so every surface observes the same
chronology regardless of which process performed the action.

## Surfaces

### CLI — `src/cli.mjs`

One client of the shared actions. Commands: `init`, `new`, `status` (bare
`2f`), `open [--run]`, `rerun`, `note`, `allow`, `reject`, `answer`, `close`,
`providers`, `ui`, `pair`. Rendering is a client concern
(`src/render.mjs`): the CLI groups tasks NEEDS YOU / WORKING / READY /
FAILED / DONE, and renders run history as inspection — never evaluation.

### Local HTTP/SSE API — `src/server.mjs`

Binds to `127.0.0.1` (localhost only). Thin client of the shared actions:

```text
GET  /api/tasks · /api/tasks/:id · /api/tasks/:id/runs/:n
POST /api/tasks · /api/tasks/:id/{rerun,allow,reject,answer,note,close}
POST /api/refine
GET  /api/providers · /api/routing · /api/status
GET  /api/events (SSE) · /api/events/history
```

It also serves the static web client from `src/web/`. The server holds no
lifecycle or provider logic; `2f ui` (`src/ui.mjs`) spawns the detached
runtime (`src/server-entry.mjs`) and reuses an already-healthy one.

### Web client — `src/web/`

`index.html` + `app.js` (DOM + transport) + `ledger.mjs` (pure event →
ledger projection, shared with the Node tests) + `sound-policy.mjs` /
`sound.mjs` (the one sound: READY one stroke, NEEDS YOU two). The client
fetches state and calls actions; it never decides what a status means. Every
mark on the execution trace corresponds to one real event — nothing is
inferred from absence, and the ACTIVITY / FILES / COMMANDS bands exist only
when the events actually contain them.

### Mobile — the same client, a different path

Below 640px, `app.js` renders a dedicated mobile code path (the "Attention
Stack"): an Overview (glance → understand → intervene) and a Task Detail, with
the primary action under the thumb and all mutating controls disabled while
the Mac is offline. The mobile client is served by the **relay**; it detects
remote mode via `/api/status` and never queues commands.

## Remote control — `src/relay/`, `relay/`

- `pair.mjs` — `2f pair`: ensures `.work/relay.json` (stable `deviceId` +
  long-lived `deviceSecret`), generates a short-lived one-time token, ensures
  the runtime is running, and prints the pairing URL. `2f pair --off`
  disables remote control without touching device identity.
- `agent.mjs` — the outbound link, an in-process module of the UI runtime.
  It subscribes to the normalized event bus, forwards events, pushes a
  snapshot on state-changing events and on every reconnect, backfills recent
  events, and executes remote commands **through the shared core actions**.
  Commands run strictly serially; a bounded idempotency cache means a
  repeated `requestId` never executes a mutating action twice.
- `protocol.mjs` — the versioned wire contract
  `{ protocolVersion, deviceId, requestId, type, payload }`;
  `deviceId`/`requestId` are protocol identity, deliberately separate from
  credentials.
- `relay/server.mjs` — the standalone relay. Pairing pages, session cookies,
  a bounded last-known snapshot/event cache per device, SSE fan-out, and
  command forwarding. Reads are forwarded to the Mac when online (else served
  stale); **mutating commands are never queued** — offline is an explicit 503.

```text
Phone browser ── HTTPS (existing API semantics) ──► Relay ◄── outbound
                                                       WebSocket ── Mac
```

## Security boundary

Three ownership rules, enforced by the transport:

> **Local 0x2F owns work.** Tasks, runs, agents, the repository and
> credentials stay on the Mac; the relay never becomes the task source of
> truth.
> **Relay owns connectivity.** It forwards normalized events and proxies
> commands; it is disposable, and a restart never loses task state (the Mac
> restores the relay's view on reconnect).
> **Web owns control.** The phone talks the same API semantics as the local
> UI — no second task-control model.

The relay necessarily observes what the remote surface needs to render —
task status, normalized events, progress/result text, file paths, NEEDS YOU
details. It never receives provider credentials, arbitrary repository
contents, or execution authority independent of the connected Mac. There is
no E2E encryption beyond HTTPS/WSS; the pairing token is the only credential
a phone presents, and it is consumed on first use. See
[`relay/README.md`](../relay/README.md) for the deployment statement.

## Persistence layout

Everything lives under `.work/` in the repository you run 0x2F in:

```text
.work/
  project.md · rules.md · knowledge.md · decisions.md   prompt context
  routing.json                                          AUTO routing config
  providers/*.json                                      provider manifests
  relay.json                                            pairing/device config
  ui.log                                                UI runtime log
  tasks/<slug>/
    task.json        task state + runs[] (run records)
    prompt.md        the ORIGINAL task request (never overwritten)
    events.jsonl     append-only normalized event log
    result.md        the task-level result (latest run)
    run.log          raw worker/provider output
    permission.json  the live-permission decision channel (transient)
    answer.json      the last decision answer (human-readable record)
    runs/<n>/prompt.md · result.md   each run's exact input and result
```

`.work/`, `relay/data/`, and `node_modules/` are gitignored — task state is
never committed.

## What is deliberately NOT here

- **No remote execution node.** The only node is `local`; the API binds to
  127.0.0.1. Remote control is a control layer, not execution.
- **No concurrent runs of one task.** Runs are strictly sequential (no
  isolated worktrees/sandboxes yet).
- **No evaluation.** Run history is inspection — no scores, winners, or
  recommendations.
- **No semantic routing.** AUTO is deterministic policy routing; no
  automatic failover.
- **No provider plugin loading.** The registry seam (`register`) exists for a
  future external/native provider package, but nothing loads remote code.
- **No cancellation surface in the CLI/API.** The node's
  `cancelExecution` and providers' `cancel()` exist as the contract seam; no
  client exposes them yet.
