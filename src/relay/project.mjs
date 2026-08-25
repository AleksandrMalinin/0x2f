// Remote projection — the single, explicit data-minimization boundary between
// the Mac and the remote-control surface.
//
// Everything the agent sends to the phone goes through this module. The
// LOCAL event log, CLI and Web UI keep full fidelity; the remote projection
// drops anything the mobile Attention Stack does not genuinely need:
//
//   - blockedOn.raw and complete tool inputs (Edit old_string/new_string,
//     full Bash commands) — replaced by a single short argument;
//   - absolute paths and the workspace `base` — paths are relative to the
//     workspace, and out-of-workspace paths reduce to their basename;
//   - provider session ids (externalSessionId) and internal execution
//     metadata (node, workspace, pid);
//   - unbounded prose — progress/notes/errors/results are capped.
//
// Permission decisions keep what the user needs to safely ALLOW/REJECT: the
// tool, the (relative) file, the planned-change snippet, the description and
// the offered options. Only `raw` (the full tool input JSON) is removed.

import { FAILURE_KINDS } from "../core/lifecycle.mjs";
import { MAX_BRIEF } from "../core/limits.mjs";

const TRUNC = {
  text: 500, // progress activity line
  arg: 200, // one tool argument
  path: 300, // file paths
  error: 500, // failure text
  result: 100_000, // READY result shown on the phone
  // §03: raised to match the storage cap (core/lifecycle.mjs) — the question
  // is agent-authored prose about the user's own repo, not sensitive
  // metadata, and it was the SECOND of two cuts that destroyed it before any
  // surface (including the phone) could render it in full.
  decision: 4000,
  // The task brief is the USER'S OWN text about their own repository, and
  // it is the one thing on the phone that says what the task actually is.
  // Carried in full: the action boundary already caps it at MAX_BRIEF, so
  // this bound is the same bound — the remote surface loses nothing, and a
  // long brief pasted on the Mac reads whole on the phone.
  brief: MAX_BRIEF,
  workspaceLabel: 40, // §02: basename only, never the absolute path
  node: 60, // machine display name (os.hostname() or the paired agent name)
  plannedChange: 200 // allow/reject change summary
};

function trunc(value, max, base) {
  let s = typeof value === "string" ? value : "";
  // Absolute workspace paths must never leave the Mac, including inside
  // prose (progress, errors, answers) — replace the base prefix with "…".
  if (base && s.includes(base)) {
    s = s.split(base).join("…");
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Prose a human must read in full (a decision question, a task brief): if a
// bound is ever actually hit, that must read as an explicit "the relay cut
// this", never as a bare "…" indistinguishable from the author's own
// writing — and the surface is told so it can SAY so rather than ending the
// text mid-thought. Still strips an absolute workspace path first, exactly
// like every other field (prose can quote a path).
//
// Returns { text, truncated } so callers can carry the flag to the UI.
function truncProse(value, max, base) {
  let s = typeof value === "string" ? value.trim() : "";
  if (base && s.includes(base)) s = s.split(base).join("…");
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + "\n\n[truncated by the relay]", truncated: true };
}

// Paths: inside the workspace → relative; outside → basename only. Either way
// the machine's absolute layout never leaves the Mac.
export function relPath(base, file) {
  if (!file) return "";
  const s = String(file);
  if (base) {
    const prefix = base.endsWith("/") ? base : base + "/";
    if (s.startsWith(prefix)) {
      const rel = s.slice(prefix.length);
      return trunc(rel || ".", TRUNC.path);
    }
  }
  const basename = s.split(/[\\/]/).pop() || s;
  return trunc(basename, TRUNC.path);
}

// The single tool argument the ledger draws, mirroring stepArgument()'s field
// priority — but keeping the `command` field when present so the ledger still
// classifies the step as a command. Everything else about the tool call is
// dropped.
function projectToolInput(input, base) {
  if (!input || typeof input !== "object") return {};
  if (typeof input.command === "string") {
    return { command: trunc(input.command, TRUNC.arg, base) };
  }
  for (const field of ["file_path", "path", "notebook_path", "pattern", "query", "prompt", "url"]) {
    if (typeof input[field] === "string" && input[field]) {
      return { [field]: relPath(base, input[field]) };
    }
  }
  return {};
}

export function projectBlockedOn(blockedOn, base) {
  if (!blockedOn || typeof blockedOn !== "object") return null;
  const out = { type: blockedOn.type ?? null };
  if (blockedOn.type === "permission") {
    out.tool = blockedOn.tool ?? null;
    out.file = relPath(base, blockedOn.file);
    out.description = trunc(blockedOn.description, TRUNC.text, base);
    out.plannedChange = trunc(blockedOn.plannedChange, TRUNC.plannedChange, base);
    out.canAllow = blockedOn.canAllow !== false;
    out.canReject = blockedOn.canReject !== false;
    out.live = blockedOn.live === true;
    if (Array.isArray(blockedOn.options)) {
      out.options = blockedOn.options.map(o => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind
      }));
    }
  } else if (blockedOn.type === "decision") {
    out.text = truncProse(blockedOn.text, TRUNC.decision, base).text;
  }
  return out;
}

export function projectRun(run, base) {
  if (!run || typeof run !== "object") return null;
  return {
    run: run.run,
    provider: run.provider ?? null,
    model: run.model ?? null,
    outcome: run.outcome ?? "working",
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    durationMs: run.durationMs ?? null,
    attempts: run.attempts ?? 1,
    error: trunc(run.error, TRUNC.error, base),
    // The AUTO routing label (why this task ran here) — the reason is a
    // short availability fact, not internal state.
    ...(run.routing?.mode === "auto" ? { routing: { mode: "auto", reason: trunc(run.routing.reason, TRUNC.text, base) } } : {})
  };
}

// The READY result text the phone shows — capped, not truncated mid-thought
// beyond a generous bound.
export function projectResult(text, base) {
  return trunc(text, TRUNC.result, base);
}

// §01: only a recognized kind crosses the relay boundary — the same rule
// core/lifecycle.mjs enforces when a provider outcome is first applied to
// the task. This is defense in depth, not trust: a value that already
// passed that gate is re-checked here rather than assumed.
function projectFailure(failure) {
  if (!failure || !FAILURE_KINDS.includes(failure.kind)) return undefined;
  return {
    kind: failure.kind,
    ...(typeof failure.remedy === "string" && failure.remedy.trim()
      ? { remedy: trunc(failure.remedy, TRUNC.arg) }
      : {})
  };
}

export function projectTask(task, base) {
  if (!task || typeof task !== "object") return null;
  // The user's own words, carried whole (see TRUNC.brief). A task created
  // before `brief` existed falls back to its title, which WAS the full text
  // then. `briefTruncated` stays false in practice — the cap equals the one
  // the action already enforced — but when it is true the phone SAYS the
  // text was cut instead of just ending mid-sentence.
  const brief = truncProse(task.brief ?? task.title, TRUNC.brief, base);
  return {
    id: task.id,
    title: task.title ?? "",
    brief: brief.text,
    ...(brief.truncated ? { briefTruncated: true } : {}),
    status: task.status ?? "working",
    provider: task.execution?.provider ?? null,
    model: task.execution?.model ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    error: trunc(task.error, TRUNC.error, base),
    failure: projectFailure(task.failure),
    blockedOn: projectBlockedOn(task.blockedOn, base),
    runs: Array.isArray(task.runs) ? task.runs.map(r => projectRun(r, base)).filter(Boolean) : undefined
  };
}

export function projectEvent(event, base) {
  if (!event || typeof event !== "object") return null;
  const common = {
    type: event.type,
    taskId: event.taskId,
    at: event.at,
    ...(typeof event.run === "number" ? { run: event.run } : {})
  };
  switch (event.type) {
    case "run.started":
      // The provider session id stays on the Mac.
      return common;
    case "progress":
      return { ...common, text: trunc(event.text, TRUNC.text, base) };
    case "tool.started":
      return { ...common, name: event.name ?? null, input: projectToolInput(event.input, base) };
    case "tool.completed":
      return { ...common, isError: event.isError === true };
    case "file.changed":
      return { ...common, path: relPath(base, event.path) };
    case "needs_user":
      return {
        ...common,
        reason: event.reason ?? null,
        detail: {
          tool: event.detail?.tool ?? null,
          file: relPath(base, event.detail?.file),
          message: trunc(event.detail?.message, TRUNC.text, base)
        },
        blockedOn: projectBlockedOn(event.blockedOn, base)
      };
    case "permission.resolved":
      return { ...common, grant: event.grant ?? null };
    case "run.completed":
      return { ...common, status: event.status ?? null };
    case "run.failed":
      return { ...common, error: trunc(event.error, TRUNC.error, base) };
    case "task.updated":
      return { ...common, status: event.status ?? null };
    case "task.created":
    case "task.closed":
      return { ...common, status: event.status ?? null };
    case "task.answered":
      return { ...common, answer: trunc(event.answer, TRUNC.text, base) };
    case "task.note":
      return { ...common, note: trunc(event.note, TRUNC.text, base) };
    default:
      return common;
  }
}

// §02: the basename ONLY — never the absolute path (that stays on the Mac,
// exactly like `base` itself). Truncated from the LEFT so the distinguishing
// tail survives a long name, matching how the desktop mark would rather
// lose a prefix than the part that actually tells two workspaces apart.
export function projectWorkspaceLabel(base) {
  if (!base) return null;
  const label = String(base).split(/[\\/]/).filter(Boolean).pop() || String(base);
  return label.length > TRUNC.workspaceLabel
    ? "…" + label.slice(-(TRUNC.workspaceLabel - 1))
    : label;
}

// The full remote state pull the phone issues on connect/reconnect:
// redacted tasks, recent redacted events per task, provider descriptors,
// routing, and the Mac's clock (so the phone can correct skew on commands).
export async function projectSnapshot({ tasks, eventsByTask, providers, routing, base, serverTime, node }) {
  return {
    tasks: tasks.map(t => projectTask(t, base)),
    eventsByTask: Object.fromEntries(
      Object.entries(eventsByTask).map(([id, events]) => [
        id,
        events.map(e => projectEvent(e, base)).filter(Boolean)
      ])
    ),
    providers: providers.map(p => ({
      id: p.id,
      displayName: p.displayName,
      integrationType: p.integrationType,
      available: p.available
    })),
    routing: {
      default: routing?.default ?? null,
      prefer: Array.isArray(routing?.prefer) ? routing.prefer : []
    },
    // §02/§01: bounded, pairing-scoped identity — never the absolute path
    // (workspace.path stays Mac-only; see src/server.mjs's LOCAL bootstrap).
    // `node` is a device name (os.hostname() or the paired agent name), the
    // same class of exposure as a provider's displayName.
    workspace: base ? { label: projectWorkspaceLabel(base) } : null,
    node: node ? trunc(node, TRUNC.node) : null,
    serverTime: serverTime ?? null
  };
}

export const REMOTE_LIMITS = TRUNC;
