// Provider manifests — declarative configuration that adds an execution
// provider WITHOUT touching 0x2F source code.
//
// Location: <workspace>/.work/providers/<anything>.json — one manifest per
// file, discovered at runtime creation. Local declarative config only: no
// remote manifests, no marketplace, no code loading.
//
// A manifest is strictly validated so misconfiguration fails loudly instead
// of silently misbehaving:
//
//   {
//     "id": "gemini",
//     "displayName": "Gemini CLI",
//     "transport": "acp",                 // "acp" | "command"
//     "command": ["gemini", "--acp"],     // argv array, no shell, no strings
//     "permissions": "deny"               // acp only, optional: deny|approve
//   }
//
// Security properties enforced here and by the providers:
//   - argv arrays only — a command is spawned directly, never via a shell
//   - the only placeholders are {prompt} and {workspace}; anything else is
//     rejected (and no environment-variable interpolation exists at all)
//   - the executable (command[0]) must be a fixed name/path, not a placeholder
//   - manifests are plain JSON — no JavaScript, no code execution
//   - a manifest can never redefine a built-in/native provider

import fsSync from "node:fs";
import path from "node:path";
import { createAcpProvider } from "./acp.mjs";
import { createCommandProvider } from "./command.mjs";

export const KNOWN_PLACEHOLDERS = ["{prompt}", "{workspace}"];

const ALLOWED_FIELDS = new Set(["id", "displayName", "transport", "command", "permissions"]);

// Executables that would pass the task prompt to a shell (spawn argv -> shell
// -> the prompt as a script). A manifest like ["bash", "-c", "{prompt}"] is
// arbitrary command execution whenever a task runs with that provider.
const SHELL_EXECS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish",
  "cmd", "powershell", "pwsh", "wsl", "busybox"
]);

// A human warning for manifests whose executable is unusually powerful:
// a shell, or a repository-relative path (a repo that ships this manifest
// controls what runs). Returns null for ordinary manifests. Emitted at load
// so a repository-provided manifest cannot configure itself silently.
export function providerTrustWarning(manifest) {
  const exe = typeof manifest?.command?.[0] === "string" ? manifest.command[0] : "";
  if (!exe) return null;
  const base = exe.split(/[\\/]/).pop() ?? exe;
  if (SHELL_EXECS.has(base.toLowerCase())) {
    return `Provider "${manifest.id}" invokes a shell (${exe}): the task prompt is passed to the shell as a script. A manifest like this is equivalent to arbitrary command execution whenever a task runs with it — only configure it if you fully trust its source.`;
  }
  if (/^\.{1,2}[\\/]/.test(exe)) {
    return `Provider "${manifest.id}" runs a repository-relative executable (${exe}). A repository that ships this manifest controls what runs when a task uses it — treat it as untrusted unless you wrote it yourself.`;
  }
  return null;
}

// Load and validate every manifest under <base>/.work/providers/. Throws on
// the first invalid manifest, pointing at the file. Returns an array of
// provider instances (acp or command) in filename order.
export function loadManifestProviders(base, { nativeIds = [] } = {}) {
  const dir = path.join(base, ".work", "providers");
  let entries;
  try {
    entries = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no providers directory — nothing configured
  }

  const files = entries
    .filter(e => e.isFile() && e.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const providers = [];
  const seen = new Set();
  for (const entry of files) {
    const file = path.join(dir, entry.name);
    let raw;
    try {
      raw = JSON.parse(fsSync.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(
        `Provider manifest ${entry.name}: invalid JSON — ${error.message}`
      );
    }
    const manifest = validateManifest(raw, entry.name, { nativeIds });
    if (seen.has(manifest.id)) {
      throw new Error(
        `Provider manifest ${entry.name}: duplicate provider id "${manifest.id}".`
      );
    }
    seen.add(manifest.id);
    const warning = providerTrustWarning(manifest);
    if (warning) console.warn(`0x2F: ${warning}`);
    providers.push(
      manifest.transport === "acp"
        ? createAcpProvider(manifest)
        : createCommandProvider(manifest)
    );
  }
  return providers;
}

// Validate one parsed manifest object. Throws a clear Error naming the file.
export function validateManifest(raw, file, { nativeIds = [] } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Provider manifest ${file}: expected a JSON object.`);
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`Provider manifest ${file}: unknown field "${key}".`);
    }
  }

  const { id, displayName, transport, command } = raw;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `Provider manifest ${file}: "id" must be lowercase alphanumeric with dashes (got ${JSON.stringify(id)}).`
    );
  }
  if (nativeIds.includes(id)) {
    throw new Error(
      `Provider manifest ${file}: "${id}" is a built-in provider and cannot be redefined by a manifest.`
    );
  }
  if (typeof displayName !== "string" || !displayName.trim()) {
    throw new Error(`Provider manifest ${file}: "displayName" is required.`);
  }
  if (transport !== "acp" && transport !== "command") {
    throw new Error(
      `Provider manifest ${file}: "transport" must be "acp" or "command" (got ${JSON.stringify(transport)}).`
    );
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(a => typeof a !== "string" || a.trim() === "")
  ) {
    throw new Error(
      `Provider manifest ${file}: "command" must be a non-empty array of non-empty strings.`
    );
  }
  if (command[0].includes("{")) {
    throw new Error(
      `Provider manifest ${file}: the executable (command[0]) must be a fixed program name or path, not a placeholder.`
    );
  }

  // Known placeholders only — {prompt} and {workspace}. No templating language.
  const joined = command.join("\n");
  const placeholders = [...new Set(joined.match(/\{[a-zA-Z0-9_-]+\}/g) ?? [])];
  const unknown = placeholders.filter(p => !KNOWN_PLACEHOLDERS.includes(p));
  if (unknown.length) {
    throw new Error(
      `Provider manifest ${file}: unknown placeholder(s) ${unknown.join(", ")}. Supported: ${KNOWN_PLACEHOLDERS.join(", ")}.`
    );
  }

  // A command provider that never receives the prompt cannot do any work.
  if (transport === "command" && !joined.includes("{prompt}")) {
    throw new Error(
      `Provider manifest ${file}: a command provider must pass the task to the harness via the {prompt} placeholder.`
    );
  }

  const { permissions } = raw;
  if (
    permissions !== undefined &&
    permissions !== "interactive" &&
    permissions !== "deny" &&
    permissions !== "approve"
  ) {
    throw new Error(
      `Provider manifest ${file}: "permissions" must be "interactive", "deny" or "approve" (got ${JSON.stringify(permissions)}).`
    );
  }
  if (permissions !== undefined && transport !== "acp") {
    throw new Error(
      `Provider manifest ${file}: "permissions" applies to acp transport only.`
    );
  }

  return {
    id,
    displayName,
    transport,
    command,
    ...(permissions ? { permissions } : {})
  };
}

// Substitute the manifest's placeholders with run-time values. Only reachable
// with validated manifests, so {prompt}/{workspace} are the only tokens.
export function substituteCommand(argv, { prompt, workspace }) {
  return argv.map(arg =>
    arg.replaceAll("{prompt}", prompt).replaceAll("{workspace}", workspace)
  );
}
