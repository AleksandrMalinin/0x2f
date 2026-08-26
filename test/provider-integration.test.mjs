// Integration: configured providers (ACP + command manifests) flow through
// the same surfaces as native providers — the API listing, the CLI, and the
// real worker (which builds its own registry from the workspace). This is the
// proof that "a new harness = a manifest, nothing else".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { createStore } from "../src/core/store.mjs";
import { TEST_AUTH_TOKEN, authHeaders } from "./helpers.mjs";

const CLI = new URL("../src/cli.mjs", import.meta.url).pathname;

// --- fixtures ---------------------------------------------------------------

// A tiny headless command agent: completes without echoing the prompt back
// (the prompt itself contains a `## Needs human decision` section, so echoing
// it would trip the shared decision convention — a real harness hazard).
async function fakeCommandAgent(dir) {
  const bin = path.join(dir, "hello-agent");
  await fs.writeFile(
    bin,
    "#!/usr/bin/env node\n" +
      "process.stdout.write(\"## Result\\nHandled by hello-agent\\n## Verification\\nran\\n## Needs human decision\\nNone\");\n" +
      "process.exit(0);\n"
  );
  await fs.chmod(bin, 0o755);
  return bin;
}

// A fake ACP agent (same script shape as the acp-provider tests, inline here
// so the integration test is self-contained).
const FAKE_ACP = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const logPath = process.env.FAKE_ACP_LOG;
const logLine = obj => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(obj) + "\\n"); };
const send = obj => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-acp", title: "Fake ACP" }, authMethods: [] } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-integration" } });
    return;
  }
  if (msg.method === "session/prompt") {
    // Do NOT echo the prompt text into the result: the prompt itself carries
    // a "## Needs human decision" section that would trip the shared Work
    // decision convention.
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-integration", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "## Result\\nHandled by fake-acp\\n## Needs human decision\\nNone" } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
});
`;

async function writeFakeAcpAgent(dir) {
  const bin = path.join(dir, "fake-acp-agent.mjs");
  await fs.writeFile(bin, FAKE_ACP);
  await fs.chmod(bin, 0o755);
  return bin;
}

async function makeProject(manifests) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-integration-"));
  const dir = path.join(base, ".work", "providers");
  await fs.mkdir(dir, { recursive: true });
  for (const [name, manifest] of Object.entries(manifests)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(manifest, null, 2));
  }
  return base;
}

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

async function waitForStatus(base, id, expected, opts = {}) {
  const store = createStore(base);
  const { timeout = 10000, tolerate = [] } = opts;
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    const task = await store.findTask(id);
    if (task.status === expected) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task went ${task.status} instead of ${expected}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for task " + id);
    await new Promise(r => setTimeout(r, 60));
  }
}

// --- API --------------------------------------------------------------------

test("API: configured providers appear in /api/providers with their integration type", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-int-bins-"));
  const agent = await fakeCommandAgent(bins);
  const base = await makeProject({
    "hello.json": {
      id: "hello",
      displayName: "Hello Agent",
      transport: "command",
      command: [agent, "--task", "{prompt}"]
    }
  });
  try {
    const runtime = createRuntime(base);
    const handle = await startServer(base, 0, { runtime, interval: 30, authToken: TEST_AUTH_TOKEN });
    try {
      const providers = await fetch(handle.url + "/api/providers", { headers: authHeaders() }).then(r => r.json());
      assert.deepEqual(
        providers.map(p => p.id),
        ["claude-code", "codex", "deepseek-harness", "hello"]
      );
      const hello = providers.find(p => p.id === "hello");
      assert.equal(hello.displayName, "Hello Agent");
      assert.equal(hello.integrationType, "command");
      assert.equal(hello.available, true);
      assert.equal(hello.capabilities.supportsStructuredEvents, false);
      // Natives keep their descriptor too.
      assert.equal(providers[0].integrationType, "native");
      assert.equal(typeof providers[0].available, "boolean");
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- CLI --------------------------------------------------------------------

test("CLI: `2f providers` lists natives and configured providers with availability", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-int-bins-"));
  const agent = await fakeCommandAgent(bins);
  const base = await makeProject({
    "hello.json": {
      id: "hello",
      displayName: "Hello Agent",
      transport: "command",
      command: [agent, "--task", "{prompt}"]
    },
    "ghost.json": {
      id: "ghost",
      displayName: "Ghost Agent",
      transport: "command",
      command: ["definitely-not-installed-xyz", "{prompt}"]
    }
  });
  try {
    await runCli(base, ["init"]);
    const res = await runCli(base, ["providers"]);
    assert.equal(res.code, 0);
    assert.match(res.out, /PROVIDER\s+INTEGRATION\s+AVAILABLE/);
    assert.match(res.out, /claude-code\s+native\s+(yes|no)/);
    assert.match(res.out, /codex\s+native\s+(yes|no)/);
    assert.match(res.out, /deepseek-harness\s+native\s+(yes|no)/);
    assert.match(res.out, /hello\s+command\s+yes/);
    assert.match(res.out, /ghost\s+command\s+no/);
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- real worker, end to end ------------------------------------------------

test("E2E: a configured command provider runs the task through the real worker", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-int-bins-"));
  const agent = await fakeCommandAgent(bins);
  const base = await makeProject({
    "hello.json": {
      id: "hello",
      displayName: "Hello Agent",
      transport: "command",
      command: [agent, "--task", "{prompt}"]
    }
  });
  try {
    await runCli(base, ["init"]);
    const created = await runCli(base, ["new", "Investigate the retry window", "--provider", "hello"]);
    assert.equal(created.code, 0);
    assert.match(created.out, /Hello Agent is running in the background\./);

    const task = await waitForStatus(base, 1, "ready");
    assert.equal(task.runs[0].provider, "hello");
    assert.equal(task.runs[0].outcome, "ready");
    const result = await fs.readFile(
      path.join(task.slug.replace(/^/, base + "/.work/tasks/"), "result.md"),
      "utf8"
    );
    assert.match(result, /Handled by hello-agent/);

    const opened = await runCli(base, ["open", "1"]);
    // The RUNS strip shows the provider id; the display name is on `2f providers`.
    assert.match(opened.out, /hello\s+\S+\s+READY/);
    assert.match(opened.out, /Handled by hello-agent/);
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("E2E: a configured ACP provider runs the task through the real worker and persists the session id", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-int-bins-"));
  const acpAgent = await writeFakeAcpAgent(bins);
  const base = await makeProject({
    "acp-agent.json": {
      id: "acp-agent",
      displayName: "ACP Agent",
      transport: "acp",
      command: [acpAgent, "--acp"]
    }
  });
  try {
    await runCli(base, ["init"]);
    const created = await runCli(base, ["new", "Compare the retry window", "--provider", "acp-agent"]);
    assert.equal(created.code, 0);
    assert.match(created.out, /ACP Agent is running in the background\./);

    const task = await waitForStatus(base, 1, "ready");
    assert.equal(task.runs[0].provider, "acp-agent");
    assert.equal(task.runs[0].outcome, "ready");
    // The ACP session id persists as the run's external session id.
    assert.equal(task.runs[0].externalSessionId, "sess-integration");
    assert.equal(task.execution.externalSessionId, "sess-integration");

    const opened = await runCli(base, ["open", "1", "--run", "1"]);
    assert.match(opened.out, /ACP Agent/);
    assert.match(opened.out, /sess-integration/);
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("E2E: native + ACP + command providers coexist in one workspace", async () => {
  const bins = await fs.mkdtemp(path.join(os.tmpdir(), "work-int-bins-"));
  const agent = await fakeCommandAgent(bins);
  const acpAgent = await writeFakeAcpAgent(bins);
  const base = await makeProject({
    "hello.json": {
      id: "hello",
      displayName: "Hello Agent",
      transport: "command",
      command: [agent, "--task", "{prompt}"]
    },
    "acp-agent.json": {
      id: "acp-agent",
      displayName: "ACP Agent",
      transport: "acp",
      command: [acpAgent, "--acp"]
    }
  });
  try {
    const runtime = createRuntime(base);
    // Three integration types in one registry; the default stays native.
    // Configured providers appear in filename order (acp-agent.json sorts
    // before hello.json).
    assert.deepEqual(
      runtime.providers.listProviders().map(p => p.integrationType),
      ["native", "native", "native", "acp", "command"]
    );
    assert.equal(runtime.providers.defaultProviderId, "claude-code");
    const ids = runtime.providers.listProviders().map(p => p.id);
    for (const id of ["claude-code", "codex", "deepseek-harness", "hello", "acp-agent"]) {
      assert.ok(ids.includes(id), `${id} present`);
    }
  } finally {
    await fs.rm(bins, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});
