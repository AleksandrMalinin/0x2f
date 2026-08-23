// Provider manifests + registry — declarative configuration that adds ACP or
// command providers without source changes, and the single registry that
// holds native + configured providers behind one contract.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateManifest, loadManifestProviders } from "../src/providers/manifests.mjs";
import { createProviderRegistry, executableAvailable } from "../src/providers/index.mjs";

const ACP_MANIFEST = {
  id: "gemini",
  displayName: "Gemini CLI",
  transport: "acp",
  command: ["gemini", "--acp"]
};
const CMD_MANIFEST = {
  id: "my-agent",
  displayName: "My Agent",
  transport: "command",
  command: ["my-agent", "--headless", "{prompt}"]
};

async function makeBase(manifests = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-manifests-"));
  const dir = path.join(base, ".work", "providers");
  if (Object.keys(manifests).length) {
    await fs.mkdir(dir, { recursive: true });
    for (const [name, manifest] of Object.entries(manifests)) {
      await fs.writeFile(path.join(dir, name), JSON.stringify(manifest, null, 2));
    }
  }
  return base;
}

// --- manifest validation ----------------------------------------------------

test("manifests: a valid ACP manifest and a valid command manifest", () => {
  const acp = validateManifest(ACP_MANIFEST, "gemini.json");
  assert.equal(acp.transport, "acp");
  const cmd = validateManifest(CMD_MANIFEST, "my-agent.json");
  assert.equal(cmd.transport, "command");
});

test("manifests: every failure mode fails loudly, naming the file", () => {
  const cases = [
    ["not an object", [], /expected a JSON object/],
    ["unknown field", { ...ACP_MANIFEST, extra: 1 }, /unknown field "extra"/],
    ["bad id", { ...ACP_MANIFEST, id: "Gemini CLI" }, /lowercase alphanumeric/],
    ["empty id", { ...ACP_MANIFEST, id: "" }, /lowercase alphanumeric/],
    ["missing displayName", { ...ACP_MANIFEST, displayName: "  " }, /"displayName" is required/],
    ["bad transport", { ...ACP_MANIFEST, transport: "mcp" }, /"transport" must be "acp" or "command"/],
    ["command is a string", { ...CMD_MANIFEST, command: "my-agent {prompt}" }, /non-empty array of non-empty strings/],
    ["empty command", { ...CMD_MANIFEST, command: [] }, /non-empty array of non-empty strings/],
    ["non-string argv", { ...CMD_MANIFEST, command: ["my-agent", 42] }, /non-empty array of non-empty strings/],
    ["placeholder executable", { ...CMD_MANIFEST, command: ["{prompt}"] }, /executable .* must be a fixed program name or path/],
    ["unknown placeholder", { ...CMD_MANIFEST, command: ["my-agent", "{prompt}", "{model}"] }, /unknown placeholder\(s\) \{model\}/],
    ["command without {prompt}", { ...CMD_MANIFEST, command: ["my-agent", "--workspace", "{workspace}"] }, /must pass the task .* \{prompt\} placeholder/],
    ["bad permissions", { ...ACP_MANIFEST, permissions: "maybe" }, /"permissions" must be "interactive", "deny" or "approve"/],
    ["permissions on command", { ...CMD_MANIFEST, permissions: "deny" }, /applies to acp transport only/]
  ];
  for (const [label, manifest, re] of cases) {
    assert.throws(() => validateManifest(manifest, "bad.json"), re, label);
  }
});

test("manifests: a manifest cannot shadow a built-in provider", () => {
  const nativeIds = ["claude-code", "deepseek-harness"];
  assert.throws(
    () => validateManifest({ ...CMD_MANIFEST, id: "claude-code" }, "x.json", { nativeIds }),
    /built-in provider and cannot be redefined/
  );
  assert.throws(
    () => validateManifest({ ...CMD_MANIFEST, id: "deepseek-harness" }, "x.json", { nativeIds }),
    /built-in provider/
  );
});

test("loadManifestProviders: no providers dir means nothing configured", async () => {
  const base = await makeBase();
  try {
    assert.deepEqual(loadManifestProviders(base), []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("loadManifestProviders: builds acp + command providers from files; duplicate ids fail", async () => {
  const base = await makeBase({
    "a-gemini.json": ACP_MANIFEST,
    "b-my-agent.json": CMD_MANIFEST
  });
  try {
    const providers = loadManifestProviders(base, { nativeIds: ["claude-code", "deepseek-harness"] });
    assert.deepEqual(providers.map(p => p.id), ["gemini", "my-agent"]);
    assert.equal(providers[0].integrationType, "acp");
    assert.equal(providers[1].integrationType, "command");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }

  const dup = await makeBase({
    "one.json": { ...ACP_MANIFEST, id: "dup" },
    "two.json": { ...CMD_MANIFEST, id: "dup" }
  });
  try {
    assert.throws(() => loadManifestProviders(dup, { nativeIds: [] }), /duplicate provider id "dup"/);
  } finally {
    await fs.rm(dup, { recursive: true, force: true });
  }
});

test("loadManifestProviders: invalid JSON fails clearly", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-manifests-"));
  await fs.mkdir(path.join(base, ".work", "providers"), { recursive: true });
  // Write raw broken text — not a JSON-encoded string.
  await fs.writeFile(path.join(base, ".work", "providers", "broken.json"), "{ not json");
  try {
    assert.throws(() => loadManifestProviders(base), /invalid JSON/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// --- the registry -----------------------------------------------------------

test("registry: native + configured providers coexist behind one contract", async () => {
  const base = await makeBase({
    "gemini.json": ACP_MANIFEST,
    "my-agent.json": CMD_MANIFEST
  });
  try {
    const registry = createProviderRegistry({ base });
    const ids = registry.listProviders().map(p => p.id);
    assert.deepEqual(ids, ["claude-code", "deepseek-harness", "gemini", "my-agent"]);

    // The rest of 0x2F cannot tell which integration type created a provider.
    const gemini = registry.getProvider("gemini");
    assert.equal(gemini.displayName, "Gemini CLI");
    assert.equal(gemini.integrationType, "acp");
    assert.equal(gemini.capabilities.supportsResume, true);
    assert.equal(typeof gemini.start, "function");
    assert.equal(typeof gemini.resume, "function");
    assert.equal(typeof gemini.cancel, "function");

    const agent = registry.getProvider("my-agent");
    assert.equal(agent.integrationType, "command");
    assert.equal(agent.capabilities.supportsStructuredEvents, false);
    assert.equal(agent.resume, undefined);

    // Natives are unchanged, now tagged with their integration type.
    assert.equal(registry.getProvider("claude-code").integrationType, "native");
    assert.equal(registry.getProvider("deepseek-harness").integrationType, "native");
    assert.equal(registry.getProvider("nope"), null);
    assert.equal(registry.defaultProviderId, "claude-code");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("registry: a manifest error fails runtime creation loudly (never silent)", async () => {
  const base = await makeBase({ "bad.json": { ...CMD_MANIFEST, transport: "mcp" } });
  try {
    assert.throws(() => createProviderRegistry({ base }), /"transport" must be "acp" or "command"/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("registry: availability resolves the configured executable deterministically", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-bin-"));
  const fake = path.join(binDir, "my-agent");
  await fs.writeFile(fake, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await fs.chmod(fake, 0o755);

  const base = await makeBase({
    "present.json": { ...CMD_MANIFEST, id: "present", command: [fake, "{prompt}"] },
    "absent.json": { ...CMD_MANIFEST, id: "absent", command: ["definitely-not-installed-xyz", "{prompt}"] }
  });
  try {
    const registry = createProviderRegistry({ base });
    assert.equal(registry.available("present"), true);
    assert.equal(registry.available("absent"), false);
    assert.equal(registry.available("unknown"), false);
    // Native availability uses the provider's own binary + env override.
    assert.equal(typeof registry.available("claude-code"), "boolean");
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("registry: the register() seam adds providers and refuses duplicates", async () => {
  const base = await makeBase();
  try {
    const registry = createProviderRegistry({ base });
    const before = registry.listProviders().length;
    registry.register({ id: "plugin", displayName: "Plugin", integrationType: "native", capabilities: {}, start: async () => ({ status: "failed", error: "stub" }) });
    assert.equal(registry.listProviders().length, before + 1);
    assert.equal(registry.getProvider("plugin").displayName, "Plugin");
    assert.throws(() => registry.register({ id: "plugin" }), /already registered/);
    assert.throws(() => registry.register({ id: "claude-code" }), /already registered/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("executableAvailable: PATH resolution and absolute paths, cheap and sync", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-bin-"));
  const tool = path.join(binDir, "tool");
  await fs.writeFile(tool, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await fs.chmod(tool, 0o755);
  try {
    assert.equal(executableAvailable("tool", { PATH: binDir }), true);
    assert.equal(executableAvailable("tool", { PATH: "/usr/bin:/bin" }), false);
    assert.equal(executableAvailable(tool, { PATH: "/usr/bin" }), true);
    assert.equal(executableAvailable(path.join(binDir, "missing"), { PATH: "/usr/bin" }), false);
    assert.equal(executableAvailable("", { PATH: binDir }), false);
    // A non-executable file is not "available".
    const plain = path.join(binDir, "plain.txt");
    await fs.writeFile(plain, "x");
    assert.equal(executableAvailable(plain, { PATH: "/usr/bin" }), false);
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});
