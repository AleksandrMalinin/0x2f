// The TUI view model — shared Work state projected into the shape the
// finalized design draws.
//
// This module reads; it never decides. What a status MEANS stays in
// core/lifecycle.mjs, what an action DOES stays in core/actions.mjs, and how
// a run's shape is derived from its event log stays in src/web/ledger.mjs —
// which is imported here rather than reimplemented, so the terminal and the
// browser can never disagree about what a run did. The only thing invented
// below is terminal vocabulary: five short state keys the design's layout
// uses as column and group names.
//
// The design's mock runtime carried a few fields no real provider reports
// (per-file line deltas, a known total duration for a progress bar). Those
// are absent here rather than fabricated: a run's hunks come from the actual
// working tree (core/diff.mjs via actions.getTaskDiff), and the progress
// rule draws a percentage only when a real baseline exists — this task's
// own prior runs (see ledger.progressPercent) — falling back to reported
// signals for run 1. READY lists changed files without deltas.

import os from "node:os";
import {
  toSteps,
  projectRuns,
  relativePath,
  firstSentence,
  restAfterFirstSentence,
  inferFailureKind,
  authFailureCopy,
  fidelity,
  progressPercent
} from "../web/ledger.mjs";
import { deriveWorkspace } from "../project.mjs";
import { currentRunNumber } from "../core/runs.mjs";
import { providerSignature, providerName } from "./theme.mjs";

// Work status -> the short key the design's groups, glyphs and filters use.
export const STATE_KEY = {
  needs_you: "needs",
  failed: "failed",
  ready: "ready",
  working: "working",
  done: "done"
};

// The ledger's priority order: what wants you, then what is broken, then
// what is finished but unaccepted, then what is moving, then what is closed.
// It matches src/web/ledger.mjs's ranking in intent — needs_you first,
// closed last — with FAILED promoted above READY because the design's left
// pane groups the two things that require a decision at the top.
const ORDER = ["needs", "failed", "ready", "working", "done"];

export const GROUPS = [
  ["needs", "NEEDS YOU"],
  ["failed", "FAILED"],
  ["ready", "READY"],
  ["working", "WORKING"],
  ["done", "CLOSED"]
];

export const FILTERS = ["ALL", "NEEDS YOU", "FAILED", "READY", "WORKING"];
export const FILTER_KEYS = ["all", "needs", "failed", "ready", "working"];

function providerLookup(providers) {
  return id => {
    const provider = providers?.getProvider?.(id) ?? null;
    return {
      id: id ?? null,
      sig: providerSignature(id, provider?.displayName),
      name: providerName(id, provider?.displayName),
      displayName: provider?.displayName ?? id ?? "unknown"
    };
  };
}

// The capability map src/web/ledger.mjs expects: id -> { displayName,
// capabilities }. Built from the live registry, so a configured ACP or
// command provider is projected exactly like a native one.
export function providerMap(providers) {
  const out = {};
  for (const provider of providers?.listProviders?.() ?? []) {
    out[provider.id] = {
      displayName: provider.displayName,
      capabilities: provider.capabilities ?? {}
    };
  }
  return out;
}

// The human record on a task, in the order it was made. Read from the event
// log (task.note / task.answered / task.corrected), which is the only place
// that says WHICH kind of input it was and when — task.context.notes is one
// flat list. A task whose events predate those types falls back to that list.
function notesOf(task, events) {
  const out = [];
  let run = 1;
  for (const event of events) {
    if (event.type === "run.started") run = Number(event.run ?? run) || run;
    if (event.type === "task.note" && event.note) {
      out.push({ kind: "note", text: String(event.note), run });
    } else if (event.type === "task.answered" && event.answer) {
      out.push({ kind: "answer", text: String(event.answer), run });
    } else if (event.type === "task.corrected" && event.correction) {
      out.push({ kind: "correction", text: String(event.correction), run });
    }
  }
  if (out.length) return out;
  return (task.context?.notes ?? []).map(n => ({
    kind: "note",
    text: String(n.text ?? ""),
    run: 1
  }));
}

// The permission or decision the task is parked on, in the design's fields.
// Nothing is invented: a provider that supplied no planned change simply has
// no `plan` line.
function haltOf(task, base) {
  const blocked = task.blockedOn;
  if (task.status !== "needs_you" || !blocked) return null;
  if (blocked.type === "decision") {
    const text = String(blocked.text ?? "").trim();
    return {
      kind: "decision",
      // The FULL question, split only for typographic weight — the heading
      // is its first sentence, the body is everything after it. Nothing is
      // truncated here; the view wraps it.
      question: firstSentence(text),
      detail: restAfterFirstSentence(text),
      note:
        "a decision is not resumable in place — your answer is recorded on the task and the next run continues with it"
    };
  }
  const path = relativePath(base, blocked.file);
  const description =
    blocked.description && blocked.description !== blocked.tool
      ? String(blocked.description)
      : "";
  return {
    kind: "permission",
    op: String(blocked.tool ?? "write").toUpperCase(),
    path: path || "(no path reported)",
    plan: String(blocked.plannedChange ?? description ?? "").trim(),
    why: blocked.plannedChange ? description : "",
    options: (blocked.options ?? []).map(o => String(o.name ?? "")).filter(Boolean),
    partial: blocked.canAllow === false || blocked.canReject === false,
    live: blocked.live === true,
    note:
      blocked.live === true
        ? "resumable — the same run continues the moment you allow"
        : "the same provider session resumes when you allow"
  };
}

function failOf(task, steps, files, provider, node) {
  if (task.status !== "failed") return null;
  const last = [...steps].reverse().find(s => s.kind === "tool" || s.kind === "command");
  const kind = inferFailureKind(task);
  const auth =
    kind === "auth"
      ? authFailureCopy(provider.displayName, node, task.failure?.remedy)
      : null;
  // The failure in two parts: the one line the band shows, and the rest of
  // what the provider wrote, kept verbatim for the demoted block below it.
  // Nothing is thrown away — a truncated stack trace is the one thing a
  // failed run's reader actually needs.
  const error = String(task.error ?? "Execution failed").trim();
  const lines = error.split("\n").filter(l => l.trim());
  // The line a human reads first. A provider that threw prints its stack
  // starting at the throwing frame, so the first LINE is often an internal
  // path — the error line, when there is one, is the honest headline.
  const firstLine = lines.find(l => /\berror\b\s*:/i.test(l)) ?? lines[0] ?? error;
  const detail = error.slice(error.indexOf(firstLine) + firstLine.length).trim();
  return {
    at: last ? `${last.verb.toLowerCase()} ${last.arg}`.trim() : "before anything was reported",
    reason: error,
    headline: firstLine.trim(),
    detail,
    kept: files.length
      ? `${files.length} ${files.length === 1 ? "file" : "files"} left modified in the working tree`
      : "nothing was reported as changed",
    kind,
    remedy: task.failure?.remedy ?? null,
    auth
  };
}

// One task, fully projected. `events` is the task's normalized event log.
export function projectTask(task, events, opts = {}) {
  const { base = "", providers = {}, lookup, node = "", now = Date.now() } = opts;
  const provider = lookup(task.execution?.provider);
  const { origin, lastAt, steps, files, activity, sessionId } = toSteps(task, events, { base });

  const state = STATE_KEY[task.status] ?? "working";
  const running = state === "working";
  const finished = state === "ready" || state === "done" || state === "failed";
  // A finished run's clock stops at its last reported event; a live one keeps
  // running. Attention time is not execution time — a task parked on you for
  // an hour has a long wait, not a long run.
  const elapsed = Math.max(0, ((running || state === "needs" ? now : lastAt) - origin) / 1000);

  // The progress rule's percentage, measured against THIS run's own clock
  // (a rerun's elapsed must not include its predecessors) and this task's
  // prior run durations — the only real baseline that exists. Null for run 1,
  // where the rule draws reported signals instead (see ledger.progressPercent).
  const runStartedAt = task.runs?.at(-1)?.startedAt;
  const runElapsed = runStartedAt
    ? Math.max(0, (now - Date.parse(runStartedAt)) / 1000)
    : elapsed;
  const progress = progressPercent(task, runElapsed);

  const run = currentRunNumber(task);
  const runs = projectRuns(task.runs ?? [], {
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, p]) => [id, p.displayName])
    )
  });

  const opened = Math.max(0, (now - (Date.parse(task.createdAt ?? "") || now)) / 60000);

  return {
    id: task.id,
    idLabel: String(task.id).padStart(3, "0"),
    slug: task.slug,
    title: task.title ?? "",
    brief: task.brief ?? task.title ?? "",
    status: task.status,
    state,
    provider: task.execution?.provider ?? null,
    providerSig: provider.sig,
    providerName: provider.name,
    coarse: fidelity(task.execution?.provider, providers) === "coarse",
    run,
    runs,
    history: runs.filter(r => r.run !== run),
    elapsed,
    progress,
    opened,
    steps,
    files,
    activity,
    sessionId,
    notes: notesOf(task, events),
    halt: haltOf(task, base),
    fail: failOf(task, steps, files, provider, node),
    // Whether a change view has anything to show — the planned write for a
    // permission halt, or the files the run reported changing.
    hasChanges:
      files.length > 0 ||
      (task.status === "needs_you" && task.blockedOn?.type === "permission"),
    resumable: task.execution?.externalSessionId ? true : false
  };
}

export function counts(tasks) {
  const out = { needs: 0, failed: 0, ready: 0, working: 0, done: 0 };
  for (const task of tasks) out[task.state] += 1;
  return out;
}

export function ordered(tasks) {
  return tasks
    .slice()
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.id - a.id);
}

// The whole surface, in one snapshot. Reads through the shared actions and
// the store — never from provider output, never from a second state model.
export async function snapshot(runtime, opts = {}) {
  const now = opts.now ?? Date.now();
  const node = opts.node ?? hostname();
  const tasks = await runtime.actions.listWork();
  const providers = providerMap(runtime.providers);
  const lookup = providerLookup(runtime.providers);
  const projected = [];
  for (const task of tasks) {
    const events = await runtime.store.readEvents(task.slug);
    projected.push(
      projectTask(task, events, { base: runtime.base, providers, lookup, node, now })
    );
  }
  return {
    tasks: ordered(projected),
    counts: counts(projected),
    workspace: deriveWorkspace(runtime.base),
    node,
    providerOrder: (runtime.providers.listProviders?.() ?? []).map(p => p.id),
    providers,
    lookup,
    at: now
  };
}

export function hostname() {
  try {
    return os.hostname() || "this machine";
  } catch {
    return "this machine";
  }
}
