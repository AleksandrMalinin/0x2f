// `2f ui` — the app launcher.
//
//   - a healthy 0x2F runtime on the port is REUSED (no second runtime),
//   - a missing runtime is started in the background, waited on, opened,
//   - "another process owns the port" is a useful error, not an opaque
//     EADDRINUSE,
//   - startup/health has a timeout with a pointer at the runtime log,
//   - browser opening is invocable without launching browsers (injected),
//   - startServer itself rejects clearly when the port is taken.
//
// Everything runs against real HTTP servers on ephemeral ports; the only
// things injected are the browser opener, the spawn, and the health probe.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { launchUi, probeUi, openBrowser, UiError } from "../src/ui.mjs";

async function tempBase() {
  return fs.mkdtemp(path.join(os.tmpdir(), "work-ui-"));
}

function fakeSpawn(record) {
  // A spawn that never really launches: records argv and returns a child
  // shaped like the detached child the launcher unrefs.
  return (command, args, options) => {
    record.push({ command, args, options });
    return { unref() {} };
  };
}

function openedSpy() {
  const calls = [];
  return { calls, fn: async url => (calls.push(url), true) };
}

test("probeUi: a healthy 0x2F runtime answers ok; a plain HTTP server is 'other'; silence is 'down'", async () => {
  const base = await tempBase();
  let handle;
  try {
    const runtime = createRuntime(base);
    handle = await startServer(base, 0, { runtime, interval: 20 });
    const ok = await probeUi(handle.url);
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, "0x2f");
  } finally {
    await handle?.close();
    await fs.rm(base, { recursive: true, force: true });
  }

  // A non-0x2F process owns a port: answers HTTP but is not a 0x2F runtime.
  const other = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  const otherUrl = `http://127.0.0.1:${other.address().port}`;
  try {
    const miss = await probeUi(otherUrl);
    assert.equal(miss.ok, false);
    assert.equal(miss.kind, "other");
  } finally {
    other.close();
  }

  // Nothing listening.
  const free = await new Promise(resolve => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
  const down = await probeUi(`http://127.0.0.1:${free}`);
  assert.equal(down.ok, false);
  assert.equal(down.kind, "down");
});

test("launchUi reuses a running 0x2F runtime: no spawn, browser opened with the URL", async () => {
  const base = await tempBase();
  const spawns = [];
  const open = openedSpy();
  const runtime = createRuntime(base);
  const handle = await startServer(base, 0, { runtime, interval: 20 });
  const port = handle.server.address().port;
  try {
    const result = await launchUi({
      base,
      port,
      spawnImpl: fakeSpawn(spawns),
      openBrowserImpl: open.fn
    });
    assert.equal(result.status, "reused");
    assert.equal(result.url, `http://127.0.0.1:${port}`);
    assert.equal(result.opened, true);
    assert.deepEqual(spawns, []); // no second runtime
    assert.deepEqual(open.calls, [result.url]);
  } finally {
    await handle.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("launchUi starts a missing runtime, waits for health, and opens the browser", async () => {
  const base = await tempBase();
  const spawns = [];
  const open = openedSpy();
  // The port starts silent and becomes healthy once the launcher spawns —
  // the probe transitions down -> ok on the second call.
  let probes = 0;
  const probe = async () => {
    probes++;
    return probes >= 2 ? { ok: true, kind: "0x2f" } : { ok: false, kind: "down" };
  };
  try {
    const result = await launchUi({
      base,
      port: 4242,
      probe,
      spawnImpl: fakeSpawn(spawns),
      openBrowserImpl: open.fn
    });
    assert.equal(result.status, "started");
    assert.equal(result.url, "http://127.0.0.1:4242");
    assert.equal(result.opened, true);
    assert.equal(spawns.length, 1);
    // node <server-entry.mjs> <base> <port> — the detached UI runtime.
    assert.match(spawns[0].args[0], /server-entry\.mjs$/);
    assert.equal(spawns[0].args[1], base);
    assert.equal(spawns[0].args[2], "4242");
    assert.deepEqual(open.calls, ["http://127.0.0.1:4242"]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("launchUi --no-browser starts the runtime but opens nothing", async () => {
  const base = await tempBase();
  const spawns = [];
  const open = openedSpy();
  const probe = async () => ({ ok: true, kind: "0x2f" });
  try {
    const result = await launchUi({
      base,
      port: 4242,
      open: false,
      probe,
      spawnImpl: fakeSpawn(spawns),
      openBrowserImpl: open.fn
    });
    assert.equal(result.status, "reused");
    assert.equal(result.opened, false);
    assert.deepEqual(open.calls, []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("launchUi reports 'another process owns the port' instead of an opaque EADDRINUSE", async () => {
  const base = await tempBase();
  const other = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ not: "0x2f" }));
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  const port = other.address().port;
  try {
    await assert.rejects(
      () => launchUi({ base, port }),
      error => {
        assert.ok(error instanceof UiError);
        assert.match(error.message, new RegExp(`Port ${port} is in use by another process`));
        assert.match(error.message, /not answering as a 0x2F runtime/);
        return true;
      }
    );
  } finally {
    other.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("launchUi times out with a pointer at the runtime log when health never arrives", async () => {
  const base = await tempBase();
  const spawns = [];
  const probe = async () => ({ ok: false, kind: "down" });
  try {
    await assert.rejects(
      () =>
        launchUi({
          base,
          port: 4242,
          waitMs: 120,
          intervalMs: 20,
          probe,
          spawnImpl: fakeSpawn(spawns),
          openBrowserImpl: openedSpy().fn
        }),
      error => {
        assert.ok(error instanceof UiError);
        assert.match(error.message, /Timed out waiting for the 0x2F runtime/);
        assert.match(error.message, /ui\.log/);
        return true;
      }
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("launchUi surfaces 'another process' discovered during the wait", async () => {
  const base = await tempBase();
  const spawns = [];
  let first = true;
  const probe = async () => {
    if (first) {
      first = false;
      return { ok: false, kind: "down" };
    }
    return { ok: false, kind: "other" };
  };
  try {
    await assert.rejects(
      () =>
        launchUi({
          base,
          port: 4242,
          probe,
          spawnImpl: fakeSpawn(spawns),
          openBrowserImpl: openedSpy().fn
        }),
      /in use by another process/
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("openBrowser spawns the platform opener and resolves; a missing opener resolves false", async () => {
  // Successful spawn: the child fires 'spawn', openBrowser resolves true and
  // unrefs the detached child. The platform opener is the native mechanism.
  let child;
  const spawnImpl = (command, args) => {
    child = {
      command,
      args,
      unref() {},
      on(name, cb) {
        this[name] = cb;
        return this;
      }
    };
    return child;
  };
  const opened = openBrowser("http://127.0.0.1:4242", { spawnImpl });
  child.spawn(); // fire the 'spawn' listener like a real ChildProcess
  assert.equal(await opened, true);
  const expected =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  assert.equal(child.command, expected);
  assert.equal(child.args[0], "http://127.0.0.1:4242");

  // A missing opener (headless Linux without xdg-utils): 'error' fires and
  // openBrowser resolves false instead of throwing.
  const errored = openBrowser("http://127.0.0.1:4242", {
    spawnImpl: (command, args) => ({
      unref() {},
      on(name, cb) {
        if (name === "error") queueMicrotask(cb);
        return this;
      }
    })
  });
  assert.equal(await errored, false);
});

test("startServer rejects with a clear error when another process owns the port", async () => {
  const base = await tempBase();
  const other = http.createServer();
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  const port = other.address().port;
  try {
    await assert.rejects(
      () => startServer(base, port),
      error => {
        assert.match(error.message, /Port \d+ is already in use/);
        assert.equal(error.code, "EADDRINUSE");
        return true;
      }
    );
  } finally {
    other.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
