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
