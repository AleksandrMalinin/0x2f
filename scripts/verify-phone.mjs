// Real-device verification for phone pairing — runs the full pairing +
// remote-control flow over PUBLIC HTTPS, not loopback.
//
//   node scripts/verify-phone.mjs            # automated phone-side checks
//   node scripts/verify-phone.mjs --manual   # also wait for a physical phone
//   node scripts/verify-phone.mjs --ssh      # force localhost.run tunnels
//   node scripts/verify-phone.mjs --local-tls  # deterministic: https on
//                                              # localhost, no tunnel services
//
// It starts the relay and the static client origin locally, exposes both
// through public HTTPS quick tunnels (real TLS, no account, phone-trustable
// certificates), then:
//
//   1. runs `2f pair` against the public URLs (the exact user surface),
//   2. drives the phone-side protocol client through the public relay —
//      pairing ceremony, status, snapshot, encrypted SSE events, a task,
//   3. re-runs `2f pair` and prints a fresh URL + code you can open on a
//      physical phone right now (--manual waits until it is claimed),
//   4. runs `2f pair --off` and confirms the phone session dies at the relay.
//
// Tunnels: `cloudflared` on PATH is preferred; otherwise `npx cloudflared`
// (downloaded on first use) or an ssh quick tunnel to localhost.run. Needs a
// free local port for the runtime (default 4342). `--local-tls` instead runs
// the relay + client behind a self-signed local https (two distinct origins
// by port) — deterministic, no external services, for CI/offline runs.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRelayServer } from "../relay/server.mjs";
import { buildClient, CLIENT_ASSETS, routeToFile } from "../deploy/client/build.mjs";
import { initProject } from "../src/project.mjs";
import { pairPhone } from "../test/e2e-phone.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "src", "cli.mjs");
const TUNNEL_TIMEOUT_MS = 120000;
const MANUAL_WAIT_MS = 120000;

// A free local port for the runtime. A fresh random port per run keeps a
// stale runtime from a previous run (which watches a deleted workspace) from
// being "reused" by `2f pair`'s health probe.
async function freeRuntimePort() {
  for (let i = 0; i < 20; i++) {
    const port = 4300 + Math.floor(Math.random() * 200);
    try {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      server.close();
      return port;
    } catch {
      /* try another */
    }
  }
  return 4342;
}

const log = (...a) => console.log(...a);
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runCli(args, cwd, timeoutMs = 90000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parsePairing(stdout) {
  const urlLine = stdout.split("\n").find(l => l.includes("/pair?relay="));
  const codeLine = stdout.split("\n").find(l => l.startsWith("Pairing code:"));
  if (!urlLine || !codeLine) {
    throw new Error("Could not parse pairing output:\n" + stdout);
  }
  const url = urlLine.trim();
  const code = codeLine.replace(/^Pairing code:\s*/, "").trim();
  const q = new URL(url).searchParams;
  return { url, code, token: q.get("token"), deviceId: q.get("device") };
}

// Serve the built client with the exact route/MIME map the local runtime
// uses (src/server.mjs ASSETS mirrors deploy/client/build.mjs CLIENT_ASSETS).
function startClientServer(dir) {
  const routes = new Map(CLIENT_ASSETS.map(([, route, mime]) => [route, mime]));
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    try {
      const body = await fs.readFile(path.join(dir, routeToFile(pathname)));
      res.writeHead(200, {
        "content-type": routes.get(pathname) ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

// --- local-TLS mode ----------------------------------------------------------
//
// `--local-tls`: run the whole flow over real TLS on localhost with a
// self-signed certificate — two distinct origins by port — so the https
// path is verified deterministically without any tunnel service.

async function generateCert(dir) {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  await execFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ]);
  // execFile resolves on openssl's exit; the files can land a moment later
  // in sandboxed environments — poll briefly instead of statting once.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fs.stat(keyPath);
      await fs.stat(certPath);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("openssl did not produce the TLS certificate files");
      await sleep(200);
    }
  }
  return {
    key: await fs.readFile(keyPath),
    cert: await fs.readFile(certPath),
    certPath
  };
}

// A TLS reverse proxy in front of the plain relay: HTTP (fetch/SSE) is
// forwarded as-is; WebSocket upgrades are replayed on a raw socket so the
// Mac agent's wss:// connection lands on the relay too.
function tlsProxy(relayPort, tls) {
  const server = https.createServer(tls, (req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: relayPort, path: req.url, method: req.method, headers: req.headers },
      ures => {
        res.writeHead(ures.statusCode, ures.headers);
        ures.pipe(res);
      }
    );
    req.pipe(upstream);
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      } else {
        res.destroy();
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(relayPort, "127.0.0.1", () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n");
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

function startTlsClientServer(dir, tls) {
  const routes = new Map(CLIENT_ASSETS.map(([, route, mime]) => [route, mime]));
  const server = https.createServer(tls, async (req, res) => {
    const pathname = new URL(req.url || "/", "https://localhost").pathname;
    try {
      const body = await fs.readFile(path.join(dir, routeToFile(pathname)));
      res.writeHead(200, {
        "content-type": routes.get(pathname) ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

// A public https quick tunnel to a local port. Prefers cloudflared (reliable,
// fast allocation); falls back to localhost.run over ssh. Resolves once the
// tunnel URL appears in the tunnel's output. `argv` is the resolved tunnel
// command (see resolveTunnelCommand) — resolved once, so both tunnels reuse
// the same binary instead of racing an npx download.
async function openTunnel(port, argv, forceSsh) {
  if (forceSsh) return openSshTunnel(port);
  if (argv) return openCloudflared(argv, port);
  log("cloudflared not found — falling back to a localhost.run ssh tunnel");
  return openSshTunnel(port);
}

// Resolve a runnable cloudflared: on PATH, or via npx (downloaded on first
// use into a writable cache). Returns the argv prefix or null.
async function resolveTunnelCommand() {
  for (const args of [["cloudflared"], ["npx", "--yes", "cloudflared"]]) {
    try {
      const probe = await new Promise(resolve => {
        const child = spawn(args[0], [...args.slice(1), "--version"], {
          stdio: "ignore",
          env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), "0x2f-npm-cache") }
        });
        child.on("error", () => resolve(false));
        child.on("close", code => resolve(code === 0));
      });
      if (probe) return args;
    } catch {
      /* try next */
    }
  }
  return null;
}

function openCloudflared(argv, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), "tunnel", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), "0x2f-npm-cache") }
    });
    let out = "";
    const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
    const grab = d => {
      out += d;
      const m = out.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
      if (m) {
        clearInterval(timer);
        resolve({ url: "https://" + m[1], child });
      }
    };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        child.kill("SIGKILL");
        reject(new Error("cloudflared tunnel did not come up in time:\n" + out.slice(-800)));
      }
    }, 2000);
    child.on("error", err => {
      clearInterval(timer);
      reject(err);
    });
  });
}

// localhost.run fallback: an ssh quick tunnel with a pty (the URL is printed
// to the remote tty).
function openSshTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-tt",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ServerAliveInterval=15",
        "-N",
        "-R", `80:localhost:${port}`,
        "nokey@localhost.run"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
    const grab = d => {
      out += d;
      const m = out.match(/https:\/\/([a-z0-9-]+\.lhr\.life)/);
      if (m) {
        clearInterval(timer);
        resolve({ url: "https://" + m[1], child });
      }
    };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        child.kill("SIGKILL");
        reject(new Error("Tunnel did not come up in time:\n" + out.slice(-800)));
      }
    }, 2000);
    child.on("error", err => {
      clearInterval(timer);
      reject(err);
    });
  });
}

async function waitFor(fn, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

// Cloudflare quick tunnels print the URL before they start routing; poll
// until the origin actually answers (530/502 = not connected yet).
async function waitForTunnel(url, what, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      last = `HTTP ${res.status}`;
      if (![530, 502, 503, 504].includes(res.status)) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(`Tunnel for ${what} never became reachable (${last}): ${url}`);
    }
    if (Date.now() % 15000 < 1000) log(`  waiting for ${what}… (${last})`);
    await sleep(1500);
  }
}

async function main() {
  const manual = process.argv.includes("--manual");
  const forceSsh = process.argv.includes("--ssh");
  const localTls = process.argv.includes("--local-tls");

  // --local-tls runs the flow in a child process that trusts the generated
  // self-signed cert (NODE_EXTRA_CA_CERTS is read at process startup, so the
  // trust cannot be injected into this process mid-run).
  if (localTls && !process.env.__0X2F_VERIFY_TLS) {
    const certDir = await fs.mkdtemp(path.join(os.tmpdir(), "0x2f-verify-cert-"));
    await generateCert(certDir);
    const child = spawn(process.execPath, [process.argv[1], "--local-tls"], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.join(certDir, "cert.pem"),
        __0X2F_VERIFY_TLS: "1",
        __0X2F_VERIFY_TLS_DIR: certDir
      }
    });
    const code = await new Promise(resolve => child.on("close", resolve));
    process.exit(code ?? 1);
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "0x2f-verify-"));
  const ws = path.join(tmp, "ws");
  await fs.mkdir(ws, { recursive: true });
  const clientDir = path.join(tmp, "client");
  const runtimePort = await freeRuntimePort();
  log(`Workspace: ${ws}`);
  log(`Runtime port: ${runtimePort}`);

  const tunnels = [];
  const servers = []; // { close } handles to stop before exiting
  const cleanup = async () => {
    for (const t of tunnels) t.child.kill("SIGKILL");
    for (const s of servers) await s.close().catch(() => {});
    // The `2f pair` runtime is detached — stop the one this workspace started.
    spawn("pkill", ["-f", `server-entry.mjs ${ws} ${runtimePort}`]).on("error", () => {});
    await sleep(300);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (process.env.__0X2F_VERIFY_TLS_DIR) {
      await fs.rm(process.env.__0X2F_VERIFY_TLS_DIR, { recursive: true, force: true }).catch(() => {});
    }
  };
  process.on("exit", cleanup);

  try {
    await initProject(ws);
    await buildClient(clientDir);

    const relay = createRelayServer({
      dataFile: path.join(tmp, "state.json"),
      host: "127.0.0.1",
      port: 0,
      log: quiet
    });
    const relayHandle = await relay.start();
    servers.push(relayHandle);
    log(`Local relay on :${relayHandle.port}`);

    let publicRelay = null;
    let publicClient = null;
    if (localTls) {
      // Deterministic https: a self-signed TLS proxy in front of the relay
      // and a TLS static client origin — two distinct origins by port.
      const tls = {
        key: await fs.readFile(path.join(process.env.__0X2F_VERIFY_TLS_DIR, "key.pem")),
        cert: await fs.readFile(path.join(process.env.__0X2F_VERIFY_TLS_DIR, "cert.pem"))
      };
      const proxy = await tlsProxy(relayHandle.port, tls);
      const tlsClient = await startTlsClientServer(clientDir, tls);
      servers.push(proxy, tlsClient);
      publicRelay = `https://localhost:${proxy.port}`;
      publicClient = `https://localhost:${tlsClient.port}`;
      log(`  relay:  ${publicRelay} (TLS proxy -> :${relayHandle.port})`);
      log(`  client: ${publicClient}`);
    } else {
      const client = await startClientServer(clientDir);
      servers.push(client);
      log(`Local client on :${client.port}`);
      log("Opening public https quick tunnels…");
      const tunnelCmd = forceSsh ? null : await resolveTunnelCommand();
      let relayT = null;
      let clientT = null;
      // Free quick-tunnel services are occasionally slow to route; one retry.
      // A rate limit (429) won't clear in seconds — report it instead of churning.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          relayT = await openTunnel(relayHandle.port, tunnelCmd, forceSsh);
          await sleep(2000);
          clientT = await openTunnel(client.port, tunnelCmd, forceSsh);
          tunnels.push(relayT, clientT);
          publicRelay = relayT.url;
          publicClient = clientT.url;
          log(`  relay:  ${publicRelay}`);
          log(`  client: ${publicClient}`);
          // The two origins must differ — the client origin can never be the relay.
          if (publicRelay === publicClient) {
            throw new Error("Tunnels collided — client and relay must be distinct origins.");
          }
          await waitForTunnel(`${publicClient}/pair`, "client origin");
          await waitForTunnel(`${publicRelay}/api/pair/probe-verify`, "relay");
          break;
        } catch (error) {
          for (const t of tunnels) t.child.kill("SIGKILL");
          tunnels.length = 0;
          relayT = clientT = null;
          const rateLimited = /429|too many requests/i.test(String(error.message));
          if (attempt === 2 || rateLimited) {
            if (rateLimited) {
              throw new Error(
                "The quick-tunnel service is rate-limited (HTTP 429). Wait a minute or two, " +
                "then re-run — or install cloudflared on PATH for a more stable tunnel."
              );
            }
            throw error;
          }
          log(`  tunnel setup failed (${error.message}) — retrying…`);
          await sleep(5000);
        }
      }
    }

    // Public reachability + the cross-origin contract the phone page relies on.
    const page = await fetch(`${publicClient}/pair`);
    if (!page.ok || !(await page.text()).includes("PAIR")) {
      throw new Error(`Client origin did not serve the pairing page (HTTP ${page.status})`);
    }
    const probe = await fetch(`${publicRelay}/api/pair/probe-verify`);
    if (!probe.ok) throw new Error(`Relay /api/pair probe failed (HTTP ${probe.status})`);
    const preflight = await fetch(`${publicRelay}/api/pair/claim`, { method: "OPTIONS" });
    if (preflight.headers.get("access-control-allow-origin") !== "*") {
      throw new Error("Relay is missing cross-origin headers for the phone client");
    }

    // --- Phase 1: the exact `2f pair` surface, against the public URLs -------
    log("\n[1] Running `2f pair` against the public endpoints…");
    const pair = await runCli([
      "pair",
      "--relay", publicRelay,
      "--client", publicClient,
      "--port", String(runtimePort)
    ], ws);
    if (pair.code !== 0) throw new Error(`2f pair failed:\n${pair.stdout}\n${pair.stderr}`);
    const pairing = parsePairing(pair.stdout);
    if (!pairing.url.startsWith(publicClient + "/pair?")) {
      throw new Error("Pairing URL does not point at the client origin");
    }
    if (!pairing.url.includes(encodeURIComponent(publicRelay))) {
      throw new Error("Pairing URL does not carry the relay URL");
    }
    log(`  pairing URL: ${pairing.url}`);

    // --- Phase 2: the phone-side protocol client over public https -----------
    log("[2] Driving the phone-side client through the public relay…");
    const phone = await pairPhone({
      relayUrl: publicRelay,
      token: pairing.token,
      deviceId: pairing.deviceId,
      code: pairing.code
    });
    const status = await phone.status();
    if (status.mac !== "online") throw new Error(`Mac not online: ${JSON.stringify(status)}`);
    log("  paired; Mac is online");

    const snap0 = await phone.snapshot();
    if (!Array.isArray(snap0.tasks)) throw new Error("snapshot tasks missing");

    const received = [];
    const controller = new AbortController();
    let streamOpen;
    const streamOpened = new Promise(r => (streamOpen = r));
    const stream = phone.events(p => received.push(p), {
      signal: controller.signal,
      onOpen: () => streamOpen()
    });
    await streamOpened; // subscribe BEFORE triggering any Mac activity
    const created = await phone.api("/api/tasks", {
      method: "POST",
      body: { brief: "verify phone flow" }
    });
    await waitFor(
      () => received.some(p => p.cmd === "event"),
      "an encrypted event over public https",
      15000
    );
    log(`  task #${created.id} created; first event: ${received.find(p => p.cmd === "event").event.type}`);
    await phone.api(`/api/tasks/${created.id}/close`).catch(() => {});
    controller.abort();
    await stream.catch(() => {});

    const snap1 = await phone.snapshot();
    if (!snap1.tasks.some(t => t.id === created.id)) {
      throw new Error("Task missing from the phone's snapshot");
    }
    log("  snapshot reflects the task — E2E command/content path verified");

    // --- Phase 3: a fresh pairing for a physical phone (optional wait) --------
    log("\n[3] Fresh pairing for your physical phone…");
    const pair2 = await runCli([
      "pair",
      "--relay", publicRelay,
      "--client", publicClient,
      "--port", String(runtimePort)
    ], ws);
    if (pair2.code !== 0) throw new Error(`second 2f pair failed:\n${pair2.stdout}\n${pair2.stderr}`);
    const manual2 = parsePairing(pair2.stdout);
    log("Open this URL on your phone and type the code (one-time):");
    log(`  ${manual2.url}`);
    log(`  Pairing code:  ${manual2.code}`);
    if (manual && !localTls) {
      log(`Waiting up to ${MANUAL_WAIT_MS / 1000}s for the phone to claim it…`);
      const claimed = await waitFor(async () => {
        const r = await fetch(`${publicRelay}/api/pair/${manual2.token}`).then(r => r.json());
        return r.claimed ? true : null;
      }, "the phone to claim the pairing", MANUAL_WAIT_MS);
      log(claimed ? "  Phone claimed the pairing. ✓" : "  Not claimed within the window.");
    }

    // --- Phase 4: revocation over the public relay ----------------------------
    log("\n[4] Revoking with `2f pair --off`…");
    const off = await runCli(["pair", "--off"], ws);
    if (off.code !== 0) throw new Error(`2f pair --off failed:\n${off.stdout}\n${off.stderr}`);
    const after = await fetch(`${publicRelay}/api/status`, {
      headers: { authorization: "Bearer " + phone.session }
    });
    if (after.status !== 401) {
      throw new Error(`Phone session survived revocation (HTTP ${after.status})`);
    }
    log("  phone session dead at the relay. ✓");

    log("\nReal-device-path verification passed: https pairing, E2E commands,");
    log("encrypted events, and revocation all work over public TLS.");
  } finally {
    await cleanup();
    process.off("exit", cleanup);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
