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

const TRUNC = {
  text: 500, // progress activity line
  arg: 200, // one tool argument
  path: 300, // file paths
  error: 500, // failure text
  result: 100_000, // READY result shown on the phone
  decision: 400, // decision question text
  plannedChange: 200 // allow/reject change summary
};

function trunc(value, max) {
  const s = typeof value === "string" ? value : "";
  return s.length > max ? s.slice(0, max) + "…" : s;
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
    return { command: trunc(input.command, TRUNC.arg) };
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
    out.description = trunc(blockedOn.description, TRUNC.text);
    out.plannedChange = trunc(blockedOn.plannedChange, TRUNC.plannedChange);
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
    out.text = trunc(blockedOn.text, TRUNC.decision);
  }
  return out;
}

export function projectRun(run) {
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
    error: trunc(run.error, TRUNC.error),
    // The AUTO routing label (why this task ran here) — the reason is a
    // short availability fact, not internal state.
    ...(run.routing?.mode === "auto" ? { routing: { mode: "auto", reason: run.routing.reason } } : {})
  };
}

// The READY result text the phone shows — capped, not truncated mid-thought
// beyond a generous bound.
export function projectResult(text) {
  return trunc(text, TRUNC.result);
}

export function projectTask(task, base) {
  if (!task || typeof task !== "object") return null;
  return {
    id: task.id,
    title: task.title ?? "",
    status: task.status ?? "working",
    provider: task.execution?.provider ?? null,
    model: task.execution?.model ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    error: trunc(task.error, TRUNC.error),
    blockedOn: projectBlockedOn(task.blockedOn, base),
    runs: Array.isArray(task.runs) ? task.runs.map(projectRun).filter(Boolean) : undefined
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
      return { ...common, text: trunc(event.text, TRUNC.text) };
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
          message: trunc(event.detail?.message, TRUNC.text)
        },
        blockedOn: projectBlockedOn(event.blockedOn, base)
      };
    case "permission.resolved":
      return { ...common, grant: event.grant ?? null };
    case "run.completed":
      return { ...common, status: event.status ?? null };
    case "run.failed":
      return { ...common, error: trunc(event.error, TRUNC.error) };
    case "task.updated":
      return { ...common, status: event.status ?? null };
    case "task.created":
    case "task.closed":
      return { ...common, status: event.status ?? null };
    case "task.answered":
      return { ...common, answer: trunc(event.answer, TRUNC.text) };
    case "task.note":
      return { ...common, note: trunc(event.note, TRUNC.text) };
    default:
      return common;
  }
}

// The full remote state pull the phone issues on connect/reconnect:
// redacted tasks, recent redacted events per task, provider descriptors,
// routing, and the Mac's clock (so the phone can correct skew on commands).
export async function projectSnapshot({ tasks, eventsByTask, providers, routing, base, serverTime }) {
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
    serverTime: serverTime ?? null
  };
}

export const REMOTE_LIMITS = TRUNC;
