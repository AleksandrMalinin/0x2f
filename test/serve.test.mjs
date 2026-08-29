// Foreground runtime lifecycle on a dedicated host — real server-entry
// child processes, real detached workers:
//
//   - SIGTERM shuts the runtime down cleanly (exit 0) WITHOUT terminating
//     the detached worker — the in-flight run completes and writes its
//     outcome to the task state;
//   - a task left "working" with a dead worker is recovered (failed/crashed)
//     on the next runtime start, and reruns normally;
//   - a genuinely running task survives a runtime restart untouched (the
//     recovery sweep never races a live worker);
//   - SIGINT is a clean shutdown too.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/server-entry.mjs", import.meta.url));
const SLOW_DEFAULT_MS = 2500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, what, { timeoutMs = 10000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

// A workspace with a deterministic slow provider: a node script that waits
// SLOW_MS then answers in the shared Work prompt contract. No model, no
// network — the run is fully controllable and interruptible.
async function setupWorkspace() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "work-serve-"));
  const script = path.join(base, "slow-agent.mjs");
  await fs.writeFile(
    script,
    [
      "#!/usr/bin/env node",
      "const ms = Number(process.env.SLOW_MS || 2500);",
      "setTimeout(() => {",
      "  process.stdout.write(`## Result",
      "finished",
      "",
      "## Evidence",
      "-",
      "",
      "## Changes",
      "None",
      "",
      "## Verification",
      "ran",
      "",
      "## Needs human decision",
      "REQUIRED: no",
      "`);",
      "  process.exit(0);",
      "}, ms);",
      ""
    ].join("\n")
  );
  await fs.mkdir(path.join(base, ".work", "providers"), { recursive: true });
  await fs.writeFile(
    path.join(base, ".work", "providers", "slow.json"),
    JSON.stringify(
      {
        id: "slow",
        displayName: "Slow",
        transport: "command",
        command: ["node", script, "{prompt}"]
      },
      null,
      2
    )
  );
  return base;
}

// Spawn the real runtime entry in the foreground. Port 0 binds an ephemeral
// port; the URL is parsed from the runtime's own stdout (the same log line a
// supervisor would see).
function startRuntime(base, { slowMs = SLOW_DEFAULT_MS } = {}) {
  const child = spawn(process.execPath, [ENTRY, base, "0"], {
    env: { ...process.env, SLOW_MS: String(slowMs) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.on("error", () => {});
  const logs = [];
  child.stdout.on("data", d => logs.push(d.toString()));
  child.stderr.on("data", d => logs.push(d.toString()));
  const log = () => logs.join("");
  return { child, log };
}

function waitForUrl(runtime, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("runtime URL never appeared; output:\n" + runtime.log())),
      timeoutMs
    );
    const onData = () => {
      const m = runtime.log().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        cleanup();
        resolve(m[1]);
      }
    };
    runtime.child.stdout.on("data", onData);
    runtime.child.stderr.on("data", onData);
    const cleanup = () => {
      clearTimeout(timer);
      runtime.child.stdout.off("data", onData);
      runtime.child.stderr.off("data", onData);
    };
  });
}

function waitExit(child, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error("runtime did not exit")), timeoutMs);
    const onExit = code => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once("exit", onExit);
  });
}

async function waitHealth(port, { timeoutMs = 10000 } = {}) {
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        return res.ok;
      } catch {
        return false;
      }
    },
    `runtime on :${port} to be healthy`,
    { timeoutMs }
  );
}

// Authenticated API client: the shell mints the per-runtime auth cookie.
async function makeClient(url) {
  const shell = await fetch(url + "/");
  const cookie = shell.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "the shell must set the auth cookie");
  return {
    async api(p, init = {}) {
      return fetch(url + p, {
        ...init,
        headers: { ...(init.headers ?? {}), cookie }
      });
    }
  };
}

// Read a task's state straight off disk (works while no runtime is up).
async function readTaskOnDisk(base, id) {
  const dir = path.join(base, ".work", "tasks");
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const slug = entries.find(e => e.startsWith(String(id).padStart(3, "0") + "-"));
  if (!slug) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dir, slug, "task.json"), "utf8"));
  } catch {
    return null;
  }
}

async function stopAndReap(runtime) {
  try {
    if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await waitExit(runtime.child, { timeoutMs: 3000 }).catch(() => {});
}

test("SIGTERM shuts the runtime down cleanly without terminating the detached worker", async () => {
  const base = await setupWorkspace();
  const runtime = startRuntime(base);
  try {
    const port = await waitForUrl(runtime);
    await waitHealth(port);
    const client = await makeClient(`http://127.0.0.1:${port}`);

    const created = await client.api("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "slow run", provider: "slow" })
    });
    assert.equal(created.status, 201, runtime.log());
    const task = await created.json();
    assert.equal(task.status, "working");
    assert.ok(task.pid, "the task must carry the worker pid");

    // Shut the runtime down mid-run.
    runtime.child.kill("SIGTERM");
    const exitCode = await waitExit(runtime.child);
    assert.equal(exitCode, 0, "graceful shutdown must exit 0");
    assert.equal(await isPidAlive(task.pid), true, "the detached worker must survive runtime shutdown");

    // The worker keeps executing and writes its outcome on its own.
    const done = await waitFor(
      async () => (await readTaskOnDisk(base, task.id))?.status === "ready",
      "the in-flight run to complete after runtime shutdown",
      { timeoutMs: 10000 }
    );
    assert.equal(done, true);
    const settled = await readTaskOnDisk(base, task.id);
    assert.equal(settled.status, "ready");
    assert.equal(settled.runs[0].outcome, "ready");
  } finally {
    await stopAndReap(runtime);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a task left working with a dead worker is recovered on the next runtime start", async () => {
  const base = await setupWorkspace();
  const runtimeA = startRuntime(base, { slowMs: 4000 });
  try {
    const port = await waitForUrl(runtimeA);
    await waitHealth(port);
    const client = await makeClient(`http://127.0.0.1:${port}`);

    const created = await client.api("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "crashed run", provider: "slow" })
    });
    assert.equal(created.status, 201, runtimeA.log());
    const task = await created.json();

    // Simulate a crash mid-run: the worker dies without writing an outcome.
    process.kill(task.pid, "SIGKILL");
    await waitFor(
      () => isPidAlive(task.pid).then(alive => !alive),
      "the worker to be gone"
    );

    // Runtime restarts (reboot / supervisor respawn).
    runtimeA.child.kill("SIGTERM");
    assert.equal(await waitExit(runtimeA.child), 0);

    const runtimeB = startRuntime(base);
    try {
      const portB = await waitForUrl(runtimeB);
      await waitHealth(portB);
      const clientB = await makeClient(`http://127.0.0.1:${portB}`);

      // The startup sweep must have marked the interrupted run failed/crashed.
      const detail = await clientB.api("/api/tasks/" + task.id).then(r => r.json());
      assert.equal(detail.status, "failed");
      assert.deepEqual(detail.failure, { kind: "crashed" });
      assert.match(detail.error, /interrupted/i);
      assert.equal(detail.runs.at(-1).outcome, "failed");

      // And the task can be rerun normally — the working guard is gone.
      const rerun = await clientB.api("/api/tasks/" + task.id + "/rerun", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(rerun.status, 201, runtimeB.log());
      const rerunTask = await rerun.json();
      assert.equal(rerunTask.status, "working");
      assert.equal(rerunTask.runs.length, 2, "history preserved, run 02 appended");

      await waitFor(
        async () => (await readTaskOnDisk(base, task.id))?.status === "ready",
        "the rerun to complete",
        { timeoutMs: 10000 }
      );
    } finally {
      await stopAndReap(runtimeB);
    }
  } finally {
    await stopAndReap(runtimeA);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a genuinely running task survives a runtime restart untouched", async () => {
  const base = await setupWorkspace();
  const runtimeA = startRuntime(base, { slowMs: 4000 });
  try {
    const port = await waitForUrl(runtimeA);
    await waitHealth(port);
    const client = await makeClient(`http://127.0.0.1:${port}`);

    const created = await client.api("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "keep running", provider: "slow" })
    });
    assert.equal(created.status, 201, runtimeA.log());
    const task = await created.json();

    // Runtime restarts while the worker is still alive.
    runtimeA.child.kill("SIGTERM");
    assert.equal(await waitExit(runtimeA.child), 0);
    assert.equal(await isPidAlive(task.pid), true, "worker still running");

    const runtimeB = startRuntime(base);
    try {
      const portB = await waitForUrl(runtimeB);
      await waitHealth(portB);
      const clientB = await makeClient(`http://127.0.0.1:${portB}`);

      // The sweep must NOT have touched the live run.
      const detail = await clientB.api("/api/tasks/" + task.id).then(r => r.json());
      assert.equal(detail.status, "working", "a live run is never marked interrupted");

      // It completes normally, writing its outcome to the task state.
      await waitFor(
        async () => (await readTaskOnDisk(base, task.id))?.status === "ready",
        "the live run to complete across the restart",
        { timeoutMs: 10000 }
      );
    } finally {
      await stopAndReap(runtimeB);
    }
  } finally {
    await stopAndReap(runtimeA);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("SIGINT is a clean shutdown too", async () => {
  const base = await setupWorkspace();
  const runtime = startRuntime(base);
  try {
    const port = await waitForUrl(runtime);
    await waitHealth(port);
    runtime.child.kill("SIGINT");
    const exitCode = await waitExit(runtime.child);
    assert.equal(exitCode, 0, "SIGINT must shut down cleanly with exit 0");
  } finally {
    await stopAndReap(runtime);
    await fs.rm(base, { recursive: true, force: true });
  }
});
