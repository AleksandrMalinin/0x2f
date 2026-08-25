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
    pair.mjs          `2f pair`: pairing code + client-origin URL, credential
                      rotation, revocation
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
    deepseek-harness.mjs  native adapter
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
    e2e.mjs           shared Node/browser crypto: PBKDF2 code → AES-256-GCM
    ledger.mjs        pure event → ledger projection (shared with tests)
    sound-policy.mjs  when 0x2F may make a sound (pure, testable)
    sound.mjs         the slash — Web Audio, no assets
relay/                 the standalone relay service (see relay/README.md)
examples/providers/    verified manifests (Gemini, Cursor, OpenCode, Codex, command)
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
  `command-provider`, `deepseek-harness`, `provider-integration`,
  `provider-availability`, `provider-manifests`, `provider-equivalence`,
  `permission-regression`
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

## Adding a provider

**Configured (no source change):** drop one manifest into
`.work/providers/`:

```json
{
  "id": "gemini",
  "displayName": "Gemini CLI",
  "transport": "acp",                 // or "command"
  "command": ["gemini", "--acp"]      // argv array, never a shell string
}
```

Validation (`src/providers/manifests.mjs`) is strict: `id` lowercase
alphanumeric, `command` a non-empty argv array, only `{prompt}` and
`{workspace}` placeholders, and built-ins cannot be redefined. For ACP
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
2f pair --relay http://127.0.0.1:8080
```

See [`docs/remote-control.md`](remote-control.md) for the full walkthrough
and [`relay/README.md`](../relay/README.md) for deployment.
