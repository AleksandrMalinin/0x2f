// CLI rendering — presentation for the terminal client only.
//
// Rendering is a client concern: the CLI groups and labels tasks the way a
// terminal likes; the Web client renders its own way. Neither decides what a
// status MEANS — that stays in core/lifecycle.mjs and core/actions.mjs.

import { getProvider } from "./providers/index.mjs";

export function blockedReasonLabel(task) {
  const blocked = task.blockedOn;
  if (!blocked) return null;
  if (blocked.type === "permission") return "Permission required";
  if (blocked.type === "decision") return "Decision needed";
  return "Needs you";
}

export function providerName(task) {
  const provider = getProvider(task.execution?.provider);
  return provider?.displayName ?? task.execution?.provider ?? "unknown";
}

function age(task) {
  const ms = Date.now() - new Date(task.createdAt).getTime();
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function renderTasks(tasks) {
  const groups = [
    ["NEEDS YOU", ["needs_you"]],
    ["WORKING", ["working"]],
    ["READY", ["ready"]],
    ["FAILED", ["failed"]],
    ["DONE", ["done"]]
  ];

  const out = ["TODAY", ""];

  for (const [heading, statuses] of groups) {
    const items = tasks.filter(t => statuses.includes(t.status));
    if (!items.length) continue;

    out.push(heading, "");
    for (const item of items) {
      out.push(
        `  #${String(item.id).padStart(3, "0")}  ${item.title}  ${age(item)}`
      );
      const reason = blockedReasonLabel(item);
      if (reason) out.push(`        ${reason}`);
    }
    out.push("");
  }

  if (!tasks.length) out.push("No tasks yet.");
  return out.join("\n");
}

// --- run history (CLI rendering) -------------------------------------------

const RUN_STATE_LABELS = {
  working: "WORKING",
  needs_you: "NEEDS YOU",
  ready: "READY",
  failed: "FAILED"
};

// 48s / 4m12s / 1h02m — the terminal's run-clock, not the ledger's m:ss.
export function fmtRunDuration(durationMs) {
  if (
    durationMs === null ||
    durationMs === undefined ||
    !Number.isFinite(durationMs)
  ) {
    return "—";
  }
  const total = Math.max(0, Math.round(durationMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return s ? `${m}m${String(s).padStart(2, "0")}s` : `${m}m`;
  return `${s}s`;
}

// The RUNS strip for `2f open`. Restrained by design: this is inspection,
// not evaluation — no scores, no winners, no recommendations.
export function renderRuns(runs) {
  const out = ["RUNS", ""];
  if (!runs.length) {
    out.push("  (no runs recorded)");
    out.push("");
    return out.join("\n");
  }
  const width = Math.max(...runs.map(r => String(r.provider ?? "?").length));
  for (const run of runs) {
    const state =
      RUN_STATE_LABELS[run.outcome] ?? String(run.outcome ?? "?").toUpperCase();
    out.push(
      `  ${String(run.run).padStart(2, "0")}   ${String(run.provider ?? "?").padEnd(width)}   ${fmtRunDuration(run.durationMs).padStart(6)}   ${state}`
    );
  }
  out.push("");
  return out.join("\n");
}
