// Work Runtime — the single composition point for one workspace.
//
//   createRuntime(base) -> {
//     base, store, node, events, providers, actions, workspaceId
//   }
//
// The CLI, the Web server, and (later) a TUI all build a runtime for the
// workspace they operate on and speak only through `actions` and `events`.
// Surface and execution location stay separate: swapping the node (local ->
// trusted mini-PC) or the provider (claude-code -> codex) changes
// `createRuntime` wiring, not Work Core and not the clients.

import { createStore } from "./core/store.mjs";
import { createActions } from "./core/actions.mjs";
import { createBus } from "./core/events.mjs";
import { createLocalNode } from "./nodes/local.mjs";
import { buildPrompt } from "./project.mjs";
import { createProviderRegistry } from "./providers/index.mjs";
import { createRouter } from "./core/router.mjs";

// "local" is the only logical workspace id today. A future trusted-node
// runtime maps other ids to checkouts on the execution machine.
export const WORKSPACE_ID = "local";

export function createRuntime(base = process.cwd(), opts = {}) {
  const store = createStore(base);
  const node = opts.node ?? createLocalNode({ workspace: base });
  const events = createBus();
  // The provider registry for THIS workspace: native providers plus any
  // manifests under .work/providers/. `opts.providers` is the plugin seam —
  // a future external/native provider package passes its providers here.
  const providers = createProviderRegistry({
    base,
    extra: opts.providers ?? [],
    env: opts.env ?? process.env
  });
  // The AUTO router: deterministic capability/policy routing. Node-aware in
  // its result (provider + node), even though the node is "local" today.
  const router = createRouter({
    base,
    providers,
    defaultProviderId: opts.providerId ?? providers.defaultProviderId,
    nodeId: node.id
  });
  const actions = createActions({
    store,
    node,
    events,
    providers,
    router,
    workspaceId: WORKSPACE_ID,
    buildPrompt: title => buildPrompt(title, base)
  });
  return {
    base,
    store,
    node,
    events,
    providers,
    router,
    actions,
    workspaceId: WORKSPACE_ID
  };
}
