// Shared PTY driver for the TUI dogfood suite.
//
// This is the piece that makes the tests real: a TUI session is a process
// on a REAL pseudo-terminal (see pty-relay.py) running the REAL `2f tui`
// entry point, driven by bytes written to the pty master — the same
// keyboard/input path a user's terminal uses. The visible screen is
// reconstructed by a small ANSI emulator, and canonical Work state is read
// back from disk through the store, so a visually plausible screen can never
// hide a broken task state.
//
// The same driver powers the CI suite (test/tui-pty-e2e.test.mjs) and the
// exploratory `npm run dogfood:tui` mode (scripts/dogfood-tui.mjs).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createStore } from "../../src/core/store.mjs";
import { initProject } from "../../src/project.mjs";

export const PYTHON = process.env.PYTHON ?? "python3";
export const CLI = new URL("../../src/cli.mjs", import.meta.url).pathname;
export const RELAY = new URL("./pty-relay.py", import.meta.url).pathname;
export const AGENT = new URL("./agents/fake-agent.mjs", import.meta.url).pathname;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function git(args, cwd) {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 15000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "")
      })
    );
  });
}

// --- the ANSI emulator ---------------------------------------------------------
//
// Only the sequences the TUI actually emits are interpreted: CSI cursor
// positioning, `2J` clear, `K` erase-to-end, and SGR/alt-screen/cursor
// sequences (stripped). The grid auto-grows, so a stale frame at an old size
// can never silently truncate a newer one — resize assertions wait for a
// stable frame instead.

export class Term {
  constructor(cols = 120, rows = 36) {
    this.grid = [];
    this.styles = []; // parallel to grid: per-cell { fg, bg, bold } | null
    this.sgr = { fg: null, bg: null, bold: false }; // current SGR state
    this.cr = 0;
    this.cc = 0;
    this.pending = "";
    // The dimensions of the LAST painted frame, tracked from the painter's
    // own writes: `2J` (a full repaint — the first frame and every resize)
    // resets them, and each `ESC[<r>;1H` row write extends them. This is
    // exact where trim-based math is not: a row that ends in pad spaces
    // would otherwise report a width one short.
    this.paintRows = 0;
    this.paintCols = 0;
  }

  _ensure(row, col) {
    while (this.grid.length <= row) {
      this.grid.push([]);
      this.styles.push([]);
    }
    const r = this.grid[row];
    const s = this.styles[row];
    while (r.length <= col) {
      r.push(" ");
      s.push(null);
    }
  }

  clear() {
    for (const row of this.grid) row.fill(" ");
    for (const row of this.styles) row.fill(null);
    this.sgr = { fg: null, bg: null, bold: false };
    this.cr = 0;
    this.cc = 0;
    this.paintRows = 0;
    this.paintCols = 0;
  }

  scrollUp() {
    this.grid.shift();
    this.grid.push([]);
    this.styles.shift();
    this.styles.push([]);
    this.cr = this.grid.length - 1;
  }

  put(ch) {
    this._ensure(this.cr, this.cc);
    this.grid[this.cr][this.cc] = ch;
    this.styles[this.cr][this.cc] = { ...this.sgr };
    this.cc++;
    this.paintCols = Math.max(this.paintCols, this.cc);
    if (this.cc >= 1000) {
      this.cc = 0;
      this.cr++;
    }
  }

  eraseToEnd() {
    const row = this.grid[this.cr] ?? [];
    const styles = this.styles[this.cr] ?? [];
    for (let i = this.cc; i < row.length; i++) {
      row[i] = " ";
      styles[i] = null;
    }
  }

  feed(text) {
    // The pty can split one paint across reads, so an ESC sequence may end
    // at a chunk boundary. Carry the unconsumed tail into the next feed
    // instead of dropping it (dropping would leak the tail of an SGR code
    // into the grid as literal text).
    text = (this.pending ?? "") + text;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\u001b") {
        if (text[i + 1] === "[") {
          let j = i + 2;
          let params = "";
          while (j < text.length && !(text[j] >= "@" && text[j] <= "~")) {
            params += text[j];
            j++;
          }
          if (j >= text.length) {
            this.pending = text.slice(i);
            return;
          }
          const nums = params.split(";").map(p => (p === "" ? null : Number(p)));
          this.csi(text[j], nums);
          i = j + 1;
          continue;
        }
        if (text[i + 1] === "]") {
          let j = i + 2;
          while (j < text.length && text[j] !== "\x07" && !(text[j] === "\u001b" && text[j + 1] === "\\")) j++;
          if (j >= text.length) {
            this.pending = text.slice(i);
            return;
          }
          i = j < text.length ? j + (text[j] === "\u001b" ? 2 : 1) : j;
          continue;
        }
        if (text.length - i === 1) {
          // A lone ESC at the very end of a chunk may be the start of a
          // sequence that has not arrived yet.
          this.pending = "\u001b";
          return;
        }
        i++; // ESC + a non-CSI char — drop the ESC, process the rest normally
        continue;
      }
      if (ch === "\r") {
        this.cc = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.cr++;
        if (this.cr >= this.grid.length) this.grid.push([]);
        i++;
        continue;
      }
      if (ch === "\b" || ch === "\x7f") {
        this.cc = Math.max(0, this.cc - 1);
        i++;
        continue;
      }
      if (ch >= " ") {
        this.put(ch);
      }
      i++;
    }
  }

  csi(final, nums) {
    const n = nums[0] ?? 1;
    switch (final) {
      case "H":
      case "f":
        this.cr = Math.max(0, (nums[0] ?? 1) - 1);
        this.cc = Math.max(0, (nums[1] ?? 1) - 1);
        // A row write starts at column 1 (the painter's `ESC[<r>;1H`); the
        // frame's height is the highest row it has written so far.
        if (this.cc === 0) this.paintRows = Math.max(this.paintRows, this.cr + 1);
        break;
      case "J":
        if (n === 2) this.clear();
        break;
      case "K":
        this.eraseToEnd();
        break;
      case "A":
        this.cr = Math.max(0, this.cr - (n || 1));
        break;
      case "B":
        this.cr += n || 1;
        break;
      case "C":
        this.cc += n || 1;
        break;
      case "D":
        this.cc = Math.max(0, this.cc - (n || 1));
        break;
      case "m": {
        // SGR — record the style so a renderer can draw real colors. The
        // painter emits full per-cell runs ("38;2;r;g;b;48;2;r;g;b;1m")
        // followed by a reset, so the running state is all we need.
        const p = nums;
        for (let i = 0; i < p.length; i++) {
          const code = p[i];
          if (code === null || code === undefined) continue;
          if (code === 0) this.sgr = { fg: null, bg: null, bold: false };
          else if (code === 1) this.sgr.bold = true;
          else if (code === 38 || code === 48) {
            const mode = p[i + 1];
            if (mode === 2) {
              const hex = [p[i + 2], p[i + 3], p[i + 4]]
                .map(v => Number(v ?? 0).toString(16).padStart(2, "0"))
                .join("");
              const color = "#" + hex;
              if (code === 38) this.sgr.fg = color;
              else this.sgr.bg = color;
              i += 4;
            } else if (mode === 5) {
              i += 2; // 256-color index — the TUI emits truecolor in tests
            } else {
              i += 1;
            }
          }
        }
        break;
      }
      default:
        break; // ?25l/?25h, ?1049h/l, ... — styling, ignored
    }
  }

  row(i) {
    return (this.grid[i] ?? []).join("");
  }

  // Rows with trailing whitespace trimmed; blank tail rows dropped.
  text() {
    const out = [];
    for (const row of this.grid) {
      const s = row.join("").trimEnd();
      if (!s.length && out.length === 0) continue;
      out.push(s);
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  width() {
    if (this.paintCols > 0) return this.paintCols;
    let max = 0;
    for (const row of this.grid) max = Math.max(max, row.join("").trimEnd().length);
    return max;
  }

  height() {
    if (this.paintRows > 0) return this.paintRows;
    let last = -1;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i].join("").trimEnd().length) last = i;
    }
    return last + 1;
  }
}

// --- keypress encoding ----------------------------------------------------------
//
// One `press` is ONE write to the pty master — one chunk, which is how the
// TUI's decodeKeys sees one key press (see src/tui/keys.mjs). A lone ESC is
// Escape; ESC + more bytes in the same chunk is a modifier sequence.

export const KEY_BYTES = {
  enter: "\r",
  escape: "\u001b",
  tab: "\t",
  "shift-tab": "\u001b[Z",
  backspace: "\u007f",
  "ctrl-c": "\u0003",
  "ctrl-n": "\u000e",
  "ctrl-z": "\u001a",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
  "shift-enter": "\u001b[13;2u",
  "alt-enter": "\u001b\r"
};

// --- the session ----------------------------------------------------------------

export async function startTui({
  workspace,
  env = {},
  cols = 120,
  rows = 36,
  args = ["tui"],
  relay = RELAY,
  cli = CLI,
  python = PYTHON
} = {}) {
  const child = spawn(python, [relay, process.execPath, cli, ...args], {
    cwd: workspace,
    // The relay reads the INITIAL terminal size from these (it sets the
    // winsize before the TUI even execs), so the first frame is drawn at a
    // known size, not the relay's default.
    env: tuiEnv({ PTY_COLS: String(cols), PTY_ROWS: String(rows), ...env }),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
  });

  const term = new Term(cols, rows);
  const raw = [];
  const stderr = [];
  let ctrlBuffer = "";
  let pid = null;
  let status = null; // { exit?, signal? } reported by the relay

  // Keystrokes go to the pty one at a time, spaced like a human's: the tty
  // coalesces bytes that arrive in the same read, and the TUI's decodeKeys
  // reads a lone ESC only when the WHOLE chunk is ESC (an ESC glued onto
  // other bytes in one chunk decodes as Ctrl+{). Serializing with a gap
  // keeps every logical key on its own chunk boundary.
  const KEY_GAP_MS = 15;
  let inputChain = Promise.resolve();
  const enqueueInput = data => {
    inputChain = inputChain.then(
      () =>
        new Promise(resolve => {
          try {
            child.stdin.write(Buffer.from(data, "utf8"));
          } catch {
            /* the relay is gone — the write is lost, like a dead terminal */
          }
          setTimeout(resolve, KEY_GAP_MS);
        })
    );
    return inputChain;
  };

  // A pty read can split a multi-byte UTF-8 glyph (─, │, ❯, …) across
  // chunks; decoding per-chunk with toString would corrupt it. A stateful
  // TextDecoder keeps split sequences intact.
  const utf8 = new TextDecoder("utf-8");
  child.stdout.on("data", chunk => {
    const text = utf8.decode(chunk, { stream: true });
    raw.push(chunk.toString("utf8"));
    term.feed(text);
  });
  child.stderr.on("data", chunk => stderr.push(chunk.toString("utf8")));
  child.stdio[4].on("data", chunk => {
    ctrlBuffer += chunk.toString("utf8");
    let nl;
    while ((nl = ctrlBuffer.indexOf("\n")) >= 0) {
      const line = ctrlBuffer.slice(0, nl).trim();
      ctrlBuffer = ctrlBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.pid) pid = message.pid;
        if (message.exit !== undefined || message.signal !== undefined) status = message;
      } catch {
        /* not ours */
      }
    }
  });

  let closeInfo = null;
  let spawnError = null;
  const exitPromise = new Promise(resolve => {
    child.on("close", (code, signal) => {
      closeInfo = { code, signal };
      resolve({ code, signal, status, spawnError });
    });
    // python3 missing, or the relay could not start — surface it clearly
    // instead of letting the first screen wait time out on an empty stream.
    child.on("error", error => {
      spawnError = error;
      closeInfo = { code: -1, signal: null };
      resolve({ code: -1, signal: null, status, spawnError: error });
    });
  });

  const session = {
    child,
    term,
    get pid() {
      return pid;
    },
    get status() {
      return status;
    },
    write(data) {
      return enqueueInput(data);
    },
    press(name) {
      return session.write(KEY_BYTES[name] ?? name);
    },
    // Type text exactly like a paste: one chunk, many printable keys.
    type(text) {
      return session.write(text);
    },
    // A single logical keypress, sent as its own chunk.
    key(ch) {
      return session.write(ch);
    },
    resize(newRows, newCols) {
      try {
        child.stdio[3].write(`RESIZE ${newRows} ${newCols}\n`);
      } catch {
        /* relay gone */
      }
    },
    signal(name) {
      try {
        child.stdio[3].write(`${name}\n`);
      } catch {
        /* relay gone */
      }
    },
    text() {
      return term.text();
    },
    // The screen as continuous prose: the pane separator and every line
    // break collapsed to single spaces. Wrapped text that spans rows (a
    // decision question, a wrapped failure sentence) reads as one stream,
    // which is what a human reads — the visual wrap is not content.
    textFlat() {
      return term
        .text()
        .replace(/[│]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    },
    rows() {
      return term.height();
    },
    width() {
      return term.width();
    },
    raw() {
      return raw.join("");
    },
    rawTail(n = 600) {
      const s = raw.join("");
      return s.slice(-n);
    },
    stderr() {
      return stderr.join("");
    },
    async waitFor(predicate, { timeout = 20000, label = "condition", interval = 60 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (predicate(session)) return session;
        await sleep(interval);
      }
      const spawn = session.spawnError();
      throw new Error(
        `TUI: timed out after ${timeout}ms waiting for ${label}\n` +
          (spawn ? `--- could not start: ${spawn.message}\n` : "") +
          `--- screen ---\n${session.text()}\n` +
          `--- raw tail ---\n${JSON.stringify(session.rawTail(500))}\n` +
          `--- relay stderr ---\n${session.stderr().slice(-500)}`
      );
    },
    async waitForText(regex, opts = {}) {
      return session.waitFor(s => regex.test(s.text()), {
        label: `screen matching ${regex}`,
        ...opts
      });
    },
    // For prose that the pane wraps: match against the flattened screen.
    async waitForFlatText(regex, opts = {}) {
      return session.waitFor(s => regex.test(s.textFlat()), {
        label: `screen prose matching ${regex}`,
        ...opts
      });
    },
    // Wait for the frame at `rows`x`cols` to be painted and stay stable —
    // a resize repaint races the 1s clock tick, so "stable" beats "first".
    async waitForFrame(newRows, newCols, opts = {}) {
      const { stability = 4, interval = 80, ...rest } = opts;
      let stable = 0;
      let last = null;
      return session.waitFor(
        s => {
          const key = s.rows() + "x" + s.width();
          if (key === newRows + "x" + newCols && /0x2F/.test(s.text())) {
            if (key === last) stable++;
            else stable = 1;
            last = key;
            return stable >= stability;
          }
          stable = 0;
          last = key;
          return false;
        },
        { timeout: 10000, label: `frame at ${newRows}x${newCols}`, interval, ...rest }
      );
    },
    async waitForExit({ timeout = 10000 } = {}) {
      const outcome = await Promise.race([
        exitPromise,
        sleep(timeout).then(() => ({ timedOut: true }))
      ]);
      if (outcome.timedOut) {
        throw new Error(
          `TUI: did not exit within ${timeout}ms\n--- screen ---\n${session.text()}\n--- raw tail ---\n${JSON.stringify(session.rawTail(400))}`
        );
      }
      return outcome;
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
    spawnError() {
      return spawnError;
    },
    closeInfo() {
      return closeInfo;
    }
  };
  return session;
}

// The environment every TUI child runs under: a real terminal identity (the
// TUI should paint like it would on a real terminal — NO_COLOR from the
// ambient environment is explicitly cleared), and every NATIVE provider
// pinned to a path that cannot exist, so routing and availability are
// deterministic on any machine (only the configured fake ACP providers are
// available).
export function tuiEnv(extra = {}) {
  const missing = path.join(os.tmpdir(), "0x2f-tui-missing-bins");
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    NO_COLOR: "",
    CLAUDE_BIN: path.join(missing, "claude"),
    CODEX_BIN: path.join(missing, "codex"),
    DSH_BIN: path.join(missing, "dsh"),
    GEMINI_BIN: path.join(missing, "gemini"),
    ...extra
  };
  if (!env.NO_COLOR) delete env.NO_COLOR;
  return env;
}

// --- workspace fixtures ----------------------------------------------------------

// A scratch git workspace with a real `.work/` project and three fake ACP
// providers (alpha = journey, bravo = authfail, charlie = succeed). The
// committed baseline file is what the journey agent really edits, so the
// TUI's CHANGES view can draw a REAL diff.
export async function makeWorkspace({
  providerRoles = { alpha: "journey", bravo: "authfail", charlie: "succeed" },
  routingDefault = "alpha",
  baseline = { "src/app.ts": "const app = {};\n" },
  // A fixed leaf name makes the workspace label deterministic (the TUI
  // header shows it) — used by the visual-review captures. The default
  // keeps the random temp name the functional tests assert on.
  name = null
} = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "work-tui-pty-"));
  const base = name ? path.join(parent, name) : parent;
  await fs.mkdir(base, { recursive: true });
  for (const [file, content] of Object.entries(baseline)) {
    const abs = path.join(base, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  const init = await git(["init", "-q"], base);
  if (init.code !== 0) throw new Error("git init failed: " + init.stderr);
  await git(["config", "user.email", "tui@0x2f.dev"], base);
  await git(["config", "user.name", "0x2F TUI test"], base);
  await git(["add", "."], base);
  await git(["commit", "-qm", "baseline"], base);

  await initProject(base);

  const dir = path.join(base, ".work", "providers");
  for (const [id, role] of Object.entries(providerRoles)) {
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(
        {
          id,
          displayName: id[0].toUpperCase() + id.slice(1),
          transport: "acp",
          command: [process.execPath, AGENT, "--role", role]
        },
        null,
        2
      )
    );
  }
  await fs.writeFile(
    path.join(base, ".work", "routing.json"),
    JSON.stringify({ default: routingDefault }, null, 2)
  );

  const markers = {
    correction: "Use a 503, not a 429",
    answer: "keep the 429 for misbehaving clients"
  };
  const markersPath = path.join(base, ".work", "tui-test-markers.json");
  await fs.writeFile(markersPath, JSON.stringify(markers, null, 2));

  return { base, markers, markersPath };
}

// --- canonical state on disk -----------------------------------------------------

// Poll task.json until it reaches `status`. Reads can land mid-write (the
// worker persists non-atomically), so transient failures are retried — a
// stuck run still fails the wait. The poll is deliberately unhurried: the
// suite runs in parallel with load-sensitive tests, and every poll is a
// disk read.
export async function waitForTask(base, id, status, { timeout = 30000, tolerate = [] } = {}) {
  const store = createStore(base);
  const ok = new Set(["working", ...tolerate]);
  const start = Date.now();
  while (true) {
    let task;
    try {
      task = await store.findTask(id);
    } catch {
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for task ${id} -> ${status}`);
      await sleep(150);
      continue;
    }
    if (task.status === status) return task;
    if (!ok.has(task.status)) {
      throw new Error(`task ${id} went ${task.status} instead of ${status}: ${task.error ?? ""}`);
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for task ${id} -> ${status} (still ${task.status})`);
    }
    await sleep(150);
  }
}

// Poll task.json until `predicate` holds; returns the matching task.
export async function waitForTaskState(base, id, predicate, { timeout = 30000, label = "state" } = {}) {
  const store = createStore(base);
  const start = Date.now();
  while (true) {
    let task = null;
    try {
      task = await store.findTask(id);
    } catch {
      /* mid-write */
    }
    if (task && predicate(task)) return task;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for task ${id} ${label} (last: ${task?.status ?? "unreadable"})`);
    }
    await sleep(150);
  }
}

// The store bound to a workspace, for one-off assertions.
export function storeOf(base) {
  return createStore(base);
}

// Reset the task's permission decision file, mimicking a fresh run. (The
// worker clears it at start; here it is for explicit control in tests.)
export async function clearPermissionDecision(base, slug) {
  await fs.rm(path.join(base, ".work", "tasks", slug, "permission.json"), { force: true });
}
