# Provider manifests — examples

Copy any file below into your workspace's `.work/providers/` to add a
harness that 0x2F did not ship. Each file is one provider; no source changes,
no restart of anything but the CLI/server process.

Only invocations verified against official documentation are listed. Where an
agent needs authentication, that is the user's job **before** the run (see
the notes) — 0x2F never stores or enters credentials.

---

## `cursor.json` — Cursor CLI (ACP)

Verified: `agent acp` starts Cursor CLI in ACP mode
(`cursor.com/docs/cli/acp`).

```json
{
  "id": "cursor",
  "displayName": "Cursor",
  "transport": "acp",
  "command": ["agent", "acp"]
}
```

Notes:

- Pre-authenticate before launching (`agent login`, or `CURSOR_API_KEY` /
  `CURSOR_AUTH_TOKEN` in the environment). Cursor advertises `cursor_login`
  as its ACP auth method; 0x2F does not perform interactive login.
- By default 0x2F pauses on ACP permission requests and asks you
  (`"permissions": "interactive"`). For headless use, set `"permissions":
  "deny"` (decline tool requests automatically) or `"approve"` (approve
  them, equivalent to DSH headless semantics). A Cursor agent that needs
  tool approval will otherwise see its requests surface as NEEDS YOU.

## `opencode.json` — OpenCode (ACP)

Verified: `opencode acp` starts OpenCode as an ACP-compatible subprocess
(`opencode.ai/docs/acp`).

```json
{
  "id": "opencode",
  "displayName": "OpenCode",
  "transport": "acp",
  "command": ["opencode", "acp"]
}
```

## `codex-acp.json` — (removed: Codex is now a built-in native provider)

Codex no longer needs an ACP manifest: since 0x2F v0.6, `codex` is a built-in
native provider (`codex exec --json` + `codex exec resume`), with its own
documented capability boundaries (see `docs/codex-capability-map.md`). A
`.work/providers/*.json` manifest with `"id": "codex"` is rejected as a
redefinition of a built-in provider.

## `gemini.json` — (removed: Gemini CLI is now a built-in native provider)

Gemini CLI no longer needs an ACP manifest: since 0x2F v0.6, `gemini` is a
built-in native provider (`gemini -p --skip-trust -o stream-json` + `--resume
<uuid>`), with its own documented capability boundaries (see
`docs/gemini-capability-map.md`). A `.work/providers/*.json` manifest with
`"id": "gemini"` is rejected as a redefinition of a built-in provider.

## `my-agent.json` — any headless executable (command)

No protocol at all — a plain argv invocation. Only `{prompt}` and
`{workspace}` are substituted; everything else about the process is between
the executable and its own configuration.

```json
{
  "id": "my-agent",
  "displayName": "My Agent",
  "transport": "command",
  "command": ["my-agent", "--headless", "--task", "{prompt}", "--in", "{workspace}"]
}
```

Security note: adding ANY provider here grants 0x2F permission to execute
that local command in this workspace. The command runs directly (argv array,
never a shell) with the workspace as its working directory.

## Not listed

- **Claude Code** stays a built-in native provider — its permission →
  `needs_you` → interactive `--resume` flow is richer than the headless ACP
  surface expresses. No ACP manifest is claimed for it here because the
  invocation has not been verified against official docs.
- **Codex** is a built-in native provider (`codex exec --json` + thread
  resume) — no manifest needed; see `docs/codex-capability-map.md` for its
  verified capability boundaries.
- **DeepSeek Harness** stays native: its headless CLI exposes no ACP surface
  and its honest no-resume/no-events declaration is provider-specific.
- **Gemini CLI** is a built-in native provider (`gemini -p --skip-trust -o
  stream-json` + `--resume <uuid>`) — no manifest needed; see
  `docs/gemini-capability-map.md` for its verified capability boundaries.
