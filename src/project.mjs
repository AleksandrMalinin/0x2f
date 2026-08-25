// Workspace context — the repository-level files Work keeps next to tasks.
//
// This module knows about the workspace (.work/project.md, rules, knowledge,
// decisions) and how prompts are assembled from them. It is provider-neutral:
// a prompt is Work content, not Claude content.

import fs from "node:fs/promises";
import path from "node:path";
import { exists, readText, writeText } from "./core/store.mjs";

const PROJECT_TEMPLATE = `# Project

Describe the project once.

Examples:
- stack / repository layout
- important architectural boundaries
- important product context
- relevant ownership
`;

const RULES_TEMPLATE = `# Working rules

- Investigate before making broad changes.
- Prefer existing patterns.
- Keep changes scoped to the task.
- Avoid unrelated refactors.
- Run relevant tests/checks.
- Cite concrete files and evidence in the final result.
`;

const PROVIDERS_README = `# Configured providers

Drop one JSON file per execution provider here. Each manifest declares a
harness that 0x2F did not ship — an ACP-compatible agent or a headless
command — so adding a new harness needs no source changes:

  {
    "id": "gemini",
    "displayName": "Gemini CLI",
    "transport": "acp",
    "command": ["gemini", "--acp"]
  }

  {
    "id": "my-agent",
    "displayName": "My Agent",
    "transport": "command",
    "command": ["my-agent", "--headless", "{prompt}"]
  }

Rules: id must be unique and lowercase; transport is "acp" or "command";
command is an argv array (never a shell string); the only placeholders are
{prompt} and {workspace}; built-in providers (claude-code, deepseek-harness)
cannot be redefined. For ACP agents, "permissions" ("interactive" default,
"deny" / "approve" for headless auto-resolution) controls how tool permission
requests are handled.
Adding a provider grants 0x2F permission to execute that local command in
this workspace. Treat manifests the way you would treat a script you run:
a manifest whose command is a shell (e.g. ["bash", "-c", "{prompt}"]) or a
repository-relative path executes whatever it is told — 0x2F warns about
those when it loads them, and a REPOSITORY that ships its own
.work/providers/ manifests should be treated as untrusted until you have
read them.
`;

export async function initProject(base = process.cwd()) {
  const wd = path.join(base, ".work");
  await fs.mkdir(path.join(wd, "tasks"), { recursive: true });
  await fs.mkdir(path.join(wd, "providers"), { recursive: true });

  const defaults = [
    ["project.md", PROJECT_TEMPLATE],
    ["rules.md", RULES_TEMPLATE],
    ["knowledge.md", "# Knowledge\n\n"],
    ["decisions.md", "# Decisions\n\n"],
    [path.join("providers", "README.md"), PROVIDERS_README]
  ];

  for (const [name, value] of defaults) {
    const p = path.join(wd, name);
    if (!(await exists(p))) await writeText(p, value);
  }

  return wd;
}

export async function requireProject(base = process.cwd()) {
  if (!(await exists(path.join(base, ".work")))) {
    throw new Error("No .work project found. Run `2f init` first.");
  }
}

export async function buildPrompt(brief, base = process.cwd()) {
  const wd = path.join(base, ".work");

  const [project, rules, knowledge, decisions] = await Promise.all([
    readText(path.join(wd, "project.md")),
    readText(path.join(wd, "rules.md")),
    readText(path.join(wd, "knowledge.md")),
    readText(path.join(wd, "decisions.md"))
  ]);

  return `You are working on one bounded engineering task inside an existing repository.

PROJECT CONTEXT

${project.trim()}

WORKING RULES

${rules.trim()}

KNOWN PROJECT KNOWLEDGE

${knowledge.trim()}

PAST DECISIONS

${decisions.trim()}

TASK

${brief}

INSTRUCTIONS

Work independently and stay tightly scoped to the task.

Before proposing or making broad changes:
1. inspect the relevant implementation;
2. gather concrete evidence;
3. identify the likely root cause or design constraint;
4. prefer the narrowest correct solution.

You may inspect and edit the repository using the tools available to your execution environment.

When finished, return exactly these markdown sections:

## Result
A concise conclusion.

## Evidence
Concrete files, behavior, tests, or other evidence supporting the conclusion.

## Changes
What you changed. Write "None" if this was investigation/review only.

## Verification
Tests/checks performed and their result.

## Needs human decision

This section is a machine-read protocol, not prose. A bare heading, the words
"None", "No decision required", or any other prose is NOT a valid signal and
will be treated as no decision.

Include it only when the task genuinely cannot proceed without a human —
a product, architecture, security, ownership, or scope decision you are not
authorized to make alone.

No human decision is required — write exactly:

  ## Needs human decision
  REQUIRED: no

A genuine human decision is required — write exactly:

  ## Needs human decision
  REQUIRED: yes
  QUESTION: <the concrete question a human must answer>

Use the REQUIRED: yes form only when you truly cannot responsibly finish
without the human's answer.
`;
}

export async function appendProjectKnowledge(kind, text, base = process.cwd()) {
  const file = path.join(base, ".work", `${kind}.md`);
  const existing = await readText(file, `# ${kind}\n\n`);
  const stamp = new Date().toISOString().slice(0, 10);
  await writeText(
    file,
    existing.trimEnd() + `\n\n## ${stamp}\n\n${text.trim()}\n`
  );
}

// --- per-run prompt: Task state -> run input --------------------------------
//
// buildPrompt() assembles the ORIGINAL task request (project context + the
// user's brief) once, when the task is created. That file is the persistent intent
// and is never overwritten. A NEW run, however, must receive the accumulated
// Task state, not just the original prompt:
//
//   original task request   (prompt.md — unchanged)
//   + user input            (task.context.notes — answers, constraints)
//   + previous run context  (prior results, verification, changed files)
//
// buildRunPrompt() projects that state into one self-contained prompt,
// persisted per run as runs/<n>/prompt.md so the exact input a disposable
// provider session received is auditable. It deliberately reuses persisted,
// structured Task data (run records, per-run results, normalized events) —
// never raw provider transcripts.

// The text of one `## Heading` section of a result ("" when absent).
// Results follow the shared prompt's section contract:
// ## Result / ## Evidence / ## Changes / ## Verification / ## Needs human decision.
export function sectionOf(text, heading) {
  const marker = `## ${heading}`;
  const index = text.indexOf(marker);
  if (index < 0) return "";
  const tail = text.slice(index + marker.length);
  const next = tail.search(/\n##\s+/);
  return (next >= 0 ? tail.slice(0, next) : tail).trim();
}

function userInputSection(notes) {
  const lines = notes.map(
    n => `- ${n.at}: ${n.text.replace(/\s+/g, " ").trim()}`
  );
  return (
    `### User input on this task\n\n` +
    `The statements below are the user's constraints and corrections. Treat ` +
    `them as binding on this run, alongside the original task.\n\n` +
    lines.join("\n")
  );
}

// One prior run's context block: meta, result, verification, changed files.
// Uses only persisted data (run records, runs/<n>/result.md, normalized
// file.changed events) — never a transcript.
function priorRunBlock(record, result, changedFiles) {
  const out = [
    `#### Run ${record.run} — ${record.provider} · ${record.outcome ?? "?"}`
  ];
  const bits = [];
  if (record.startedAt) bits.push(`started ${record.startedAt}`);
  if (record.completedAt) bits.push(`completed ${record.completedAt}`);
  if (bits.length) out.push(bits.join(" · "));
  if (record.error) out.push(`Error: ${record.error}`);

  out.push("");
  out.push("Result:");
  out.push(result.trim() || "—");
  out.push("");
  out.push("Verification:");
  out.push(sectionOf(result, "Verification") || "—");
  if (changedFiles.length) {
    out.push("");
    out.push("Files changed:");
    for (const f of changedFiles) out.push(`- ${f}`);
  }
  return out.join("\n");
}

async function priorRunsSection(task, store, excludeRun) {
  const runs = Array.isArray(task.runs) ? task.runs : [];
  const prior = runs.filter(r => r.run !== excludeRun);
  if (!prior.length) return null;

  const events = await store.readEvents(task.slug);
  const blocks = [];
  for (const record of prior) {
    const result = await store.readRunResult(task, record);
    const changedFiles = events
      .filter(e => e.type === "file.changed" && e.run === record.run && e.path)
      .map(e => e.path);
    blocks.push(priorRunBlock(record, result, changedFiles));
  }
  return `### Previous runs\n\n${blocks.join("\n\n")}`;
}

// Build the input for a NEW run from current Task state. `originalPrompt` is
// the task-level prompt.md (the original request); when absent (legacy tasks
// created before prompt files) the task title stands in for it.
export async function buildRunPrompt({ task, base = process.cwd(), originalPrompt, store }) {
  // The persistent intent: task-level prompt.md (the original request). A
  // task without a prompt file falls back to the brief the user wrote —
  // and, for a task created before `brief` existed, to its title (which was
  // the full text back then).
  let original = (originalPrompt ?? "").trim();
  if (!original) {
    original = (
      await readText(path.join(base, ".work", "tasks", task.slug, "prompt.md"), "")
    ).trim();
  }
  if (!original) original = (task.brief ?? task.title ?? "").trim();

  const sections = [];
  const notes = Array.isArray(task.context?.notes) ? task.context.notes : [];
  if (notes.length) sections.push(userInputSection(notes));
  const prior = await priorRunsSection(task, store, task.runs?.at(-1)?.run);
  if (prior) sections.push(prior);

  if (!sections.length) return original; // first run — nothing accumulated yet
  return (
    original +
    "\n\n---\n\n" +
    `## Task state for this run\n\n` +
    `You are continuing an existing task. The original task prompt is above; ` +
    `the Task state that has accumulated since it was written follows.\n\n` +
    sections.join("\n\n")
  );
}
