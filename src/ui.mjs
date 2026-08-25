// `2f ui` — the app launcher.
//
// Opening the Web surface behaves like opening a local application:
//
//   2f ui
//     ├─ a 0x2F runtime already answers on the port
//     │     → do NOT start another runtime
//     │     → open the existing UI in the default browser
//     └─ nothing is listening
//           → spawn the detached UI runtime (src/server-entry.mjs)
//           → wait until it is healthy
//           → open the UI in the default browser
//
// The runtime is a detached background process, so `2f ui` returns and the
// UI keeps serving until it is killed — exactly like a local app. A second
// `2f ui` probes the port and reuses the running runtime; opening another
// tab is fine.
//
// The probe also distinguishes "0x2F already running on the port" from
// "another process owns the port": the latter answers HTTP but is not a 0x2F
// runtime, and `2f ui` says so instead of printing an opaque EADDRINUSE.
//
// Zero-dependency browser opening: macOS `open`, Linux `xdg-open`, Windows
// `cmd /c start`. All three are fire-and-forget — opening a tab is not a
// failure worth crashing the launcher over; the URL is always printed.
//
// The server-only path is preserved: `2f ui --no-browser` starts (or reuses)
// the runtime and prints the URL without opening anything, for development
// and automation. `startServer` itself remains importable for tests.

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";

export class UiError extends Error {
  constructor(message) {
    super(message);
    this.name = "UiError";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Probe whether a 0x2F runtime answers at `url`. The distinction that
// matters for `2f ui`:
//
//   { ok: true,  kind: "0x2f"  }  a healthy 0x2F runtime is serving
//   { ok: false, kind: "down"  }  nothing is listening (start a runtime)
//   { ok: false, kind: "other" }  SOMETHING is listening but it is not 0x2F
//                                 (another process owns the port)
//   { ok: false, kind: "timeout"} no answer within the probe window
//
// "Healthy" means the runtime's unauthenticated health endpoint answers with
// the normalized shape — the same availability fact the UI itself reads. The
// endpoint is deliberately token-free so the launcher can recognize a 0x2F
// runtime without knowing its per-process auth token.
export async function probeUi(url, opts = {}) {
  const { timeoutMs = 1200, fetchImpl = fetch } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url + "/api/health", {
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, kind: "other" };
    const body = await res.json();
    const healthy = body && body.ok === true && body.mode === "local";
    return healthy ? { ok: true, kind: "0x2f" } : { ok: false, kind: "other" };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, kind: "timeout" };
    const code = error?.cause?.code ?? error?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL") {
      return { ok: false, kind: "down" };
    }
    return { ok: false, kind: "other" };
  } finally {
    clearTimeout(timer);
  }
}

// Open `url` in the default browser, best effort. Returns a promise of
// whether the opener was spawned; a missing opener (headless Linux without
// xdg-utils) resolves false rather than crashing the launcher.
export function openBrowser(url, opts = {}) {
  const { spawnImpl = spawn } = opts;
  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd builtin; the empty first argument is the window title.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  return new Promise(resolve => {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function otherProcessMessage(port, url) {
  return (
    `Port ${port} is in use by another process — ${url} is not answering as a ` +
    `0x2F runtime. Stop that process, or serve the UI on another port: 2f ui <port>.`
  );
}

// Start the detached 0x2F runtime unless a healthy one already answers on
// the port. Returns { status: "reused" | "started", url }. This is the
// shared "make sure 0x2F is running" step behind `2f ui` and `2f pair` —
// both surfaces need the runtime alive, and neither may start a second one.
export async function ensureRuntime({
  base,
  port = 4242,
  host = "127.0.0.1",
  waitMs = 10000,
  intervalMs = 150,
  probe = probeUi,
  spawnImpl = spawn,
  logPath
} = {}) {
  const url = `http://${host}:${port}`;

  // Already running? Reuse it — never start a second runtime.
  const first = await probe(url);
  if (first.ok) {
    return { status: "reused", url };
  }
  if (first.kind === "other") {
    throw new UiError(otherProcessMessage(port, url));
  }

  // Not running: spawn the detached UI runtime, then wait for health. The
  // runtime's output goes to a log file so a startup failure is inspectable.
  const entry = new URL("./server-entry.mjs", import.meta.url);
  const log = logPath ?? path.join(base, ".work", "ui.log");
  fsSync.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fsSync.openSync(log, "a");
  let child;
  try {
    child = spawnImpl(process.execPath, [entry.pathname, base, String(port)], {
      detached: true,
      stdio: ["ignore", fd, fd]
    });
  } catch (error) {
    fsSync.closeSync(fd);
    throw new UiError(`Could not start the 0x2F runtime: ${error.message}`);
  }
  child.unref();

  const deadline = Date.now() + waitMs;
  for (;;) {
    const p = await probe(url);
    if (p.ok) {
      return { status: "started", url };
    }
    if (p.kind === "other") {
      throw new UiError(otherProcessMessage(port, url));
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new UiError(
    `Timed out waiting for the 0x2F runtime at ${url} to become healthy. ` +
      `See ${log} for the runtime log. If another process owns the port, stop ` +
      `it or use another port: 2f ui <port>.`
  );
}

// The whole launcher, with injectable seams for tests (probe, spawn, browser
// opener). Returns { status: "reused" | "started", url, opened }.
export async function launchUi({
  base,
  port = 4242,
  open = true,
  host = "127.0.0.1",
  waitMs = 10000,
  intervalMs = 150,
  probe = probeUi,
  openBrowserImpl = openBrowser,
  spawnImpl = spawn,
  logPath
} = {}) {
  const result = await ensureRuntime({
    base,
    port,
    host,
    waitMs,
    intervalMs,
    probe,
    spawnImpl,
    logPath
  });
  const opened = open ? await openBrowserImpl(result.url) : false;
  return { status: result.status, url: result.url, opened };
}
