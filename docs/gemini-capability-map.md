# Gemini CLI capability map (verified 2026-08, Gemini CLI 0.57.0)

Empirically verified against the real `@google/gemini-cli` 0.57.0 binary (npm
registry, installed locally as the `gemini` executable). Claims below were
reproduced with real `gemini` processes where authentication allows it, and
the machine-readable stream vocabulary was read from the installed 0.57.0
bundle (`packages/core/src/output/types.ts`, `stream-json-formatter.ts`, and
the non-interactive runner) — the exact code this binary runs, not
documentation. Where a capability could not be exercised without valid
credentials, this document says so explicitly instead of inferring it.

## 1. Executable and authentication detection

| Question | Finding |
| --- | --- |
| Executable detection | `gemini --version` → `0.57.0`, exit 0. Resolves via PATH, or `GEMINI_BIN` / absolute path. |
| Auth model | **No auth subcommand exists.** Auth is configured in `~/.gemini/settings.json` (`auth.method`) or via env: `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA`. |
| Auth **presence** | Structurally detectable: with no auth configured, every command exits **41** and writes `Please set an Auth method in your <path>/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA` to **stderr**. Verified for text, `-o json`, and `-o stream-json` outputs, and for `--list-sessions`. |
| Auth **validity** | Only surfaces at execution time. With `GEMINI_API_KEY=not-a-real-key`: `init` + user `message` events emit, then a raw API error and stack trace land on stderr and the process exits **144** (observed). The failure text contains the API's own words (`API key not valid`, `400`, `API_KEY_INVALID`) — classifiable as auth. |
| `-o json` no-auth shape | The error is printed as JSON **on stderr** (`{"session_id":…,"error":{…}}` — note the CLI generates a session id before the auth check), stdout empty, exit 41. |

**Classifiable:** yes. Missing auth = exit 41 + the settings/env message (a
strong, stable structural signal — no parsing needed). Invalid auth = in-run
API error text (401 / 400 `API_KEY_INVALID` / "API key not valid" / "not
authenticated"). Presence is detectable before execution; validity only at
execution time — the same gap as Codex.

## 2. Non-interactive (headless) task execution

```
gemini -p "<prompt>" --skip-trust -o stream-json     # headless, JSONL events on stdout
gemini -p "<prompt>" --skip-trust -o json            # one JSON object on stdout at completion
gemini -p "<prompt>" --skip-trust -o stream-json --session-id <uuid>   # pin the session id
gemini -p "<prompt>" --skip-trust -o stream-json --resume <uuid>       # continue that session
```

- `-p/--prompt` is the headless switch; without it the CLI runs interactive.
- **Trust:** an untrusted workspace fails headless with a
  `FatalUntrustedWorkspaceError` ("Gemini CLI is not running in a trusted
  directory. To proceed, either use `--skip-trust`, set the
  `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, …"). `--skip-trust`
  sets that env var internally, so with it the folder IS trusted (verified in
  `checkPathTrust`: env source wins). Headless runs must pass `--skip-trust`.
- `-m/--model <slug>` selects the model; the `init` event echoes it (`model`,
  default `"auto"`).
- Exit codes: success → 0 (natural exit after the terminal `result` event;
  `ExitCodes.SUCCESS = 0`); no-auth → 41; input/session errors → 42;
  config errors → 52; cancellation (Ctrl+C abort) → 130
  (`FATAL_CANCELLATION_ERROR`); an in-run API failure observed → 144.

## 3. Machine-readable event/result output (`-o stream-json` JSONL)

One JSON object per line on stdout. Verified vocabulary
(`JsonStreamEventType`, identical in the legacy and ADK non-interactive
runners):

| Line | Fields | Notes |
| --- | --- | --- |
| `init` | `session_id`, `model` | First event; the **session id**; `model` echoes `-m` (or `"auto"`). |
| `message` | `role` (`user`\|`assistant`), `content`, `delta` | Assistant text streams as delta chunks; **the final response text is the concatenation of assistant `message.content` values** — the `result` event carries no text. |
| `tool_use` | `tool_name`, `tool_id`, `parameters` | Tool invocation started. `parameters` carries `file_path`/`old_string`/`new_string` for edit tools and `command` for shell tools. |
| `tool_result` | `tool_id`, `status` (`success`\|`error`), `output`, `error` | Tool completion. |
| `error` | `severity` (`warning`\|`error`), `message` | Non-fatal stream warnings and blocked-stream errors. |
| `result` | `status` (`success`\|`error`), `error?` (`type`, `message`), `stats` | **Terminal event** for both success and handled fatal errors. No response text. |

`-o json` (non-stream) prints one final object on stdout:
`{ session_id, response, stats, error?, warnings? }` — the `response` field is
the full final text. Both are stable machine-readable interfaces; the adapter
uses `stream-json` for progress/tool events and takes the result text from
assistant message deltas.

## 4. Tool/command/file events

| Event | Normalized mapping | Verified |
| --- | --- | --- |
| `tool_use` with a shell tool (`run_shell_command`/`ShellTool`; `parameters.command`) | `tool.started` with `input.command` + `tool.completed` on the matching `tool_result` | ✅ real process emitted `init`/`message`; tool events are emitted by the same emitter (bundle-verified; a full tool run needs valid auth) |
| `tool_use` with `Edit`/`MultiEdit`/`Write` (`parameters.file_path`) | `file.changed` for mutating tools only — the same convention the Claude adapter uses (an edit *call* is the honest "this file is being changed" signal; `Read`/`Grep` never produce one) | ✅ parameter schema verified in the installed bundle |
| Denied tools | `tool_result` with `status: "error"` (the tool invocation surfaces the denial to the model) | ✅ bundle-verified (`shouldConfirmExecute` throws on `deny`; the denial is a tool error) |

## 5. Permission/approval requests and in-place answering

| Question | Finding |
| --- | --- |
| Does native `-p` mode surface a permission request? | **No.** In headless mode the policy engine's default decision is `deny` (`defaultDecision = nonInteractive ? "deny" : "ask_user"`, verified in `PolicyEngine`). A tool needing the human is denied without a prompt. |
| What if a tool decision is `ask_user`? | The message bus emits `tool-confirmation-response { confirmed: false, requiresUserConfirmation: true }` when no confirmation listener is subscribed (native headless subscribes none — the ACP session is the only subscriber). No hang, no stdin wait. |
| `--approval-mode` | `default` (prompt for approval → denied headless), `auto_edit` (auto-approve edit tools), `yolo` (auto-approve all), `plan` (read-only). Non-`default` modes are overridden to `default` in an untrusted folder; `--skip-trust` makes the folder trusted so modes apply (verified in `createPolicyEngineConfig`). |
| Answering while the same run stays alive | **No in-place channel exists for native headless.** The permission surface lives in ACP mode (`--acp`), not `-p`. |

**Conclusion: `supportsPermissionRequests: false` is the honest declaration** —
the same shape as Codex. A Gemini `needs_you` can only be a **decision** (the
shared `## Needs human decision` protocol). Approval mode is a provider
invocation concern: 0x2F must pick one so the agent can actually work (see the
adapter's declaration), and `auto_edit` is the defensible default: file edits
(the core of a coding task) proceed, everything else is denied by the
headless policy engine.

## 6. Session ID discovery

- `init.session_id` — a UUID, first JSONL event, stable across the run. This
  is the session id to persist (the worker's `externalSessionId`).
- `--session-id <uuid>` pins a NEW session's id (fails with exit 42
  "Session ID … already exists" if it exists) — lets 0x2F know the id before
  the run even starts.
- Sessions persist per project as
  `~/.gemini/projects/<hash>/temp/chats/session-<timestamp>-<id8>.jsonl`
  (`Storage.getProjectTempDir()`); chat files are NOT removed by the CLI's
  cleanup (only `checkpoints/` is).

## 7. Targeted session resume

- `--resume <uuid>` resumes the exact session (verified: `SessionSelector`
  matches a full UUID; the resumed run loads the conversation and calls
  `resumeChat` with prior messages). `--resume <index>` and `--resume latest`
  also exist.
- **Trap:** `--resume latest` with no sessions silently falls back to a NEW
  session (verified: warning then a fresh `sessionId`). 0x2F must therefore
  only resume by explicit UUID, so a missing session is detectable.
- `--resume <missing-uuid>` → exit **42**, stderr
  `Error resuming session: No previous sessions found for this project.` —
  no JSON events. A resume failure is an input/session failure, not auth.
- Sessions are project-scoped, so resume works when the run happens in the
  same workspace (which is always the case in 0x2F).
- Grant semantics: Gemini has no permission state, so `allow`/`reject`/
  `continue` all reduce to "continue this session with a prompt" — exactly
  like Codex.

## 8. Result/error semantics

| Situation | Observable |
| --- | --- |
| Success | assistant `message` deltas, then `result { status: "success" }`, exit 0. Result = concatenated assistant text. |
| Handled fatal error (auth/config/tool) | `result { status: "error", error: {type, message} }`, then exit with the fatal code. |
| No auth at all | stderr message + exit 41, NO events (verified). |
| Invalid API key | `init` + user `message`, then API error text + stack to stderr, exit 144 (verified). |
| Missing resume target | stderr `Error resuming session: …`, exit 42, NO events (verified). |
| Decision protocol | The shared `## Needs human decision` / `REQUIRED: yes` convention parses from the result text exactly like the other providers — a Work convention, not a Gemini feature. |

## 9. Model selection

- `-m/--model <slug>` — verified flag; flows into the `init` event's `model`
  field (default `"auto"`).
- Unknown models: behavior at run time; no claim made here beyond the flag.

## 10. Cancellation

- SIGTERM/SIGINT → `gracefulShutdown` → `runExitCleanup()` then
  **`process.exit(0)`** (verified in `setupSignalHandlers`). **There is no
  terminal `result` event on signal-based cancellation** — a cancelled run
  looks like a successful exit code but an incomplete event stream.
- Ctrl+C inside an active turn → `FatalCancellationError` → `result` with
  `status: "error"` + exit 130.
- The provider contract's `cancel()` seam maps to killing the child; the
  worker must treat "exited without a terminal `result` event" as a failed/
  interrupted run regardless of the exit code (the same class of check the
  Claude adapter makes for a missing `result` event).

## Capability declaration for 0x2F

```js
capabilities: {
  supportsResume: true,              // --resume <uuid> continues the same session
  supportsStructuredEvents: true,    // -o stream-json JSONL (init/message/tool_use/…)
  supportsFileChanges: true,         // mutating tool_use events carry file_path (Edit/MultiEdit/Write)
  supportsCommands: true,            // shell tool_use carries the command
  supportsPermissionRequests: false, // native headless has no human approval surface (verified)
  supportsSandbox: false,            // Gemini's seatbelt sandbox is internal; 0x2F doesn't drive it
  supportsStreaming: true,           // message deltas + tool events stream over the run
  resultOnCompletion: false          // assistant text arrives incrementally, not only at the end
}
```

## Honest gaps (things Gemini cannot report or continue reliably)

1. **No in-place permission answering in native headless mode.** A tool that
   needs the human is denied; 0x2F cannot allow/reject it within the same
   run. `needs_you` from Gemini can only ever be a decision.
2. **Headless default policy denies everything.** Without an approval mode,
   the agent cannot edit files or run commands. The adapter must pass an
   approval mode (`auto_edit` is the honest default: edits proceed, shell
   denied) — a provider invocation concern, not a Work concept.
3. **`--resume latest` silently starts a new session when none exists.** 0x2F
   always resumes by explicit UUID so a missing session is a real error
   (exit 42), never a disguised fresh run.
4. **Auth validity is only discovered at execution time**, and an in-run API
   failure can exit with an unexpected code (144 observed) while dumping a
   stack to stderr — the adapter classifies by message text, not by trusting
   the exit code alone.
5. **Signal-based cancellation exits 0.** Cancellation is detected by the
   absence of a terminal `result` event, not by exit code.
6. **Sessions are project-scoped and local.** Cross-workspace resume cannot
   work (the session file lives under the first project's hash); 0x2F resumes
   in the same workspace, so this is never hit, but it is a real boundary.
