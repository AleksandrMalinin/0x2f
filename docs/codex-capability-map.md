# Codex CLI capability map (verified 2026-08, Codex 0.149.1)

Empirically verified against the real `@openai/codex` 0.149.1 binary
(npm registry, sha512-verified, signed by OpenAI OpCo, LLC) driving a local
deterministic mock of the Responses API (`wire_api = "responses"` over
`model_providers.<name>.base_url`). Every claim below was reproduced with a
real `codex exec` process; nothing is inferred from empty/non-empty event
arrays. The machine-readable surface is `codex exec --json` (JSONL on stdout).

## 1. Executable and authentication detection

| Question | Finding |
| --- | --- |
| Executable detection | `codex --version` → `codex-cli 0.149.1`, exit 0. `codex` resolves via PATH, or `CODEX_BIN`/absolute path. |
| Auth presence | `codex login status` → `Logged in using ChatGPT` (exit 0) when `$CODEX_HOME/auth.json` has credentials; `Not logged in` when it does not. Exit is 0 in both cases. |
| Auth **validity** | NOT detectable from `login status`. A stale token still reports "Logged in using ChatGPT"; the failure only surfaces at exec time: `turn.failed` with `Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.` (exit 1). |
| Provider-level auth | With `OPENAI_API_KEY` set, exec hits the provider and a provider 401 becomes `error` + `turn.failed` with `unexpected status 401 Unauthorized: ...` (exit 1). Message contains "401" and the provider's own text. |
| No auth at all | `turn.failed` with `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header` (exit 1). |

**Classifiable:** yes. Auth failures are structurally visible as `turn.failed`
whose `error.message` matches `401|unauthenticated|refresh token|Invalid API
key|Missing bearer|not logged in`. Presence vs validity is a real gap: 0x2F can
detect that Codex is installed and that credentials exist, but only execution
tells it the credentials work.

## 2. Non-interactive task execution

```
codex exec --json "<prompt>"          # JSONL events on stdout
codex exec --json -o last.txt "<prompt>"   # also writes final message to last.txt
codex exec resume <session-id> --json "<prompt>"   # continue an existing thread
codex exec resume --last --json "<prompt>"        # continue the most recent thread
```

- Prompt as argv, from stdin (`-`), or piped (appended as a `<stdin>` block).
- `--skip-git-repo-check` for non-git dirs; `-C/--cd <dir>` for the working root.
- `-m/--model <model>` selects the model (verified: flows into the Responses
  POST body verbatim). `-c model=...` works too.
- Sandbox: `-s read-only|workspace-write|danger-full-access`;
  `--approve-for-me` (auto-approve via workspace-write review);
  `--dangerously-bypass-approvals-and-sandbox`. In THIS smoke environment the
  seatbelt sandbox cannot apply (`sandbox_apply: Operation not permitted`), so
  tool execution required the bypass flag; on a normal Mac the default
  read-only sandbox applies.
- Exit codes: `turn.completed` → 0; `turn.failed` → 1.

## 3. Machine-readable event/result output (`exec --json` JSONL)

Top-level lines (one JSON object per line):

| Line | Fields |
| --- | --- |
| `thread.started` | `thread_id` — the **session id** |
| `turn.started` | — |
| `item.started` / `item.updated` / `item.completed` | `item.id`, `item.type`, type fields below |
| `turn.completed` | `usage.{input_tokens,cached_input_tokens,output_tokens}` |
| `turn.failed` | `error.message` (terminal) |
| `error` | `message` (transient, e.g. `Reconnecting... 1/5` — non-fatal) |

Item types observed: `agent_message` (`text` — the result),
`reasoning` (`text`), `command_execution` (`command`, `aggregated_output`,
`exit_code`, `status`), `file_change` (`changes[{path,kind}]`, `status` —
**documented, but never emitted by exec; see §4**), `mcp_tool_call`,
`web_search`, `todo_list`, `error` (non-fatal warning as an item).

A session-id note: `thread_id` is also carried in request headers
(`session-id`, `thread-id`) and inside `x-codex-turn-metadata`
(`session_id`, `thread_id`, `turn_id`).

## 4. Tool/command/file events

| Event | Normalized mapping | Verified |
| --- | --- | --- |
| `command_execution` item.started/completed | `tool.started` (with `input.command`) + `tool.completed` (isError = exit_code !== 0) | ✅ real command ran, output + exit code captured |
| `file_change` items | `file.changed` | ❌ **never emitted by `codex exec --json` in any tested configuration** |

The `file_change` line type exists in the vocabulary and in the binary, but
empirical attempts to produce it all failed: `apply_patch` as a Responses
function call is rejected (`Fatal error: tool apply_patch invoked with
incompatible payload`; `apply_patch approval is not supported in exec mode`);
a shell-invoked `apply_patch` succeeds and reports only `command_execution`
with the changed path buried in `aggregated_output` text (`M hello.txt`);
enabling the under-development `cwd_relative_turn_diffs` feature changed
nothing. **Conclusion: exec cannot report changed-file paths structurally —
`supportsFileChanges: false` is the honest declaration, and a `file.changed`
event must NOT be fabricated from command text.**

Tool execution works when the sandbox can apply; escalated commands
(`require_escalated`/`justification`) are rejected under the default policy
(see §5). No `apply_patch` tool is offered to the model in exec mode.

## 5. Permission/approval requests and in-place answering

| Question | Finding |
| --- | --- |
| Does exec surface a permission request? | **No.** Default approval policy is `Never`: an escalated command is rejected with `approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never`. |
| `--ask-for-approval` on exec? | Not an exec flag (top-level only). `codex exec -a on-request` → `error: unexpected argument '-a' found`. |
| `--approve-for-me` | Auto-approves via automatic review (workspace-write) — no human. |
| `request_user_input` tool | `request_user_input is unavailable in Default mode` (Plan mode only). |
| `exec_permission_approvals` feature | `under development`, off by default. |
| Answering while the same run stays alive | **No.** `codex queue --thread <id> --message` accepts a thread id and returns a queued-message id, but a running `codex exec` process does **not** consume queued messages (verified: the queued message was accepted; the exec run died on its stream error). Queue targets the persistent app-server daemon, not transient exec processes. |

**Conclusion: `supportsPermissionRequests: false` is the honest declaration.**
Codex exec has no human-in-the-loop permission surface; a blocked-on-permission
state cannot occur, so there is nothing to allow/reject and no same-session
resume after a permission halt. 0x2F's `needs_you` for Codex can only ever be a
**decision** (the shared `## Needs human decision` protocol).

## 6. Session ID discovery

- `thread.started.thread_id` — UUID, present on the first JSONL line, stable
  across the run. This is the session id to persist.
- Sessions persist as `rollout-<timestamp>-<thread_id>.jsonl` under
  `$CODEX_HOME/sessions/YYYY/MM/DD/`, so a thread id is durable and
  addressable later.

## 7. Targeted session resume

- `codex exec resume <thread_id> --json "<prompt>"` resumes the SAME thread
  (verified: same `thread_id` in `thread.started` and in request headers) and
  the resumed POST **carries prior conversation context** (verified: prior
  assistant message present in the resumed request's `input`).
- `codex exec resume --last --json "<prompt>"` resumes the most recent session.
- Grant semantics: Codex has no permission state, so `allow`/`reject`/`continue`
  all reduce to "continue this thread with a prompt" — resume is a
  conversation continuation, not a permission grant.

## 8. Result/error semantics

| Situation | Observable |
| --- | --- |
| Success | `agent_message` item.completed(s) then `turn.completed`; exit 0. Result = last `agent_message.text` (also via `-o` file). |
| Provider 5xx / stream drop | retries (`Reconnecting... 1/5`) then `turn.failed` + exit 1. |
| Auth failure | `error` + `turn.failed` with the 401/refresh message, exit 1. |
| Early limits / refusal | `turn.failed` with reason text, exit 1. |
| Decision protocol | The shared `## Needs human decision` / `REQUIRED: yes` convention parses from the result text exactly like the other providers — a Work convention, not a Codex feature. |

## 9. Model selection

- `-m/--model <slug>` — verified flowing into the Responses POST body.
- `-c model=...` config override; `model` in `config.toml`.
- Unknown models produce a non-fatal `item.completed` error
  (`Model metadata for ... not found`) then continue with fallback metadata.

## 10. Cancellation

- SIGTERM → clean exit (verified: the exec process died promptly on SIGTERM).
- The provider contract's `cancel()` seam maps to killing the child (and the
  worker already handles SIGTERM).

## Capability declaration for 0x2F

```js
capabilities: {
  supportsResume: true,              // exec resume <thread_id>, context carried
  supportsStructuredEvents: true,    // exec --json JSONL
  supportsFileChanges: false,        // file_change never emitted by exec (verified)
  supportsCommands: true,            // command_execution items
  supportsPermissionRequests: false, // no human approval surface in exec (verified)
  supportsSandbox: false,            // Codex's sandbox is internal; 0x2F doesn't drive it
  supportsStreaming: true,           // events stream over the run
  resultOnCompletion: false          // result text arrives with agent_message items
}
```

## Honest gaps (things Codex cannot report or continue reliably)

1. **Changed-file paths** are not structurally available from exec — only
   command text. 0x2F will show tool activity honestly (commands) and never
   claim file changes it cannot see.
2. **Permission blocks cannot occur and cannot be answered in place.** A task
   that needs the human is a decision (answered, then continued by rerun), not
   a permission (allow/reject + same-session resume).
3. **Auth validity is only discovered at execution time** — presence detection
   (`login status`) cannot distinguish a live token from a stale one.
4. **In-place mid-run interaction is unavailable** for transient exec runs
   (`queue` targets the daemon; `request_user_input` is Plan-mode only).
5. The seatbelt sandbox cannot apply inside sandboxed/CI environments; there,
   tool execution requires `--dangerously-bypass-approvals-and-sandbox`
   (a deployment decision, not something 0x2F chooses silently).
