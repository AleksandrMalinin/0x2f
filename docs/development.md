# 0x2F — Development

How to work on this repository. For what the pieces *mean*, see
[`architecture.md`](architecture.md); for the product-level story, the root
[`README.md`](../README.md).

## Repository layout

```text
src/
  cli.mjs             the 2f CLI — one client of the shared actions
  runtime.mjs         composes store + node + providers + router + actions
  worker.mjs          detached background worker: runs one task execution
  server.mjs          local HTTP/SSE API; serves the Web surface
  server-entry.mjs    detached UI runtime: `2f ui` spawns this in the background
  ui.mjs              `2f ui` launcher: probe, spawn, wait, open the browser
  project.mjs         workspace context (.work files, prompt assembly)
  refine.mjs          REFINE — pure text transform (no task, no execution)
  render.mjs          CLI rendering
  relay/
    agent.mjs         remote-control agent: outbound WS; verifies every command
                      (AES-GCM + freshness + persisted idempotency), sends the
                      redacted encrypted projection
    pair.mjs          `2f pair`: pairing code + pairing URL, credential rotation,
                      revocation; LAN-first (detects the Mac's LAN address) with
                      the hosted relay available via --relay/--client/env
    lan.mjs           LAN transport helpers (private IPv4 detection)
    server.mjs        the SHARED relay implementation: mounted in-process by the
                      runtime for LAN pairing (mount: true), or standalone
                      (relay/server.mjs wraps it for the private deployment)
    defaults.mjs      hosted-endpoint defaults (env-overridable)
    protocol.mjs      the versioned wire contract (hello + opaque relay frames)
    project.mjs       the remote data-minimization projection (what leaves the Mac)
  core/
    actions.mjs       the single implementation of Work's business rules
    lifecycle.mjs     task state machine (working → needs_you → ready/failed → done)
    router.mjs        AUTO routing — deterministic provider selection
    runs.mjs          run history model (task └── runs)
    events.mjs        normalized event model, bus, log tailer
    store.mjs         persistence under .work/
    errors.mjs        WorkError — one error type for CLI and API
  providers/
    index.mjs         provider registry (native + manifest providers)
    claude-code.mjs   native adapter
    codex.mjs         native adapter (exec --json + thread resume)
    deepseek-harness.mjs  native adapter
    gemini.mjs        native adapter (stream-json + UUID session resume)
    acp.mjs           generic ACP provider
    command.mjs       generic command provider
    manifests.mjs     provider manifest loading + validation
  nodes/
    local.mjs         the local execution node (spawns the worker)
  web/
    index.html        Web shell
    pair.html/pair.mjs  the pairing ceremony page (client origin only)
    app.js            browser client (fetch + SSE + DOM; remote mode adapter)
    remote.mjs        the remote transport: E2E envelopes, SSE reader, cache
    e2e.mjs           shared Node/browser crypto: PBKDF2 code → AES-256-GCM;
                      pure-JS fallback (src/web/vendor/) for plain-http LAN pages
    vendor/           vendored @noble crypto for the fallback (scripts/vendor-crypto.mjs)
    ledger.mjs        pure event → ledger projection (shared with tests)
    sound-policy.mjs  when 0x2F may make a sound (pure, testable)
    sound.mjs         the slash — Web Audio, no assets
relay/                 the standalone relay service (see relay/README.md)
examples/providers/    verified manifests (Cursor, OpenCode, command; removed:
                       Codex and Gemini CLI are now built-in native providers)
test/                  node --test suite
```

## Running

```bash
npm install          # installs ws (root, for the relay agent) — nothing else
npm test             # the full suite (node --test, 300+ tests)
npm run check        # syntax-check every source and test file (node --check)
npm start            # run the CLI: node src/cli.mjs
```

`npm install -g .` puts the `2f` command on your PATH; while hacking on the
repository, `npm link` keeps it pointing at your checkout.

No build step. `src/web/` is served verbatim by `src/server.mjs` and by the
relay — edit the client and reload.

## How the pieces fit

`createRuntime(base)` (`src/runtime.mjs`) is the single composition point: it
builds the store, the local node, the event bus, the provider registry, the
router, the shared actions, and the refiner. Both the CLI (`src/cli.mjs`)
and the server (`src/server.mjs`) build a runtime and speak only through
`runtime.actions` and `runtime.events`.

The invariants that keep the codebase small:

- **Clients never implement lifecycle.** All business rules live in
  `src/core/actions.mjs`; the CLI and the HTTP API are thin wrappers.
- **Providers never leak vendor shapes.** `src/providers/*.mjs` normalize
  everything to the outcome shapes in `src/core/lifecycle.mjs` and the event
  vocabulary in `src/core/events.mjs`. A provider's real capability
  differences are declared in `capabilities`, never faked.
- **One event log.** Every surface reads the same append-only
  `events.jsonl`; the API layer tails it for live updates.
- **Rendering is a client concern.** `render.mjs` (CLI) and
  `web/ledger.mjs` (Web) both read state; neither decides what a status
  means.

## Tests

`test/` is a `node --test` suite, one file per concern:

- core: `actions`, `lifecycle`, `runs`, `events`, `store`, `routing`,
  `decision-protocol`, `task-context`
- providers: `acp-provider`, `acp-interactive-e2e` (real worker),
  `command-provider`, `deepseek-harness`, `gemini-provider`,
  `gemini-integration` (real CLI vs a local mock API),
  `provider-integration`, `provider-availability`, `provider-manifests`,
  `provider-equivalence`, `permission-regression`
- surfaces: `api`, `cli-rerun`, `ui-launch`, `render`, `web-ledger`,
  `sound-policy`, `rich`, `refine`
- remote control: `relay` (includes the relay/agent integration tests)
- fixtures: `test/fixtures/*.jsonl` — captured normalized event logs

Helpers live in `test/helpers.mjs`. The web projection
(`web/ledger.mjs`, `web/sound-policy.mjs`) is imported directly by Node
tests — no browser needed.

Run one file:

```bash
node --test test/actions.test.mjs
```

## The TUI dogfood suite

`test/tui-pty-e2e.test.mjs` is the golden-path E2E for the terminal client —
the reason a human no longer has to click through the basic TUI workflow
before every release. It drives the REAL `2f tui` entry point on a REAL
pseudo-terminal (`test/tui-pty/pty-relay.py` allocates the PTY; the test
writes keystrokes to it and reads the ANSI output), through the same
keyboard/terminal path a user uses — never through the controller functions.
Runs execute through the real detached worker against deterministic fake ACP
providers (`test/tui-pty/agents/fake-agent.mjs`): they perform real work
(they edit a real file in the workspace) and pause for real permission and
decision stops, so the suite needs no network and no model credentials and
is reproducible on any machine.

The journey covered: launch → verify the workspace → create a task with a
multi-line brief (⌃n newlines) → WORKING → live permission / NEEDS YOU →
inspect → ALLOW → READY → the real CHANGES/diff view → SEND BACK with a
correction → run 02 rebuilt with it → a decision, read in full → ANSWER &
CONTINUE → run 03 → READY → ACCEPT → DONE → overview → quit. Separate tests
cover RETRY after a normalized provider-auth failure with `p` provider
switching between runs, scrolling/navigation/search/help across a ledger
that overflows the viewport, terminal resize, and clean terminal restoration
on both `q` and SIGTERM/⌃C. Every checkpoint asserts both the visible
screen and the canonical state on disk (`task.json`, event logs, per-run
prompts), so a visually plausible screen cannot hide a broken task.

It requires `python3` (macOS and Linux ship it) and `git` — the relay in
`test/tui-pty/pty-relay.py` allocates the pseudo-terminal.

```bash
npm run test:tui        # just the TUI dogfood suite
npm test                # the whole suite (includes it)
```

The shared driver (`test/tui-pty/driver.mjs`) — PTY session, a small ANSI
emulator, key encoding, disk-state waits — also powers the exploratory mode:

```bash
npm run dogfood:tui                  # the same journey against a real provider
npm run dogfood:tui -- --provider claude-code --timeout 900
```

`dogfood:tui` (`scripts/dogfood-tui.mjs`) is **not** part of the regression
suite on purpose: it makes real model calls and needs a real harness
installed. It runs the same golden path against a real provider in a scratch
workspace (kept for inspection unless `--clean`), shows what the TUI showed
at every checkpoint, and verifies clean terminal restoration.

## The TUI visual-review pipeline

`npm run review:tui` (`scripts/review-tui.mjs`) captures a small FIXED set of
representative terminal frames by driving the same deterministic PTY journey
(the shared `test/tui-pty/driver.mjs` + fake ACP agents) — populated
overview, WORKING, a live permission, a long-question decision, READY +
the real diff view, a normalized provider-auth FAILED state, the composer,
help, and two states at a constrained 80x24 size — and saves them to
`.review/frames/`:

- `<id>.txt` — the normalized fixed-width cell grid, scrubbed of the live
  clock, elapsed durations, the machine hostname and scratch paths, so
  frames are byte-stable across runs (verified: re-captures diff clean);
- `<id>.svg` — the same cells rendered with the real theme palette at fixed
  cell metrics (no developer-terminal screenshots);
- `index.html` — a one-page gallery for human inspection;
- `report.md` / `report.json` — the structured verdict report.

Every frame is first checked with deterministic structural invariants (frame
fills the terminal exactly, no control/ANSI leaks, expected landmarks, a
single focus marker, the footer intact, elision at narrow sizes). Then —
OPTIONALLY — the frames are handed to an installed reviewer:

```bash
npm run review:tui                 # local checks; AI if claude/dsh is found
npm run review:tui -- --no-ai      # local checks only
npm run review:tui -- --ai claude  # force the Claude Code CLI reviewer
npm run review:tui -- --ai deepseek# force `dsh --profile headless`
npm run review:tui -- --strict     # exit 1 on AI findings too
```

The reviewer gets the frames inline as fixed-width text, a prompt restricted
to visual criteria only (overflow, clipping, grid alignment, hierarchy,
truncation, focus ambiguity, spacing, narrow sizes — never redesign or new
features), runs with cwd inside `.review/` (no repository tree reachable),
and must return a JSON verdict per frame. The reply is parsed and merged
into the report; the raw reply is kept when it does not parse. The pipeline
never runs during `npm test`, and with no reviewer configured it still
produces the full PASS/findings report — an AI reviewer is strictly optional.

## Adding a provider

**Configured (no source change):** drop one manifest into
`.work/providers/`:

```json
{
  "id": "cursor",
  "displayName": "Cursor",
  "transport": "acp",                 // or "command"
  "command": ["cursor", "--acp"]      // argv array, never a shell string
}
```

Validation (`src/providers/manifests.mjs`) is strict: `id` lowercase
alphanumeric, `command` a non-empty argv array, only `{prompt}` and
`{workspace}` placeholders, and built-ins (`claude-code`, `codex`,
`deepseek-harness`, `gemini`) cannot be redefined. For ACP
agents, `"permissions"` may be `"interactive"` (default), `"deny"`, or
`"approve"`. See [`examples/providers/`](../examples/providers/README.md).

**Native:** implement the provider contract in a new file under
`src/providers/` and register it in `src/providers/index.mjs` (or pass it via
`createRuntime`'s `extra` seam). The contract is in
[`src/providers/index.mjs`](../src/providers/index.mjs); the outcome shapes
are in `src/core/lifecycle.mjs`.

## Remote control locally

```bash
cd relay && npm install
node server.mjs --port 8080 --data ./data/state.json
# in another terminal, in a workspace:
2f pair          # LAN-first (same Wi-Fi) — the runtime is its own relay
2f pair --relay http://127.0.0.1:8080   # or against a local relay for dev
```

See [`docs/remote-control.md`](remote-control.md) for the full walkthrough
and [`relay/README.md`](../relay/README.md) for deployment.
