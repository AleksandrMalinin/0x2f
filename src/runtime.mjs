// Work Runtime — the single composition point for one workspace.
//
//   createRuntime(base) -> {
//     base, store, node, events, actions, workspaceId
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
import { defaultProviderId } from "./providers/index.mjs";

// "local" is the only logical workspace id today. A future trusted-node
// runtime maps other ids to checkouts on the execution machine.
export const WORKSPACE_ID = "local";

export function createRuntime(base = process.cwd(), opts = {}) {
  const store = createStore(base);
  const node = opts.node ?? createLocalNode({ workspace: base });
  const events = createBus();
  const actions = createActions({
    store,
    node,
    events,
    providerId: opts.providerId ?? defaultProviderId,
    workspaceId: WORKSPACE_ID,
    buildPrompt: title => buildPrompt(title, base)
  });
  return { base, store, node, events, actions, workspaceId: WORKSPACE_ID };
}
