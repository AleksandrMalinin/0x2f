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
cannot be redefined. For ACP agents, "permissions" ("deny" default,
"approve" opt-in) controls how tool permission requests are auto-resolved.
Adding a provider grants 0x2F permission to execute that local command in
this workspace.
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

export async function buildPrompt(task, base = process.cwd()) {
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

${task}

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
Write "None" unless there is a genuine product, architecture, security, ownership, or scope decision that cannot responsibly be made without a human.
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
