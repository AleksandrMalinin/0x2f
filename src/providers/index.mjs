// Provider registry — the only place that knows which execution providers
// exist. Work Core, the worker, and every client consume providers through
// getProvider(); nothing else imports a vendor module directly.
//
// Adding a provider = one file in this directory + one registry line below.
// Providers declare capabilities so Work can refuse flows the runtime can't
// do instead of faking them.

import { claudeCodeProvider } from "./claude-code.mjs";
import { deepseekHarnessProvider } from "./deepseek-harness.mjs";

export const defaultProviderId = "claude-code";

const providers = {
  [claudeCodeProvider.id]: claudeCodeProvider,
  [deepseekHarnessProvider.id]: deepseekHarnessProvider
};

export function getProvider(id) {
  return providers[id] ?? null;
}

export function listProviders() {
  return Object.values(providers);
}
