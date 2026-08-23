// Work Router — AUTO v0: a deliberately small, deterministic routing layer.
//
// The product hypothesis: "I give 0x2F work; 0x2F figures out how to run it."
// AUTO v0 is NOT an AI router, not scoring, not learning, not benchmarking,
// not cost optimization, and not multi-agent orchestration. It selects an
// execution target from facts 0x2F genuinely knows:
//
//   - provider availability (the executable can be resolved)
//   - explicit project routing configuration (.work/routing.json)
//   - the current execution node
//
// It does NOT infer task semantics from natural language in v0, and it never
// claims a provider is "best" — only that it is available, compatible, and
// preferred per explicit policy.
//
// The important property: same state + same policy -> same routing decision.
// No hidden randomness, no automatic failover (a routed run that fails is
// FAILED, not secretly retried on another agent).
//
// Routing is NOT a provider concern and NOT a node concern. The router picks
// an execution target (provider + node + reason); the provider executes it;
// the node determines where. The decision is persisted with the run so
// "why did 0x2F run this here?" can be answered from the record, not
// reconstructed from current configuration.
//
// Configuration (.work/routing.json):
//
//   {
//     "default": "auto",                 // "auto" or a provider id
//     "prefer": ["claude-code", "deepseek-harness"]
//   }
//
// `default` is what an unspecified provider request resolves to; `prefer`
// orders compatible providers. Both are validated strictly.

import fsSync from "node:fs";
import path from "node:path";

export const AUTO = "auto";

const ROUTING_CONFIG_PATH = ".work/routing.json";

// Deterministic order for `considered` and selection:
// prefer-list first (in order), then the remaining providers in registry
// order. Only AVAILABLE providers are candidates.
export function orderCandidates(providers, prefer = []) {
  const available = providers
    .listProviders()
    .filter(p => providers.available(p.id))
    .map(p => p.id);
  const preferred = prefer.filter(id => available.includes(id));
  const rest = available.filter(id => !prefer.includes(id));
  return { ordered: [...preferred, ...rest], available };
}

// Read and validate .work/routing.json. Returns null when the file is absent
// (the runtime default provider applies). Throws loudly on malformed config.
export function loadRoutingConfig(base, providers) {
  const file = path.join(base, ROUTING_CONFIG_PATH);
  let raw;
  try {
    raw = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Routing config ${file}: invalid JSON — ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Routing config ${file}: expected a JSON object.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "default" && key !== "prefer") {
      throw new Error(`Routing config ${file}: unknown field "${key}".`);
    }
  }
  const { default: def, prefer = [] } = raw;
  if (def !== undefined && def !== "auto" && !providers.getProvider(def)) {
    throw new Error(
      `Routing config ${file}: "default" must be "auto" or a known provider id (got ${JSON.stringify(def)}).`
    );
  }
  if (!Array.isArray(prefer) || prefer.some(p => typeof p !== "string" || !p)) {
    throw new Error(`Routing config ${file}: "prefer" must be an array of provider ids.`);
  }
  const seen = new Set();
  for (const id of prefer) {
    if (seen.has(id)) {
      throw new Error(`Routing config ${file}: duplicate provider id "${id}" in "prefer".`);
    }
    seen.add(id);
    if (!providers.getProvider(id)) {
      throw new Error(
        `Routing config ${file}: "prefer" names unknown provider "${id}".`
      );
    }
  }
  return { default: def ?? null, prefer };
}

// createRouter({ base, providers, defaultProviderId, nodeId }) -> router
//
//   router.defaultRequestedProvider() -> "auto" | provider id
//       what an unspecified provider request resolves to (config default, or
//       the runtime default provider when no routing config exists)
//
//   router.route() -> { provider, node, reason, considered } | { provider: null, reason }
//       the deterministic AUTO decision
export function createRouter({ base, providers, defaultProviderId, nodeId }) {
  const config = loadRoutingConfig(base, providers);

  return {
    config,
    defaultRequestedProvider() {
      return config?.default ?? defaultProviderId;
    },
    route() {
      const { ordered, available } = orderCandidates(providers, config?.prefer ?? []);
      if (!ordered.length) {
        return {
          provider: null,
          node: nodeId,
          reason: available.length
            ? "no compatible provider available"
            : "no execution provider is available",
          considered: available
        };
      }
      const chosen = ordered[0];
      return {
        provider: chosen,
        node: nodeId,
        reason: (config?.prefer ?? []).includes(chosen)
          ? "preferred compatible provider"
          : "first available provider",
        considered: ordered
      };
    }
  };
}
