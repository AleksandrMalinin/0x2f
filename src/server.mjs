// Work local API — the boundary between clients and Work Core.
//
// The browser (and a future TUI/desktop client) speaks HTTP + SSE to this
// server. The server is a thin client of the SHARED Work actions: it parses
// requests, calls actions, and streams normalized events. It contains no
// lifecycle logic, no provider logic, no file mutation of its own — the
// actions (core/actions.mjs) own all of that.
//
//   GET  /api/tasks                -> listWork()
//   GET  /api/tasks/:id            -> getWork(id)        ({ ...task, result })
//   POST /api/tasks                -> createWork({ title })
//   POST /api/tasks/:id/allow      -> allowWork(id)
//   POST /api/tasks/:id/reject     -> rejectWork(id)
//   POST /api/tasks/:id/close      -> closeWork(id)
//   GET  /api/events               -> Server-Sent Events (live normalized events)
//
// Security (local-first): the server binds to 127.0.0.1 by default. Work is
// deliberately not exposed to the LAN and has no auth in this iteration.
// A future trusted-node topology will need authentication + transport
// security BETWEEN the runtime and remote nodes — that is a future boundary,
// not implemented here.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { createRuntime } from "./runtime.mjs";
import { createTailer } from "./core/events.mjs";
import { WorkError } from "./core/errors.mjs";

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>0x2F</title>
<style>
  :root {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #181818; background: #f6f4ef;
  }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { max-width: 920px; margin: 0 auto; padding: 48px 24px 80px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:40px; }
  h1 { font-size: 26px; margin: 0; }
  .composer { display:flex; gap:10px; margin-bottom:38px; }
  input {
    flex:1; padding:16px 18px; border-radius:14px; border:1px solid #d8d4ca;
    background:white; font-size:16px; outline:none;
  }
  button {
    border:0; border-radius:12px; padding:0 18px; background:#1f1f1f; color:white;
    font-weight:600; cursor:pointer;
  }
  section { margin-top:28px; }
  .heading { font-size:12px; letter-spacing:.08em; color:#7b776f; margin-bottom:10px; }
  .task {
    display:flex; justify-content:space-between; gap:20px; align-items:center;
    background:white; border:1px solid #e3dfd6; border-radius:14px; padding:15px 17px;
    margin:8px 0; cursor:pointer;
  }
  .title { font-weight:650; }
  .meta { color:#8b877f; font-size:13px; margin-top:4px; }
  .badge { font-size:12px; color:#6f6b64; white-space:nowrap; }
  dialog {
    width:min(760px, calc(100vw - 32px)); border:0; border-radius:18px; padding:0;
    box-shadow:0 30px 90px rgba(0,0,0,.18);
  }
  dialog::backdrop { background:rgba(0,0,0,.28); }
  .modal { padding:24px; }
  pre {
    white-space:pre-wrap; overflow-wrap:anywhere; background:#f7f6f2; padding:18px;
    border-radius:12px; max-height:60vh; overflow:auto;
  }
  .close { float:right; padding:8px 12px; }
  .actions { margin-top:14px; display:flex; gap:10px; }
</style>
</head>
<body>
<main>
<header><h1>Today</h1><div>0x2F</div></header>

<form class="composer" id="composer">
  <input id="taskInput" placeholder="What needs doing?" autocomplete="off" />
  <button>Create task</button>
</form>

<div id="content"></div>

<dialog id="dialog">
  <div class="modal">
    <button class="close" onclick="document.getElementById('dialog').close()">Close</button>
    <h2 id="dialogTitle"></h2>
    <pre id="dialogBody"></pre>
    <div class="actions" id="actions">
      <button id="allowBtn" style="background:#1f7a3d;display:none;">Allow</button>
      <button id="rejectBtn" style="background:#a33;display:none;">Reject</button>
      <button id="closeTaskBtn" style="background:#5b5750;display:none;">Close task</button>
    </div>
  </div>
</dialog>
</main>

<script>
const content = document.getElementById("content");
const composer = document.getElementById("composer");
const taskInput = document.getElementById("taskInput");
const dialog = document.getElementById("dialog");
const dialogTitle = document.getElementById("dialogTitle");
const dialogBody = document.getElementById("dialogBody");
const allowBtn = document.getElementById("allowBtn");
const rejectBtn = document.getElementById("rejectBtn");
const closeTaskBtn = document.getElementById("closeTaskBtn");

// rows keeps a handle to each rendered task row so live progress events can
// update it in place without re-rendering the whole ledger.
const rows = new Map();

function blockedReason(task) {
  const blocked = task.blockedOn;
  if (!blocked) return "";
  if (blocked.type === "permission") return "Permission required";
  if (blocked.type === "decision") return "Decision needed";
  return "Needs you";
}

const groups = [
  ["NEEDS YOU", "needs_you"],
  ["WORKING", "working"],
  ["READY", "ready"],
  ["FAILED", "failed"],
  ["DONE", "done"]
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[c]));
}

async function post(path) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    let message = "HTTP " + res.status;
    try { message = (await res.json()).error || message; } catch {}
    throw new Error(message);
  }
  return res.json();
}

async function refresh() {
  const tasks = await fetch("/api/tasks").then(r => r.json());
  content.innerHTML = "";
  rows.clear();

  for (const [heading, status] of groups) {
    const items = tasks.filter(t => t.status === status);
    if (!items.length) continue;

    const section = document.createElement("section");
    section.innerHTML = '<div class="heading">' + heading + '</div>';

    for (const task of items) {
      const row = document.createElement("div");
      row.className = "task";
      const reason = blockedReason(task);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "#" + task.id + (reason ? " · " + reason : "");
      row.innerHTML = '<div><div class="title">' + escapeHtml(task.title) + '</div></div>' +
        '<div class="badge">' + escapeHtml(task.status) + '</div>';
      row.querySelector(".title").after(meta);
      rows.set(task.id, { meta });

      row.onclick = async () => {
        const detail = await fetch("/api/tasks/" + task.id).then(r => r.json());
        dialogTitle.textContent = "#" + task.id + " " + task.title;
        const blocked = detail.blockedOn;
        let body = "";
        if (blocked && blocked.type === "permission") {
          body = "NEEDS YOU — Permission\\n\\nAgent wants to modify:\\n  " + (blocked.file || "?") + "\\n\\nPlanned change:\\n  " + (blocked.plannedChange || "") + "\\n";
        } else if (blocked && blocked.type === "decision") {
          body = "NEEDS YOU — Decision\\n\\n" + (blocked.text || "") + "\\n";
        }
        body += (detail.result || detail.error || "No result yet.");
        dialogBody.textContent = body;
        allowBtn.style.display = blocked ? "inline-block" : "none";
        rejectBtn.style.display = blocked ? "inline-block" : "none";
        closeTaskBtn.style.display = detail.status === "done" ? "none" : "inline-block";
        allowBtn.onclick = () => resume(task.id, "allow");
        rejectBtn.onclick = () => resume(task.id, "reject");
        closeTaskBtn.onclick = () => closeTask(task.id);
        dialog.showModal();
      };

      section.appendChild(row);
    }

    content.appendChild(section);
  }

  if (!tasks.length) {
    content.innerHTML = '<div class="meta">No tasks yet.</div>';
  }
}

function updateActivity(taskId, text) {
  const entry = rows.get(taskId);
  if (entry && text) entry.meta.textContent = "#" + taskId + " · " + text;
}

async function resume(id, grant) {
  try {
    await post("/api/tasks/" + id + "/" + grant);
  } catch (error) {
    alert(error.message);
  }
  dialog.close();
  await refresh();
}

async function closeTask(id) {
  try {
    await post("/api/tasks/" + id + "/close");
  } catch (error) {
    alert(error.message);
  }
  dialog.close();
  await refresh();
}

// Live updates: normalized Work events over Server-Sent Events. State events
// re-render the ledger; progress events update the row in place. EventSource
// reconnects automatically, and we re-fetch state on every (re)connect so a
// dropped connection can never leave the ledger stale.
const es = new EventSource("/api/events");
for (const type of ["task.created", "task.updated", "task.closed", "run.completed", "run.failed"]) {
  es.addEventListener(type, () => refresh());
}
es.addEventListener("progress", e => {
  const ev = JSON.parse(e.data);
  updateActivity(ev.taskId, ev.text ? ev.text.replace(/\\s+/g, " ").slice(0, 80) : "");
});
es.addEventListener("tool.started", e => {
  const ev = JSON.parse(e.data);
  const input = ev.input || {};
  const target = input.file_path || (input.command ? input.command.slice(0, 60) : "");
  updateActivity(ev.taskId, (ev.name || "tool") + (target ? " " + target : ""));
});
es.addEventListener("needs_user", e => {
  const ev = JSON.parse(e.data);
  updateActivity(ev.taskId, "needs you · " + (ev.reason || ""));
});
es.onopen = () => refresh();

composer.onsubmit = async e => {
  e.preventDefault();
  const title = taskInput.value.trim();
  if (!title) return;

  taskInput.value = "";
  try {
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title })
    });
  } catch (error) {
    alert(error.message);
  }
  await refresh();
};

refresh();
</script>
</body>
</html>`;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// Read every task's event log once. The tailer diffs against what it has
// already emitted, so this is cheap even on a workspace with many tasks.
function makeReadLines(store) {
  return async () => {
    const dir = store.tasksDir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(dir, entry.name, "events.jsonl");
      try {
        const text = await fs.readFile(logPath, "utf8");
        out.push({ slug: entry.name, text });
      } catch {
        // no event log yet for this task
      }
    }
    return out;
  };
}

export async function startServer(base = process.cwd(), port = 4242, opts = {}) {
  const runtime = opts.runtime ?? createRuntime(base, opts);
  const { store, actions, events } = runtime;
  const host = opts.host ?? "127.0.0.1";
  const interval = opts.interval ?? 250;

  // One tailer per server: new lines in any task's event log become bus
  // events, so events written by OTHER processes (e.g. `2f allow` in a
  // terminal while this UI is open) reach every connected client.
  const tailer = createTailer({
    interval,
    emit: event => events.emit(event),
    readLines: makeReadLines(store)
  });
  tailer.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      // Live event channel — normalized Work events, SSE format.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");
        const unsubscribe = events.on(event => sendSse(res, event));
        req.on("close", () => unsubscribe());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        json(res, await actions.listWork());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = JSON.parse(await readBody(req));
        const task = await actions.createWork({ title: body.title });
        json(res, task, 201);
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (req.method === "GET" && taskMatch) {
        json(res, await actions.getWork(Number(taskMatch[1])));
        return;
      }

      const allowMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/allow$/);
      if (req.method === "POST" && allowMatch) {
        const task = await actions.allowWork(Number(allowMatch[1]));
        json(res, task, 202);
        return;
      }

      const rejectMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/reject$/);
      if (req.method === "POST" && rejectMatch) {
        const task = await actions.rejectWork(Number(rejectMatch[1]));
        json(res, task, 202);
        return;
      }

      const closeMatch = url.pathname.match(/^\/api\/tasks\/(\d+)\/close$/);
      if (req.method === "POST" && closeMatch) {
        json(res, await actions.closeWork(Number(closeMatch[1])));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      if (error instanceof WorkError) {
        json(res, { error: error.message }, error.status);
      } else {
        json(
          res,
          { error: error instanceof Error ? error.message : String(error) },
          500
        );
      }
    }
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  console.log(`0x2F UI: ${url}`);

  return {
    server,
    url,
    port: actualPort,
    runtime,
    close: async () => {
      tailer.stop();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
