# 0x2F

A deliberately small, task-native wrapper around coding agents. (v0.4)

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

**v0.3** made the architecture structurally honest without building anything
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

**v0.4** makes run history real: the same task can be executed more than once,
through different providers, and both executions persist under the task —
inspection, not evaluation.

The key idea: **surface and execution location are separate**. A Web UI on the
Mac may control execution on the same Mac today — and on a trusted mini-PC
tomorrow — without Work Core changing. Clients render and invoke actions; they
never own lifecycle, provider, or process logic.

Zero-dependency Node.js. No build step.

## Requirements

- Node.js 20+
- At least one execution provider:
  - **Claude Code** installed and authenticated (`claude`) — the default
  - **DeepSeek Harness** (`dsh`) — optional; select it per task with
    `--provider deepseek-harness`

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
2f new "Long text overflow fix"              # default provider (claude-code)
2f new "Audit the auth flow" --provider deepseek-harness
2f
2f status
2f open 1
2f open 1 --run 2          # one run's factual detail
2f rerun 1 --provider deepseek-harness   # run the SAME task again as run 02
2f allow 1     # grant the permission the task is blocked on
2f reject 1    # decline the requested change
2f close 1
2f ui
```

Every command is a thin client of the **shared Work actions**
(`src/core/actions.mjs`) — the same implementation the Web API calls.

Provider selection is explicit and **secondary**: `2f new "…" --provider <id>`
(default `claude-code`; `2f` lists providers in its help). The same task text
can be run through any provider — the task, not the session, is what persists.

### `2f rerun <id> [--provider <id>]`

Run the same task again as a **new run under the same task** — the dogfooding
loop for comparing providers:

```
2f new "Investigate why retry state is lost"      # run 01 · claude-code
2f rerun 1 --provider deepseek-harness            # run 02 · deepseek-harness
2f open 1
```

```
RUNS

01   claude-code         4m12s   READY
02   deepseek-harness    2m48s   READY
```

- The original task intent is unchanged; the previous run's result and
  execution metadata are **never overwritten**.
- Without `--provider`, rerun retries through the task's current provider.
- Runs of one task are **strictly sequential**: rerun refuses while the task
  is `working` (two runs of the same task would race against the same working
  directory; isolated worktrees/sandboxes are future work, deliberately not
  built here).
- A blocked (`needs_you`) task can be rerun — the blocked run stays in
  history and the new run starts fresh.
- `2f open <id> --run <n>` shows one run's facts: provider, node, model (when
  known), timing, outcome, session (when the provider surfaces one), attempts,
  and its own written result. Fields a provider cannot supply show as `—`.

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

The bottom composer offers provider selection as a quiet native select
(populated from `GET /api/providers`, defaulting to the runtime default) —
task-first: the input is the primary surface, the provider is one small
control next to the caret.

#### Run history inside task detail

A task with more than one run shows a compact `RUNS` strip inside its
expanded detail — another instrument in the same machine, never a dashboard:

```
RUNS

01   CLAUDE CODE        04:12   READY
02   DEEPSEEK HARNESS   02:48   READY
```

Clicking a run selects it and opens its factual detail: provider, node, model
(when known), timing, outcome, session (when the provider surfaces one),
attempts, its structured steps (Claude Code), and its own written result. A
DeepSeek Harness run shows only what it recorded — `started · completed` and
the result — honestly and quietly, never with invented steps.

Selecting a second run turns the detail into a **side-by-side comparison**:
`RUN 01` and `RUN 02` with their facts, changed files (from the run's own
`file.changed` events) and results. That is all the comparison does — no
scores, no stars, no winner labels, no recommendations. You form the judgment.

## Architecture

### Work Core (`src/core/`)

- `lifecycle.mjs` — the pure state machine: `working → needs_you → working →
  ready/failed → done`. Process completion ≠ task completion.
- `actions.mjs` — the **single** implementation of Work's business rules:
  `createWork`, `getWork`, `listWork`, `rerunWork`, `getRun`, `allowWork`,
  `rejectWork`, `closeWork`. The CLI and the Web API call these and nothing
  else.
- `runs.mjs` — the run record model (`Task └── Runs`): record shape,
  creation, per-run finalization, the projection, and the legacy
  interpretation (a task without run history reads as one historical run).
- `events.mjs` — the normalized event model, the in-memory bus, and the event
  log tailer.
- `store.mjs` — persistence under `.work/`; the only module that knows the
  on-disk layout (including per-run result files).
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

A Work Task is persistent; an execution session is metadata under it. Since
v0.4 a task can carry several **runs** — one attempt to execute the task's
intent through a provider:

```json
{
  "id": 2,
  "title": "Long text overflow",
  "status": "ready",
  "execution": {
    "provider": "deepseek-harness",
    "node": "local",
    "workspace": "local"
  },
  "runs": [
    {
      "run": 1,
      "provider": "claude-code",
      "node": "local",
      "workspace": "local",
      "startedAt": "2026-08-23T10:00:01.000Z",
      "completedAt": "2026-08-23T10:04:13.000Z",
      "durationMs": 252000,
      "outcome": "ready",
      "externalSessionId": "48e841bd-46a0-4735-bb28-38ec8844608c",
      "attempts": 1
    },
    {
      "run": 2,
      "provider": "deepseek-harness",
      "node": "local",
      "workspace": "local",
      "startedAt": "2026-08-23T11:00:01.000Z",
      "completedAt": "2026-08-23T11:02:49.000Z",
      "durationMs": 168000,
      "outcome": "ready",
      "attempts": 1
    }
  ],
  "createdAt": "2026-08-23T10:00:00.000Z",
  "updatedAt": "2026-08-23T11:02:49.000Z"
}
```

- `provider` ≠ `model` (a harness runs many models) and `provider` ≠ `node`
  (a harness runs on many machines).
- `workspace` is a **logical** project id (`"local"` today). The node resolves
  it to its own filesystem — Work never assumes the UI path equals the
  execution path. A future node maps workspace ids to checkouts on its machine.
- `externalSessionId` is provider-run state, not the task's identity. A run
  whose provider never surfaces a session id (DeepSeek Harness headless) has
  no such field — capability differences are persisted honestly, never faked.
- `model` is only persisted when reliably known.
- `execution` mirrors the **current** run's live state (what resume and the
  existing surfaces read); each past run keeps its own provider/node/session
  in its run record.
- Result text is not embedded in the record: each run's written result lives
  at `.work/tasks/<slug>/runs/<n>/result.md`, and the current result also
  lands in the legacy `result.md` so `getWork` is unchanged.

**Run history is a Work concept** (`src/core/runs.mjs`): the run record model,
the legacy interpretation, and the projection live in core; the worker
finalizes run records; provider-specific behavior stays in providers;
execution location stays a node concern; CLI and Web render the same data
through the same actions.

### Backward compatibility

Tasks created before run history have no `runs` array. They are **interpreted
as having one historical run** — provider/node/model/session come from
`task.execution`, outcome from the task status (or the last terminal event in
the log, when it exists), timing from the real `run.started`/terminal events.
No historical file is rewritten. A `rerun` materializes that run before
appending the new one (a rerun replaces `task.execution`, so the legacy run's
provider would otherwise be lost).

### Local API

```
GET  /api/tasks                  listWork()
GET  /api/tasks/:id              getWork(id)          ({ ...task, runs, result })
POST /api/tasks                  createWork({ title, provider? })
POST /api/tasks/:id/rerun        rerunWork(id, { provider?, model? })
GET  /api/tasks/:id/runs/:n      getRun(id, n)        ({ ...runRecord, result })
POST /api/tasks/:id/allow        allowWork(id)
POST /api/tasks/:id/reject       rejectWork(id)
POST /api/tasks/:id/close        closeWork(id)
GET  /api/providers              [{ id, displayName, capabilities }]
                                     (default provider first — the registry
                                     insertion order IS the default order)
GET  /api/events                 Server-Sent Events — live normalized events
GET  /api/events/history         the persisted event log, per task
```

`/api/events` only carries events from the moment a client connects, and the
tailer never replays. `/api/events/history` reads the same append-only logs
the worker and the CLI write, so a surface opened mid-run can draw the work
it missed. It is a read-through of existing persistence, not a second store.

The API returns normalized Work concepts, never provider shapes. `getWork`
projects the task's run history (a legacy task reads as one historical run);
`getRun` returns one run's record plus its own written result.

### Event model

Provider events stop at the provider boundary. Everything else in Work speaks
this vocabulary (persisted as JSON lines in
`.work/tasks/<slug>/events.jsonl`, streamed live over SSE):

```
task.created   task.updated   task.closed
run.started    progress       tool.started   file.changed
needs_user     run.completed  run.failed
```

Run-level events (the worker's) carry the run number they belong to
(`"run": 2`), so per-run history is read back from the single append-only
log. Events written before run history existed carry no run number and belong
to run 1 — the only run a legacy task ever had.

The server tails each task's event log and broadcasts to every SSE connection,
so events written by **other processes** reach all clients:

```
task created in Web  ->  appears in TUI        (future)
permission allowed in TUI -> Web updates       (future)
task closed via CLI  ->  Web updates           (works today)
rerun via CLI        ->  Web updates           (works today)
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
- **Per-run diffs.** Each run's changed *files* are recorded (`file.changed`,
  attributed to the run); a run's actual *diff* (line-level changes) is not
  stored anywhere. The run detail and comparison show changed files only —
  never a diff reconstructed by guessing from the current repository state.
- **Concurrent runs of one task.** Two runs of the same task would race
  against the same working directory, so runs are strictly sequential
  (`2f rerun` refuses while the task is working). Isolated worktrees or
  sandboxed checkouts would be needed to parallelize — deliberately not built
  in this iteration.
- **Interactive ACP permission handling.** A headless worker cannot answer an
  ACP `session/request_permission` mid-run, so ACP permission requests are
  auto-resolved by manifest policy (declined by default) and recorded as
  progress — never a `needs_you` halt. A real permission flow (pause, ask,
  resume the same session) is future work.
- **ACP tool/file fidelity.** `tool_call` updates are mapped only when the
  agent actually reports them (`title`/`kind`/`locations`); generic updates
  (plan, usage) are ignored rather than invented, and no `file.changed` is
  guessed from prose.

## Providers

0x2F ships two real execution providers behind one contract. The contract is
what Work Core, the worker, and every client see — nothing else:

```js
{
  id: "deepseek-harness",          // stable provider id, stored on the task
  displayName: "DeepSeek Harness", // human label
  capabilities: {
    supportsResume, supportsStructuredEvents,
    supportsPermissionRequests, supportsSandbox, supportsStreaming
  },
  async start({ cwd, prompt, onEvent })                    -> outcome
  async resume({ cwd, externalSessionId, grant, onEvent }) -> outcome  // if supportsResume
}
```

Outcomes are normalized Work concepts (core/lifecycle.mjs):
`{ status: "ready", result }`, `{ status: "needs_you", reason, blockedOn }`,
`{ status: "failed", error }`. Live events (`onEvent`) are normalized Work
events (`run.started`, `progress`, `tool.started`, `file.changed`,
`needs_user`) — provider shapes stop at the provider boundary.

### Capability differences

| capability | claude-code | deepseek-harness |
| --- | --- | --- |
| `supportsResume` | yes (same-session `--resume`) | **no** (headless makes a fresh session per run) |
| `supportsStructuredEvents` | yes (stream-json) | **no** (prints the final assistant text only) |
| `supportsPermissionRequests` | yes (`permission_denials` → `needs_you`) | **no** (tools run without an approval prompt) |
| `supportsStreaming` | yes | **no** |
| `supportsSandbox` | no | no |
| `needs_you / permission` | emitted | never |
| `needs_you / decision` | parsed from `## Needs human decision` | same — it is a Work prompt convention, parsed in core |

A `needs_you` task whose provider cannot resume is refused loudly at the
action boundary ("does not support resuming sessions") instead of faking a
continuation — the declared capability, not parity theatre.

### DeepSeek Harness mapping

`dsh --profile headless "<prompt>"` (verified against `dsh` 0.1.1-rc.2 source):
one fresh persisted session per run, the final assistant text on stdout, exit
0 on a completed turn, `dsh: <code>: <message>` on stderr otherwise.

| DSH headless CLI | normalized Work |
| --- | --- |
| process spawns | `run.started` (no session id — DSH never surfaces it) |
| exit 0 + stdout text | `run.completed` + `ready` |
| `## Needs human decision` section | `needs_you / decision` |
| exit 1 / stderr | `run.failed` + `failed` |
| permission prompts | none exist in headless; `needs_user` never fires |

Only events reliably derivable from DSH are emitted. DSH is developer
preview and may change; all compatibility-sensitive code is isolated in
`src/providers/deepseek-harness.mjs` (binary override: `DSH_BIN`, default
`dsh` on PATH). The model DSH runs is its own settings concern
(`agent-default-model` in `$DSH_HOME/settings.yaml`) — 0x2F never overrides
it, so `execution.model` is only persisted when reliably known.

### Adding another provider

One file plus a registry line — nothing in core, CLI, worker, server, or UI
changes (they consume only normalized outcomes and `execution.provider`):

1. Create `src/providers/<name>.mjs` exporting a provider object with `id`,
   `displayName`, `capabilities`, and `start({ cwd, prompt, onEvent })` →
   normalized outcome (plus `resume` if supported). Keep every vendor shape
   inside this file.
2. Register it in `src/providers/index.mjs`:
   `const providers = { "claude-code": …, "deepseek-harness": …, "<name>": … };`
3. Declare capabilities honestly (`supportsResume`,
   `supportsStructuredEvents`, `supportsPermissionRequests`, …) so Work
   refuses flows the runtime can't do instead of faking them.

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
  route returns the persisted normalized log; `GET /api/providers`; provider
  selection on task creation.
- `test/deepseek-harness.test.mjs` — the DSH adapter driven through fake
  `dsh` binaries: spawn + normalization, honest capabilities, clean failure
  when DSH is absent.
- `test/provider-equivalence.test.mjs` — the SAME task text through both
  Claude Code and DeepSeek Harness (fake CLIs) normalizes to the same Work
  outcome — the proof that the provider-neutral core hosts more than one
  harness.
- `test/web-ledger.test.mjs` — the Web projection driven by real normalized
  events: provider-neutral phase classification, the travel rule (executed
  work only — Work does not forecast), the interruption tear, Needs You from
  `blockedOn`, the ready result from `file.changed`, compressed done rows,
  ledger ordering, and the run-history projection (`projectRuns`,
  `eventsForRun`).
- `test/runs.test.mjs` — the run model and lifecycle: legacy tasks read as one
  historical run (timing from the real event log when it exists), first run at
  creation, rerun appends a second run without overwriting the first, same
  task / different providers, run outcome and timing persistence, the
  sequential-run guard, per-run results, event run attribution — plus two
  end-to-end dogfooding passes through the REAL worker and both provider
  adapters (fake CLIs): one task through claude-code then deepseek-harness
  persisting as two runs, and needs_you/failed runs preserved in history.
- `test/cli-rerun.test.mjs` — the real CLI dogfooding loop: `2f new` →
  `2f rerun 1 --provider deepseek-harness` → `2f open 1` (RUNS strip) →
  `2f open 1 --run 2` (one run's facts), against fake CLIs.

## What this intentionally does NOT do

- remote execution, mini-PC networking, repo synchronization
- authentication/authorization infrastructure
- TUI, desktop app, Slack, GitHub, Linear
- multi-agent orchestration, automatic provider routing
- provider evaluation: no scores, stars, winner labels, quality percentages,
  charts, leaderboards, token-cost estimates, AI judging, or automatic
  recommendations — run history is for inspection, you form the judgment
- concurrent runs of one task (sequential only, until isolated worktrees)
- per-run diffs (changed files are recorded; line-level diffs are not)
