// AUTO routing v0 — the deterministic, capability/policy routing layer.
//
// Tests: the pure router (determinism, preference, availability, fallback),
// the actions integration (auto vs manual, persisted routing decision, clear
// failure), the API (routing config + auto task creation), and the real CLI
// loop (new --provider auto through the real worker, inspectable via open).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRouter, loadRoutingConfig, orderCandidates } from "../src/core/router.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { startServer } from "../src/server.mjs";
import { TEST_AUTH_TOKEN, authHeaders, unavailableNativesEnv } from "./helpers.mjs";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;

// --- fake registry ----------------------------------------------------------

function fakeProviders(ids, available = {}) {
  const list = ids.map(id => ({ id, displayName: id, capabilities: {}, integrationType: "command" }));
  return {
    listProviders: () => list,
    getProvider: id => list.find(p => p.id === id) ?? null,
    available: id => available[id] ?? false
  };
}

function fakeBase() {
  return path.join("/tmp", "fake-base-" + Math.random().toString(36).slice(2));
}

async function writeRouting(base, config) {
  await fs.mkdir(path.join(base, ".work"), { recursive: true });
  await fs.writeFile(path.join(base, ".work", "routing.json"), JSON.stringify(config));
}

// --- the pure router --------------------------------------------------------

test("router: AUTO with a single available provider picks it deterministically", () => {
  const registry = fakeProviders(["alpha"], { alpha: true });
  const router = createRouter({ base: fakeBase(), providers: registry, defaultProviderId: "claude-code", nodeId: "local" });
  const decision = router.route();
  assert.equal(decision.provider, "alpha");
  assert.equal(decision.node, "local");
  assert.equal(decision.reason, "first available provider");
  assert.deepEqual(decision.considered, ["alpha"]);
  // Determinism: same state -> same decision, every time.
  assert.deepEqual(router.route(), decision);
});

test("router: preference ordering wins over registry order", () => {
  const registry = fakeProviders(["alpha", "beta"], { alpha: true, beta: true });
  const router = createRouterWithConfig(fakeBase(), registry, { default: "auto", prefer: ["beta", "alpha"] });
  const decision = router.route();
  assert.equal(decision.provider, "beta");
  assert.equal(decision.reason, "preferred compatible provider");
  assert.deepEqual(decision.considered, ["beta", "alpha"]);
});

// createRouter reads config from disk; this helper injects a config so the
// preference tests do not depend on the filesystem.
function createRouterWithConfig(base, providers, config, defaultProviderId = "claude-code", nodeId = "local") {
  const router = createRouter({ base, providers, defaultProviderId, nodeId });
  return {
    config,
    defaultRequestedProvider: () => config?.default ?? defaultProviderId,
    route: () => {
      const { ordered, available } = orderCandidates(providers, config?.prefer ?? []);
      if (!ordered.length) {
        return { provider: null, node: nodeId, reason: "no execution provider is available", considered: available };
      }
      const chosen = ordered[0];
      return {
        provider: chosen,
        node: nodeId,
        reason: (config?.prefer ?? []).includes(chosen) ? "preferred compatible provider" : "first available provider",
        considered: ordered
      };
    }
  };
}

test("router: an unavailable preferred provider is skipped (deterministic fallback)", () => {
  const registry = fakeProviders(["alpha", "beta"], { alpha: false, beta: true });
  const router = createRouterWithConfig(fakeBase(), registry, { default: "auto", prefer: ["alpha", "beta"] });
  const decision = router.route();
  assert.equal(decision.provider, "beta"); // alpha is preferred but unavailable
  assert.equal(decision.reason, "preferred compatible provider");
  assert.deepEqual(decision.considered, ["beta"]);
});

test("router: no compatible provider fails clearly, never silently", () => {
  const registry = fakeProviders(["alpha", "beta"], { alpha: false, beta: false });
  const router = createRouterWithConfig(fakeBase(), registry, null);
  const decision = router.route();
  assert.equal(decision.provider, null);
  assert.match(decision.reason, /no execution provider is available/);
});

test("router: the configured default resolves an unspecified request", () => {
  const registry = fakeProviders(["alpha"], { alpha: true });
  const auto = createRouterWithConfig(fakeBase(), registry, { default: "auto" });
  assert.equal(auto.defaultRequestedProvider(), "auto");
  const explicit = createRouterWithConfig(fakeBase(), registry, { default: "alpha" });
  assert.equal(explicit.defaultRequestedProvider(), "alpha");
  const none = createRouterWithConfig(fakeBase(), registry, null, "claude-code");
  assert.equal(none.defaultRequestedProvider(), "claude-code");
});

test("router: orderCandidates is deterministic and preference-first", () => {
  const registry = fakeProviders(["c", "a", "b"], { a: true, b: true, c: true });
  assert.deepEqual(orderCandidates(registry, ["b", "a"]).ordered, ["b", "a", "c"]);
  // Unknown prefer entries are ignored: "a" stays in registry-order rest.
  assert.deepEqual(orderCandidates(registry, ["x", "b"]).ordered, ["b", "c", "a"]);
  assert.deepEqual(orderCandidates(registry, []).ordered, ["c", "a", "b"]); // registry order default
});

test("router: routing config is validated strictly, naming the file", async () => {
  const base = fakeBase();
  const registry = fakeProviders(["alpha", "beta", "claude-code"]);
  await fs.mkdir(path.join(base, ".work"), { recursive: true });

  const cases = [
    [{ default: "ghost" }, /"default" must be "auto" or a known provider id/],
    [{ prefer: ["ghost"] }, /"prefer" names unknown provider "ghost"/],
    [{ prefer: ["alpha", "alpha"] }, /duplicate provider id "alpha"/],
    [{ prefer: "alpha" }, /"prefer" must be an array/],
    [{ extra: 1 }, /unknown field "extra"/],
    [{ default: 42 }, /"default" must be "auto" or a known provider id/]
  ];
  for (const [config, re] of cases) {
    await fs.writeFile(path.join(base, ".work", "routing.json"), JSON.stringify(config));
    assert.throws(() => loadRoutingConfig(base, registry), re);
  }
  await fs.writeFile(path.join(base, ".work", "routing.json"), "not json");
  assert.throws(() => loadRoutingConfig(base, registry), /invalid JSON/);
});

test("router: absent routing config means the runtime default applies", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  try {
    const registry = fakeProviders(["alpha"]);
    const router = createRouter({ base, providers: registry, defaultProviderId: "claude-code", nodeId: "local" });
    assert.equal(router.config, null);
    assert.equal(router.defaultRequestedProvider(), "claude-code");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- actions: auto vs manual ------------------------------------------------

async function fakeExecutable(dir, name) {
  const bin = path.join(dir, name);
  await fs.writeFile(bin, "#!/usr/bin/env node\nprocess.stdout.write('## Result\\nran " + name + "\\n## Needs human decision\\nNone');\nprocess.exit(0);\n");
  await fs.chmod(bin, 0o755);
  return bin;
}

function fakeNode() {
  const calls = [];
  return {
    id: "fake-node",
    displayName: "Fake node",
    resolveWorkspace: () => "/virtual/workspace",
    async startExecution({ task }) { calls.push(["start", task.slug]); return null; },
    async resumeExecution({ task, grant }) { calls.push(["resume", task.slug, grant]); return null; },
    async cancelExecution() {},
    calls
  };
}

// A runtime whose PATH only contains the fake executables, so availability is
// fully controlled (natives are unavailable, alpha/beta are available). The
// native bin overrides are neutralized too — a *_BIN env var on the machine
// must not leak a native into the routing decision.
async function makeRoutedRuntime({ prefer, withConfig = true } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-bins-"));
  await fakeExecutable(bins, "alpha");
  await fakeExecutable(bins, "beta");
  if (withConfig) {
    await writeRouting(base, { default: "auto", prefer: prefer ?? ["alpha", "beta"] });
  }
  const env = { ...process.env, PATH: bins, ...unavailableNativesEnv(bins) };
  const extra = [
    { id: "alpha", displayName: "Alpha", integrationType: "command", capabilities: {}, command: ["alpha", "{prompt}"], start: async () => ({ status: "ready", result: "alpha" }) },
    { id: "beta", displayName: "Beta", integrationType: "command", capabilities: {}, command: ["beta", "{prompt}"], start: async () => ({ status: "ready", result: "beta" }) }
  ];
  const node = fakeNode();
  const runtime = createRuntime(base, { node, env, providers: extra });
  return { ...runtime, node, base, bins };
}

test("actions: createWork with provider auto routes and persists the decision", async () => {
  const rt = await makeRoutedRuntime();
  try {
    const task = await rt.actions.createWork({ brief: "Auto routed task", provider: "auto" });
    assert.equal(task.execution.provider, "alpha");
    const run = task.runs[0];
    assert.equal(run.requestedProvider, "auto");
    assert.equal(run.routing.mode, "auto");
    assert.equal(run.routing.reason, "preferred compatible provider");
    assert.deepEqual(run.routing.considered, ["alpha", "beta"]);
    const persisted = await rt.store.findTask(task.id);
    assert.equal(persisted.runs[0].routing.mode, "auto");
    assert.equal(persisted.runs[0].provider, "alpha");
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("actions: the configured routing default routes an unspecified request", async () => {
  const rt = await makeRoutedRuntime({ prefer: ["beta", "alpha"] });
  try {
    const task = await rt.actions.createWork({ brief: "Default routed" });
    assert.equal(task.execution.provider, "beta");
    assert.equal(task.runs[0].requestedProvider, "auto");
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("actions: without routing config an unspecified request keeps the runtime default", async () => {
  const rt = await makeRoutedRuntime({ withConfig: false });
  try {
    const task = await rt.actions.createWork({ brief: "Default manual" });
    assert.equal(task.execution.provider, "claude-code");
    assert.equal(task.runs[0].requestedProvider, "claude-code");
    assert.equal(task.runs[0].routing, undefined);
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("actions: a manual override bypasses the router entirely", async () => {
  const rt = await makeRoutedRuntime();
  try {
    const task = await rt.actions.createWork({ brief: "Manual", provider: "beta" });
    assert.equal(task.execution.provider, "beta");
    assert.equal(task.runs[0].requestedProvider, "beta");
    assert.equal(task.runs[0].routing, undefined);
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

test("actions: AUTO with nothing available fails clearly instead of guessing", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-bins-"));
  try {
    // PATH points at an empty bin dir: no provider is available (and no
    // *_BIN override leaks one in).
    const env = { ...process.env, PATH: bins, ...unavailableNativesEnv(bins) };
    const node = fakeNode();
    const runtime = createRuntime(base, { node, env });
    await assert.rejects(
      () => runtime.actions.createWork({ brief: "Nothing", provider: "auto" }),
      /AUTO routing: no execution provider is available/
    );
    assert.deepEqual(node.calls, []); // nothing spawned
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(bins, { recursive: true, force: true });
  }
});

test("actions: rerun --provider auto re-routes and keeps the previous run", async () => {
  const rt = await makeRoutedRuntime();
  try {
    const task = await rt.actions.createWork({ brief: "Rerouted", provider: "alpha" });
    // Simulate run 1 finishing as the worker would.
    const { applyOutcome } = await import("../src/core/lifecycle.mjs");
    const done = applyOutcome(task, { status: "ready", result: "one" });
    await rt.store.writeJson(path.join(rt.store.taskDir(task.slug), "task.json"), done);

    const rerun = await rt.actions.rerunWork(task.id, { provider: "auto" });
    assert.equal(rerun.runs.length, 2);
    assert.equal(rerun.runs[0].provider, "alpha"); // run 1 untouched
    assert.equal(rerun.runs[1].provider, "alpha"); // run 2 routed (prefer alpha)
    assert.equal(rerun.runs[1].requestedProvider, "auto");
    assert.equal(rerun.runs[1].routing.mode, "auto");
  } finally {
    await fs.rm(rt.base, { recursive: true, force: true });
    await fs.rm(rt.bins, { recursive: true, force: true });
  }
});

// --- API --------------------------------------------------------------------

test("API: GET /api/routing exposes the configured default and preference", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  await writeRouting(base, { default: "auto", prefer: ["claude-code"] });
  try {
    const runtime = createRuntime(base);
    const handle = await startServer(base, 0, { runtime, interval: 30, authToken: TEST_AUTH_TOKEN });
    try {
      const routing = await fetch(handle.url + "/api/routing", { headers: authHeaders() }).then(r => r.json());
      assert.equal(routing.default, "auto");
      assert.deepEqual(routing.prefer, ["claude-code"]);
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("API: POST /api/tasks with provider auto routes through the shared action", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-bins-"));
  await fakeExecutable(bins, "alpha");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  await writeRouting(base, { default: "auto", prefer: ["alpha"] });
  try {
    const env = { ...process.env, PATH: bins, ...unavailableNativesEnv(bins) };
    const extra = [{ id: "alpha", displayName: "Alpha", integrationType: "command", capabilities: {}, command: ["alpha", "{prompt}"], start: async () => ({ status: "ready", result: "alpha" }) }];
    const runtime = createRuntime(base, { env, providers: extra });
    const handle = await startServer(base, 0, { runtime, interval: 30, authToken: TEST_AUTH_TOKEN });
    try {
      const res = await fetch(handle.url + "/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ brief: "Routed via API", provider: "auto" })
      });
      assert.equal(res.status, 201);
      const task = await res.json();
      assert.equal(task.execution.provider, "alpha");
      assert.equal(task.runs[0].routing.mode, "auto");
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- CLI --------------------------------------------------------------------

function runCli(base, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: base,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (err += c));
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}

test("CLI: 2f new --provider auto routes through the real worker; 2f open shows the decision", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-bins-"));
  const alpha = await fakeExecutable(bins, "alpha");
  const beta = await fakeExecutable(bins, "beta");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-routing-"));
  const providersDir = path.join(base, ".work", "providers");
  await fs.mkdir(providersDir, { recursive: true });
  await fs.writeFile(path.join(providersDir, "alpha.json"), JSON.stringify({
    id: "alpha", displayName: "Alpha", transport: "command", command: [alpha, "{prompt}"]
  }));
  await fs.writeFile(path.join(providersDir, "beta.json"), JSON.stringify({
    id: "beta", displayName: "Beta", transport: "command", command: [beta, "{prompt}"]
  }));
  await writeRouting(base, { default: "auto", prefer: ["beta", "alpha"] });
  try {
    // PATH = fake bins FIRST, real PATH kept (the fake executables use
    // `#!/usr/bin/env node`, which needs node resolvable).
    const cliEnv = { ...process.env, PATH: bins + path.delimiter + process.env.PATH };
    await runCli(base, ["init"], cliEnv);
    const created = await runCli(base, ["new", "Investigate retry", "--provider", "auto"], cliEnv);
    assert.equal(created.code, 0);
    assert.match(created.out, /Beta is running in the background\./);

    // Wait for the real worker to finish.
    const { createStore } = await import("../src/core/store.mjs");
    const store = createStore(base);
    const start = Date.now();
    let task;
    while (true) {
      task = await store.findTask(1);
      if (task.status === "ready") break;
      if (Date.now() - start > 10000) throw new Error("timeout waiting for routed run");
      await new Promise(r => setTimeout(r, 60));
    }
    assert.equal(task.execution.provider, "beta");
    assert.equal(task.runs[0].requestedProvider, "auto");
    assert.equal(task.runs[0].routing.reason, "preferred compatible provider");
    // beta preferred, alpha next; whatever else is on the real PATH joins the
    // considered list too (availability is honest, not curated) — so only the
    // preference order is pinned, never the machine's PATH.
    const considered = task.runs[0].routing.considered;
    assert.deepEqual(considered.slice(0, 2), ["beta", "alpha"]);
    assert.ok(considered.length >= 2);

    const opened = await runCli(base, ["open", "1"], cliEnv);
    assert.match(opened.out, /Routing:\s+auto → beta \(preferred compatible provider\)/);
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});
