// LocalExecutionNode — the machine boundary.
//
// These tests pin the node contract: execution requests arrive at the node
// as normalized { task } objects, and the node turns them into process
// launches. spawn/kill are injectable, which is exactly the seam a future
// remote node (mini-PC) would replace with a transport instead of a spawn —
// proving execution does not have to mean "spawn on the UI machine".

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalNode } from "../src/nodes/local.mjs";

function recordingSpawn() {
  const calls = [];
  return {
    calls,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return { pid: 4242, unref() {} };
    }
  };
}

const task = slug => ({ slug, execution: { workspace: "local" } });

test("startExecution spawns the detached worker on this machine and returns its pid", async () => {
  const spawner = recordingSpawn();
  const node = createLocalNode({ workspace: "/tmp/proj", spawn: spawner.spawn });

  const pid = await node.startExecution({ task: task("003-x") });

  assert.equal(pid, 4242);
  assert.equal(spawner.calls.length, 1);
  const { cmd, args, opts } = spawner.calls[0];
  assert.equal(cmd, process.execPath);
  assert.ok(args[0].endsWith("worker.mjs"), `worker path: ${args[0]}`);
  assert.deepEqual(args.slice(1), ["/tmp/proj", "003-x"]);
  assert.equal(opts.detached, true);
  // stdout/stderr go to the task's run.log (an fd the node opened).
  assert.equal(opts.stdio[0], "ignore");
  assert.equal(typeof opts.stdio[1], "number");
  assert.equal(opts.stdio[2], opts.stdio[1]);
});

test("resumeExecution spawns the worker in resume mode with the grant", async () => {
  const spawner = recordingSpawn();
  const node = createLocalNode({ workspace: "/tmp/proj", spawn: spawner.spawn });

  await node.resumeExecution({ task: task("003-x"), grant: "allow" });
  const { args } = spawner.calls[0];
  assert.deepEqual(args.slice(1), ["/tmp/proj", "003-x", "resume", "allow"]);
});

test("resolveWorkspace maps the logical 'local' workspace to the local path", () => {
  const node = createLocalNode({ workspace: "/tmp/proj" });
  assert.equal(node.resolveWorkspace("local"), "/tmp/proj");
  // v0.2 tasks have no workspace field — treated as local.
  assert.equal(node.resolveWorkspace(undefined), "/tmp/proj");
  assert.throws(() => node.resolveWorkspace("mini-pc"), /cannot resolve workspace "mini-pc"/);
});

test("cancelExecution is a best-effort stop of the recorded pid", async () => {
  const killed = [];
  const node = createLocalNode({
    workspace: "/tmp/proj",
    kill: pid => killed.push(pid)
  });
  await node.cancelExecution({ task: { slug: "003-x", pid: 77 } });
  assert.deepEqual(killed, [77]);
  await node.cancelExecution({ task: { slug: "003-x" } }); // no pid — no-op
  assert.deepEqual(killed, [77]);
});

test("the node is a swappable seam: the same contract a remote node would implement", async () => {
  // The action layer only knows { startExecution, resumeExecution,
  // cancelExecution, resolveWorkspace, id }. A future trusted mini-PC node
  // implements the SAME five members over a transport. Assert the local node
  // exposes exactly that contract, nothing more (no claude, no store, no UI).
  const node = createLocalNode({ workspace: "/tmp/proj" });
  const contract = Object.keys(node).sort();
  assert.deepEqual(contract, [
    "cancelExecution",
    "displayName",
    "id",
    "resolveWorkspace",
    "resumeExecution",
    "startExecution"
  ]);
  assert.equal(node.id, "local");
  assert.equal(node.displayName, "Local machine");
});
