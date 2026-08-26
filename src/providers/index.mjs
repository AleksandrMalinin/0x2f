// Provider registry — the single place that knows which execution providers
// exist. It now holds three integration types behind ONE contract:
//
//   Native    claude-code, codex, deepseek-harness, gemini   (deep provider adapters)
//   ACP       any agent exposing the Agent Client Protocol (manifests)
//   Command   any headless executable                (manifests)
//
// Work Core, the worker, and every client consume providers through a
// registry's getProvider(); nothing else imports a vendor module directly.
// A configured provider (manifest) is indistinguishable from a native one
// except for its `integrationType` descriptor — the rest of 0x2F does not
// care which integration type created a provider.
//
// Provider contract (unchanged):
//
//   { id, displayName, integrationType, capabilities, command?,
//     async start({ cwd, prompt, onEvent })       -> normalized outcome
//     async resume({ cwd, externalSessionId, grant, onEvent })  // if supportsResume
//     cancel?() }                                   // best-effort stop
//
// Registry seam: `register(provider)` (or createProviderRegistry's `extra`)
// lets a future external/native provider package add a provider without
// touching Work Core. No plugin loading, no discovery, no remote code.

import fsSync from "node:fs";
import path from "node:path";
import { claudeCodeProvider } from "./claude-code.mjs";
import { codexProvider } from "./codex.mjs";
import { deepseekHarnessProvider } from "./deepseek-harness.mjs";
import { geminiProvider } from "./gemini.mjs";
import { loadManifestProviders } from "./manifests.mjs";

export const defaultProviderId = "claude-code";

// Native providers are singletons; integrationType is a registry descriptor.
for (const provider of [claudeCodeProvider, codexProvider, deepseekHarnessProvider, geminiProvider]) {
  provider.integrationType ??= "native";
}

const NATIVE_PROVIDERS = {
  [claudeCodeProvider.id]: claudeCodeProvider,
  [codexProvider.id]: codexProvider,
  [deepseekHarnessProvider.id]: deepseekHarnessProvider,
  [geminiProvider.id]: geminiProvider
};

// Deterministic, cheap availability: resolve the executable WITHOUT spawning
// it. Absolute/relative paths are checked directly; bare names are resolved
// against PATH. Sync and cheap (a handful of access(2) calls).
export function executableAvailable(name, env = process.env) {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) {
    try {
      fsSync.accessSync(name, fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    try {
      fsSync.accessSync(path.join(dir, name), fsSync.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

// Which executable a native provider runs — its own env override, then PATH.
// The override is read from the SAME env the availability check resolves
// against (the registry's injected env, defaulting to process.env), never
// from the ambient process.env alone — a controlled test env must be able to
// pin a native's executable deterministically.
function nativeExecutable(provider, env) {
  const e = env ?? process.env;
  if (provider.id === "claude-code") return e.CLAUDE_BIN || "claude";
  if (provider.id === "codex") return e.CODEX_BIN || "codex";
  if (provider.id === "deepseek-harness") return e.DSH_BIN || "dsh";
  if (provider.id === "gemini") return e.GEMINI_BIN || "gemini";
  return null;
}

// Which executable a provider would run, for diagnostics. Native providers
// resolve their binary; configured (ACP/command) providers run command[0].
export function providerExecutable(provider, env = process.env) {
  if (!provider) return null;
  if (provider.integrationType === "native") return nativeExecutable(provider, env);
  return provider.command?.[0] ?? null;
}

// The user-facing refusal for a provider that exists but cannot run on this
// machine right now. One message shape for every surface: the action boundary
// (explicit manual selections) and the CLI's `2f new` preflight (the
// configured/runtime default on first use) print the same "install or
// configure X, then retry." so a refusal is never development-shaped.
export function unavailableMessage(id, providers) {
  const provider = providers.getProvider(id);
  const display = provider?.displayName ?? id;
  const executable = providers.executable(id);
  return [
    `Execution provider "${id}" is unavailable on this machine.`,
    executable ? `Expected executable: ${executable}` : "",
    `Install or configure ${display}, then retry.`
  ].filter(Boolean).join("\n");
}

// Build the registry for one workspace. Loads manifests from
// <base>/.work/providers/ (throwing loudly on invalid configuration),
// then merges any `extra` providers (the plugin seam).
export function createProviderRegistry({ base = process.cwd(), extra = [], env = process.env } = {}) {
  const providers = { ...NATIVE_PROVIDERS };

  for (const provider of loadManifestProviders(base, {
    nativeIds: Object.keys(NATIVE_PROVIDERS)
  })) {
    if (providers[provider.id]) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    providers[provider.id] = provider;
  }
  for (const provider of extra) {
    if (!provider || typeof provider.id !== "string") {
      throw new Error("Extra providers must be provider objects with an id.");
    }
    if (providers[provider.id]) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    provider.integrationType ??= "native";
    providers[provider.id] = provider;
  }

  return {
    getProvider(id) {
      return providers[id] ?? null;
    },
    listProviders() {
      return Object.values(providers);
    },
    // Registry seam for future native/external provider packages.
    register(provider) {
      if (!provider || typeof provider.id !== "string") {
        throw new Error("register() requires a provider object with an id.");
      }
      if (providers[provider.id]) {
        throw new Error(`Provider "${provider.id}" is already registered.`);
      }
      provider.integrationType ??= "native";
      providers[provider.id] = provider;
    },
    // Whether the provider's executable can be resolved — the only
    // availability signal: configured provider's command[0] or the native
    // provider's binary. Never spawns. Uses the registry's own map directly
    // (not the module-level legacy getProvider, which only knows natives).
    available(id) {
      return executableAvailable(providerExecutable(providers[id], env), env);
    },
    // The executable a provider would run, for user-facing diagnostics
    // ("Expected executable: dsh"). Null when unknown.
    executable(id) {
      return providerExecutable(providers[id], env);
    },
    defaultProviderId
  };
}

// Legacy module-level view: NATIVE providers only (pre-manifest behavior).
// New code should use createProviderRegistry() so configured providers are
// visible; these are kept for backward compatibility.
export function getProvider(id) {
  return NATIVE_PROVIDERS[id] ?? null;
}

export function listProviders() {
  return Object.values(NATIVE_PROVIDERS);
}
