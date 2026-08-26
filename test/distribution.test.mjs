// Packaged first-install regression — the REAL distribution path, end to end.
//
// This test packs the actual npm artifact, installs it into a temp global
// prefix exactly as a first-time user would (`npm install -g <tgz>`), and
// runs the whole journey against the INSTALLED CLI — never the checkout:
//
//   install -> bare `2f` refusal -> `2f init` -> no-provider refusal ->
//   manifest provider + auto routing -> first task -> READY ->
//   persistence across CLI processes -> `2f ui` -> uninstall
//
// It deliberately does not import anything from src/: the packaged product
// must not depend on files that exist only in the repository checkout.
// Provider availability is made deterministic (CLAUDE_BIN/DSH_BIN point at
// a missing executable; the fake provider is a command manifest), so the
// test passes identically whether or not claude/dsh are installed.
//
// The one environment dependency is npm + registry access to resolve the
// `ws` dependency during install. When the registry is unreachable the test
// skips (the suite stays green offline); every other failure is a real
// distribution regression.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

// Run a command, returning { status, stdout, stderr }. Throws on spawn error.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...opts
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// A tiny harness script that answers in the shared Work prompt contract.
async function writeFakeAgent(dir) {
  const p = path.join(dir, "fake-agent.mjs");
  await fsp.writeFile(
    p,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(`## Result",
      "The task was completed by the fake agent.",
      "",
      "## Evidence",
      "Fake evidence.",
      "",
      "## Changes",
      "None.",
      "",
      "## Verification",
      "Verified.",
      "",
      "## Needs human decision",
      "REQUIRED: no",
      "`);",
      ""
    ].join("\n")
  );
  return p;
}

// Find the pid LISTENING on `port` (macOS/Linux best effort; null otherwise).
// Only listening sockets are matched: this test's own fetch() keep-alive
// connections have `port` as their REMOTE port, and killing our own process
// would be a self-inflicted SIGTERM.
function pidOnPort(port) {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const pid = out.trim().split("\n")[0] || null;
    return pid && Number(pid) !== process.pid ? pid : null;
  } catch {
    return null;
  }
}

function isNetworkFailure(output) {
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network.*unreachable|getaddrinfo/i.test(
    output
  );
}

test("the packed artifact supports the full first-install journey", async t => {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "0x2f-dist-test-"));
  const cache = path.join(work, "npm-cache");
  const prefix = path.join(work, "prefix");
  const proj = path.join(work, "proj");
  await fsp.mkdir(cache);
  await fsp.mkdir(proj);

  // --- 1. pack the real artifact (never --dry-run) --------------------------
  const pack = run("npm", ["pack", "--json", "--cache", cache, "--pack-destination", work], {
    cwd: ROOT
  });
  assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
  const [packed] = JSON.parse(pack.stdout);
  const tgz = path.join(work, packed.filename);
  assert.ok(fs.existsSync(tgz), `npm pack produced no tarball (${packed.filename})`);

  // --- 2. install the tarball into a global prefix --------------------------
  const install = run(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--cache",
      cache,
      "--no-audit",
      "--no-fund",
      "--fetch-retries=0",
      tgz
    ],
    { cwd: work }
  );
  if (install.status !== 0) {
    // The only acceptable failure is "the registry is unreachable" (we need
    // `ws` from it). Anything else is a real distribution regression.
    if (isNetworkFailure(install.stderr)) {
      t.skip(`registry unreachable; cannot resolve ws: ${install.stderr.split("\n")[0]}`);
      return;
    }
    assert.fail(`npm install -g <tgz> failed: ${install.stderr}`);
  }

  const cli = path.join(prefix, "bin", "2f");
  assert.ok(fs.existsSync(cli), "no 2f bin shim in the global prefix");

  // Deterministic provider availability: natives must look missing regardless
  // of the machine's installed harnesses; the fake manifest provider carries
  // the real task.
  const env = {
    ...process.env,
    CLAUDE_BIN: path.join(work, "missing-claude"),
    DSH_BIN: path.join(work, "missing-dsh")
  };
  const cliRun = (args, opts = {}) =>
    run(process.execPath, [cli, ...args], { cwd: proj, env, ...opts });

  // --- 3. bare `2f` outside a project refuses with guidance ----------------
  const bare = cliRun([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /No \.work project found\. Run `2f init` first\./);

  // --- 4. first initialization ---------------------------------------------
  const init = cliRun(["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Initialized/);
  for (const f of [
    "project.md",
    "rules.md",
    "knowledge.md",
    "decisions.md",
    path.join("providers", "README.md")
  ]) {
    assert.ok(fs.existsSync(path.join(proj, ".work", f)), `init did not create .work/${f}`);
  }
  // With no harness on PATH, init says so — the first-use signal.
  assert.match(init.stdout, /No coding harness detected/);

  // --- 5. first task refuses before persisting a doomed run ----------------
  const refused = cliRun(["new", "doomed"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Execution provider "claude-code" is unavailable/);
  assert.match(refused.stderr, /Expected executable:/);
  assert.deepEqual(
    await fsp.readdir(path.join(proj, ".work", "tasks")),
    [],
    "a refused task must not be persisted"
  );

  // --- 6. manifest provider + auto routing -> the first real task ----------
  const agent = await writeFakeAgent(work);
  await fsp.mkdir(path.join(proj, ".work", "providers"), { recursive: true });
  await fsp.writeFile(
    path.join(proj, ".work", "providers", "fake.json"),
    JSON.stringify(
      {
        id: "fake",
        displayName: "Fake Agent",
        transport: "command",
        command: ["node", agent, "{prompt}"]
      },
      null,
      2
    )
  );
  await fsp.writeFile(
    path.join(proj, ".work", "routing.json"),
    JSON.stringify({ default: "auto", prefer: ["fake"] })
  );

  const providers = cliRun(["providers"]);
  assert.equal(providers.status, 0);
  assert.match(providers.stdout, /\bfake\b/);

  const created = cliRun(["new", "Investigate why retries restart the whole run"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created #001/);
  assert.match(created.stdout, /Fake Agent is running in the background\./);

  // The worker is detached; poll the CLI list until the run settles READY.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const list = cliRun([]);
    if (list.stdout.includes("READY")) ready = true;
    else await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, "the first task never reached READY");

  const opened = cliRun(["open", "1"]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /fake/); // the run strip names the provider
  assert.match(opened.stdout, /completed by the fake agent/);

  // --- 7. persistence across CLI processes ----------------------------------
  const again = cliRun(["open", "1"]);
  assert.match(again.stdout, /completed by the fake agent/);

  // --- 8. local Web UI startup from the installed CLI -----------------------
  const port = 4600 + (process.pid % 400);
  const ui = cliRun(["ui", "--no-browser", "--port", String(port)]);
  assert.equal(ui.status, 0, ui.stderr);
  assert.match(ui.stdout, new RegExp(`0x2F UI: http://127\\.0\\.0\\.1:${port}`));

  // Wait for health, then exercise the browser path: the shell mints the
  // auth cookie, the API is token-gated, task state is reachable. Health also
  // reports the workspace path (loopback-only; the shell bootstrap already
  // carries it to the local browser) so `2f pair` can recognize a
  // same-workspace runtime when choosing a LAN port.
  let health = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      health = await res.json();
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  assert.deepEqual(health, { ok: true, mode: "local", base: await fsp.realpath(proj) });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tasks`)).status, 401);
  const shell = await fetch(`http://127.0.0.1:${port}/`);
  assert.ok(shell.headers.get("set-cookie")?.includes("0x2f_auth="), "shell must set the auth cookie");
  const cookie = shell.headers.get("set-cookie").split(";")[0];
  const tasks = await (
    await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { cookie } })
  ).json();
  assert.ok(
    tasks.some(task => task.title === "Investigate why retries restart the whole run"),
    "the API (with the shell cookie) must expose the persisted task"
  );
  assert.ok(fs.existsSync(path.join(proj, ".work", "ui.log")), ".work/ui.log must exist");

  // Stop the detached runtime (best effort).
  const pid = pidOnPort(port);
  if (pid) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  // --- 9. uninstall: the CLI goes, the project state stays ------------------
  const uninstall = run(
    "npm",
    ["rm", "-g", "--prefix", prefix, "--cache", cache, "0x2f"],
    { cwd: work }
  );
  assert.equal(uninstall.status, 0, `npm rm -g failed: ${uninstall.stderr}`);
  assert.ok(!fs.existsSync(cli), "2f must be gone after uninstall");
  assert.ok(
    fs.existsSync(
      path.join(proj, ".work", "tasks", "001-investigate-why-retries-restart-the-whole-run", "task.json")
    ),
    "project .work must survive the uninstall"
  );

  await fsp.rm(work, { recursive: true, force: true });
});
