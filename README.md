# 0x2F

A deliberately small, task-native wrapper around coding agents. (v0.3)

The product thesis:

> Developers should manage **engineering work**, not AI sessions.

The user-facing primitive is a **Work Task**. Underlying coding agents, models,
sessions, permissions, processes, and machines are infrastructure.

> **Naming.** `0x2F` is the product/display name; `2f` is the CLI command.
> Internal domain concepts deliberately keep the name *Work* (Work Task,
> `createWork`/`allowWork`/…, the `.work/` directory, Work Core/Runtime) —
> they describe the system, not the brand.

**v0.2** proved the provider boundary: 0x2F manages Tasks, not agent sessions;
Claude Code is the first *execution provider* behind a neutral contract.

**v0.3** makes the architecture structurally honest without building anything
new on top:

```
Work Core                        (lifecycle, actions, events, persistence)
    │
    ▼
Work Runtime                     (per-workspace wiring of core + node)
    │
  ┌─┼───────────────┐
  │ │               │
 CLI   Web (HTTP/SSE)   future TUI · future Desktop
```

and, independently, execution location:

```
Work Runtime
    │
    ▼
Execution Node               (a machine boundary)
   /          \
  /            \
local node     remote node   (future: trusted mini-PC)
   │              │
provider       provider
   │              │
Claude/etc.    DeepSeek/etc.
```

The key idea: **surface and execution location are separate**. A Web UI on the
Mac may control execution on the same Mac today — and on a trusted mini-PC
tomorrow — without Work Core changing. Clients render and invoke actions; they
never own lifecycle, provider, or process logic.

Zero-dependency Node.js. No build step.

## Requirements

- Node.js 20+
- Claude Code installed and authenticated (`claude`) — the only implemented
  execution provider

## Install

```bash
npm link
```

Then, in any repository:

```bash
2f init
2f new "Investigate why production users are missing in Sentry"
2f
```

## Commands

```bash
2f init
2f new "Long text overflow fix"
2f
2f status
2f open 1
2f allow 1     # grant the permission the task is blocked on
2f reject 1    # decline the requested change
2f close 1
2f ui
```

Every command is a thin client of the **shared Work actions**
(`src/core/actions.mjs`) — the same implementation the Web API calls.

### `2f ui`

**0x2F Web** — the graphical surface — at `http://127.0.0.1:4242`, bound to
**localhost only**. The browser talks to 0x2F exclusively through the local
HTTP/SSE API: it never spawns providers, reads provider sessions, or touches
`.work/` files, and it holds no task store of its own.

The ledger is the product surface. A task expands in place; the row that
needs you opens itself. Everything on screen is real Work state — task
status from the shared actions, activity from normalized Work events. There
is no simulated agent activity and no chain-of-thought.

Provider, node and session are **secondary metadata** on the expanded row
(`local / claude-code`), never the headline. The same ledger renders a Codex,
DeepSeek Harness or OpenCode run without a line changing: the client consumes
only normalized events and `execution.*`.

## Architecture

### Work Core (`src/core/`)

- `lifecycle.mjs` — the pure state machine: `working → needs_you → working →
  ready/failed → done`. Process completion ≠ task completion.
- `actions.mjs` — the **single** implementation of Work's business rules:
  `createWork`, `getWork`, `listWork`, `allowWork`, `rejectWork`, `closeWork`.
  The CLI and the Web API call these and nothing else.
- `events.mjs` — the normalized event model, the in-memory bus, and the event
  log tailer.
- `store.mjs` — persistence under `.work/`; the only module that knows the
  on-disk layout.
- `errors.mjs` — `WorkError` with HTTP status, shared by CLI and API.

### Providers (`src/providers/`)

- `claude-code.mjs` — the Claude Code adapter. **Everything** Claude-shaped
  lives here and stops here: stream-json parsing, `permission_denials`, session
  resume, `acceptEdits`.
- `index.mjs` — the provider registry (`getProvider`, `defaultProviderId`).
  Core, worker, and clients never import a vendor module directly.

### Execution nodes (`src/nodes/`)

- `local.mjs` — `LocalExecutionNode`, the machine boundary. It spawns the
  detached worker on this machine. Its contract (`startExecution`,
  `resumeExecution`, `cancelExecution`, `resolveWorkspace`) is exactly what a
  future trusted mini-PC node implements over a transport instead of a spawn.

### Runtime, worker, API

- `runtime.mjs` — `createRuntime(base)`: composes store + actions + node +
  event bus for one workspace. CLI, server, and (later) TUI all build one.
- `worker.mjs` — runs inside a node: provider `start`/`resume` → normalized
  outcome → task state → normalized events.
- `server.mjs` — the local API (HTTP + SSE) and the three static files of the
  Web surface. A thin client of the actions.
- `project.mjs` / `render.mjs` — workspace context (prompts, init) and CLI
  rendering. Rendering is a client concern; neither owns business logic.

### Web surface (`src/web/`)

The Web client is a client, exactly like the CLI: it renders state and
invokes shared actions.

- `index.html` — the shell and the design's styles. No inline UI logic.
- `ledger.mjs` — the **pure** projection from normalized Work events to the
  ledger view model: phase grouping, the travel-rule track, the activity
  bands, state labels. It is the Web counterpart of `render.mjs` and it is
  DOM-free and dependency-free, so the browser imports it over HTTP
  (`/app/ledger.mjs`) *and* `test/web-ledger.test.mjs` imports it in Node —
  one implementation of the rendering rules, tested directly.
- `app.js` — the DOM layer and the transport (fetch + `EventSource`).

Nothing here decides what a status means, when a task is resumable, or how a
run is continued; that stays in `core/`. Zero dependencies, no build step:
the files are served as-is.

### Task shape

A Work Task is persistent; an execution session is metadata under it:

```json
{
  "id": 2,
  "title": "Long text overflow",
  "status": "needs_you",
  "execution": {
    "provider": "claude-code",
    "node": "local",
    "workspace": "local",
    "externalSessionId": "48e841bd-46a0-4735-bb28-38ec8844608c",
    "attempts": 2
  },
  "blockedOn": { "type": "permission", "tool": "Edit", "file": "…", "plannedChange": "…" }
}
```

- `provider` ≠ `model` (a harness runs many models) and `provider` ≠ `node`
  (a harness runs on many machines).
- `workspace` is a **logical** project id (`"local"` today). The node resolves
  it to its own filesystem — Work never assumes the UI path equals the
  execution path. A future node maps workspace ids to checkouts on its machine.
- `externalSessionId` is provider-run state, not the task's identity.

### Local API

```
GET  /api/tasks                  listWork()
GET  /api/tasks/:id              getWork(id)          ({ ...task, result })
POST /api/tasks                  createWork({ title })
POST /api/tasks/:id/allow        allowWork(id)
POST /api/tasks/:id/reject       rejectWork(id)
POST /api/tasks/:id/close        closeWork(id)
GET  /api/events                 Server-Sent Events — live normalized events
GET  /api/events/history         the persisted event log, per task
```

`/api/events` only carries events from the moment a client connects, and the
tailer never replays. `/api/events/history` reads the same append-only logs
the worker and the CLI write, so a surface opened mid-run can draw the work
it missed. It is a read-through of existing persistence, not a second store.

The API returns normalized Work concepts, never provider shapes.

### Event model

Provider events stop at the provider boundary. Everything else in Work speaks
this vocabulary (persisted as JSON lines in
`.work/tasks/<slug>/events.jsonl`, streamed live over SSE):

```
task.created   task.updated   task.closed
run.started    progress       tool.started   file.changed
needs_user     run.completed  run.failed
```

The server tails each task's event log and broadcasts to every SSE connection,
so events written by **other processes** reach all clients:

```
task created in Web  ->  appears in TUI        (future)
permission allowed in TUI -> Web updates       (future)
task closed via CLI  ->  Web updates           (works today)
```

### Task lifecycle

```text
working
   ↓
needs_you ── allow/reject ──→ working
   ↓                           ↓
ready                        failed
   ↓
done
```

- **working** — execution is actively running.
- **needs_you** — execution cannot responsibly continue without you.
  Normalized reasons: `permission`, `decision` (v0.2), future `question`.
- **ready** — the engineering work reached a completed state.
- **failed** — a real technical/runtime problem.
- **done** — you explicitly closed the task.

### Process completion is not task completion

A provider process that exits successfully does **not** automatically imply
`ready`. If the agent stopped because it needs permission, the task is
`needs_you` with `blockedOn.type = permission` — even when the process exited
0. This is the core v0.1 bug v0.2 fixed; the regression tests still guard it.

## How the permission flow works (Claude Code)

Provider-internal detail — see `src/providers/claude-code.mjs` and the
`test/fixtures/` captures:

1. 0x2F launches `claude -p --verbose --output-format stream-json "<prompt>"`.
2. `system/init` carries the session id; Work stores it as
   `task.execution.externalSessionId`.
3. A blocked tool call surfaces as `result.permission_denials` — exit code 0,
   `is_error` false. Work maps this to `needs_you / permission`.
4. `2f allow` resumes the **same session** with
   `--resume <id> --permission-mode acceptEdits`; `2f reject` resumes with
   the request withdrawn.

## What cannot be implemented reliably today

- **File-scoped permission grants on headless resume.** `--allowedTools` with
  a specific path fails on resume in current Claude Code; the narrowest
  reliable grant is `--permission-mode acceptEdits`.
- **True `question`-type needs_you** — Claude Code has no structured headless
  question event that fits Work's flow yet. The state model supports it.
- **Pause/resume mid-flight** — resume works once the provider process has
  exited with a persisted transcript.
- **Sending a task back, or adding a note to a running one.** There is no
  action for "continue this task with a correction": `resumeWork` only
  applies to `needs_you`, and a free-text nudge would be a new product
  feature with its own lifecycle. The 0x2F Web ledger therefore has no
  "send back" or note field — an affordance that cannot act is worse than
  none.
- **Diff statistics on a result.** Work records *which* files a run changed
  (`file.changed`), not how many lines. The result panel shows the files and
  the written result, not `+28 −11`.

## Adding a second provider

One file plus a registry line — nothing in core, CLI, worker, server, or UI
changes (they consume only normalized outcomes and `execution.provider`):

1. Create `src/providers/<name>.mjs` exporting a provider object with `id`,
   `displayName`, `capabilities`, and `start({ cwd, prompt, onEvent })` →
   normalized outcome (plus `resume` if supported).
2. Register it in `src/providers/index.mjs`:
   `const providers = { "claude-code": claudeCodeProvider, "<name>": … };`
3. Providers declare capabilities (`supportsResume`,
   `supportsStructuredEvents`, `supportsPermissionRequests`, …) so Work can
   refuse flows the runtime can't do instead of faking them.

Models are a separate concern from providers: the same harness can run
different models, and the same model can run under different harnesses. The
provider abstraction is about the harness (session lifecycle, tool execution,
permissions, sandboxing, events), not the model.

## Adding a TUI (not implemented — architecture only)

`2f tui` is a **new client**, nothing more:

- query state via the same actions (`listWork`, `getWork`),
- subscribe to the same event bus/SSE (`task.updated`, `progress`, …),
- invoke the same actions (`allowWork`, `rejectWork`, `closeWork`,
  `createWork`).

It must not duplicate provider or lifecycle logic. If the TUI runs in a
separate process from the Web server, it tails the same event logs; if it runs
inside the same runtime, it subscribes to the same bus. Either way the core is
unchanged.

## Adding a desktop client (not implemented — architecture only)

Same shape as the TUI, with a different renderer: a local client of the
runtime/API. If it embeds its own HTTP server, the SSE endpoint already
broadcasts to multiple connections; if it embeds the runtime directly, it uses
the bus. No core redesign.

## Adding a trusted mini-PC execution node (not implemented — architecture only)

The node boundary already exists (`src/nodes/`). A remote node implements the
same contract and resolves `execution.workspace` to its own checkout:

```
MacBook client → Work Runtime → trusted mini-PC node
                                    ├── repo checkout
                                    ├── provider runtime
                                    ├── tests
                                    └── background execution
```

Not decided yet: whether the runtime lives on the Mac or the mini-PC — the
client/runtime/node boundaries allow either. Not implemented (future work):
repository synchronization, trusted-node authentication, and transport
security between runtime and nodes. Until then the API binds to localhost and
is not exposed to the LAN.

## Regression coverage

`npm test` (Node's built-in test runner, zero deps):

- `test/lifecycle.test.mjs` — state transitions and guards (v0.2, preserved).
- `test/permission-regression.test.mjs` — the v0 dogfooding failure replayed
  from stream-json captures in `test/fixtures/` (sanitized synthetic replays —
  no real sessions or machine paths): exit-0 blocked run → `needs_you`,
  same-session allow → resume → `ready` (v0.2, preserved).
- `test/render.test.mjs` — CLI grouping and reason labels (v0.2, preserved).
- `test/store.test.mjs` — persistence under `.work`.
- `test/actions.test.mjs` — the shared actions driven through a **fake
  execution node**: lifecycle, guards, exact CLI error messages, and the proof
  that CLI and API use the same factory.
- `test/events.test.mjs` — normalized event model, bus, and log tailer
  (including partial-line safety).
- `test/node-local.test.mjs` — the node contract and its swappability.
- `test/api.test.mjs` — HTTP routes map 1:1 onto actions; localhost binding;
  SSE delivers `task.created` live; the Web shell and its module assets are
  served from the allowlist and nothing else is reachable; the event history
  route returns the persisted normalized log.
- `test/web-ledger.test.mjs` — the Web projection driven by real normalized
  events: provider-neutral phase classification, the travel rule (executed
  work only — Work does not forecast), the interruption tear, Needs You from
  `blockedOn`, the ready result from `file.changed`, compressed done rows,
  and ledger ordering.

## What this intentionally does NOT do

- remote execution, mini-PC networking, repo synchronization
- authentication/authorization infrastructure
- TUI, desktop app, Slack, GitHub, Linear
- multi-agent orchestration, automatic provider routing
- cloud backend, vector databases, sophisticated memory

This iteration is about the architectural boundary: Work is the persistent
system, UI is a surface, providers are workers, machines are execution
locations. Everything else can be added later without rebuilding 0x2F.
