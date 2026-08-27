#!/usr/bin/env node
// 0x2F TUI — visual review pipeline.
//
// Reuses the deterministic PTY golden-path suite's driver
// (test/tui-pty/driver.mjs + fake ACP agents) to capture a small FIXED set
// of representative terminal frames from the REAL `2f tui`, writes them in a
// stable normalized form (scrubbed plain text + colored SVG + an HTML
// gallery), checks each frame with objective structural invariants, and —
// OPTIONALLY — hands the frames to an installed Claude or DeepSeek reviewer
// for qualitative visual findings.
//
// It is deliberately NOT part of `npm test`: it never runs during the normal
// suite, and the AI reviewer is optional — with none configured, the report
// still marks every frame PASS or with concrete structural findings.
//
// Usage:
//   npm run review:tui                 # capture + local checks + AI if available
//   npm run review:tui -- --no-ai      # capture + local checks only
//   npm run review:tui -- --ai claude  # force the Claude Code CLI reviewer
//   npm run review:tui -- --ai deepseek# force `dsh --profile headless`
//   npm run review:tui -- --strict     # exit 1 when the AI reports findings too
//   npm run review:tui -- --keep       # keep the scratch workspaces
//
// Reviewer contract (both backends): the frames are inlined in the prompt as
// fixed-width text, the prompt restricts the review to the visual categories
// below and forbids any file modification, and the reviewer runs with cwd
// inside `.review/` so no repository tree is reachable. The reviewer must
// return a JSON object; the response is parsed and merged into the report,
// never trusted as code.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  startTui,
  makeWorkspace,
  storeOf,
  sleep
} from "../test/tui-pty/driver.mjs";
import { applyOutcome, closeTask } from "../src/core/lifecycle.mjs";
import { palette } from "../src/tui/theme.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(REPO, ".review");
const FRAMES_DIR = path.join(OUT_DIR, "frames");

const P = palette("dark"); // the frames are captured in the default dark theme

// --- flags ----------------------------------------------------------------------

function flag(name) {
  return process.argv.indexOf(name) >= 0;
}
function value(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const AI_MODE = flag("--no-ai") ? "none" : value("--ai", "auto");
const STRICT = flag("--strict");
const KEEP = flag("--keep");

// --- deterministic capture ------------------------------------------------------

const BRIEF = [
  "Inspect the submit path and add retry handling",
  "Use whole seconds for Retry-After.",
  "Cover the offline queue."
];

const LONG_QUESTION = [
  "Which cache strategy should the ingest pipeline adopt for multi-region writes?",
  "The pipeline currently writes through a single-region Redis with a local read-through layer; the new multi-region topology means a writer in eu-west-1 must see what a writer in us-east-1 just committed within seconds.",
  "Option A: a global logical clock with per-region caches and an invalidation bus — reads are always local, but the bus adds a failure mode and replay complexity for at-least-once delivery.",
  "Option B: a single cross-region Redis (Basic Tier) with automatic failover — one source of truth, higher write latency to the primary region, and a hard dependency on the region pair staying healthy.",
  "Option C: no cache; serve reads from the source of record with read replicas per region — simplest, correct, and the cost of a replica read is roughly what the cache was saving.",
  "The team is split: two prefer A for latency, one prefers B for operational simplicity, and the on-call rotation leans C because it removes an entire class of stale-read bugs.",
  "The decision is binding on this task: it changes which files we touch, so pick one and say why in the result."
].join("\n");

// --- frame normalization ----------------------------------------------------------
//
// The screen is captured as the emulator's cell grid at the CURRENT frame
// size, padded to a perfect rectangle. Nondeterministic content (the live
// clock, elapsed durations, the progress percentage, the machine hostname) is
// scrubbed with LENGTH-PRESERVING replacements so the frame stays a stable,
// diffable artifact and every review inspects the same layout. The scratch
// workspace is created with the fixed label "ws" (see makeWorkspace name) so
// its path never appears.

function scrubRow(row) {
  let s = row;
  // header clock HH:MM:SS
  s = s.replace(/\d{2}:\d{2}:\d{2}/g, "00:00:00");
  // elapsed durations M:SS / MM:SS (after the clock, so it never hits it)
  s = s.replace(/\d+:\d{2}/g, m => {
    const [a, b] = m.split(":");
    return "0".repeat(a.length) + ":" + "0".repeat(b.length);
  });
  // progress percentage (working rule readout)
  s = s.replace(/\d+%/g, m => "0".repeat(m.length - 1) + "%");
  // machine hostname in the ON row ("<host> · ws")
  s = s.replace(/\b([A-Za-z0-9][A-Za-z0-9.-]*) · ws\b/g, (m, host) => "H".repeat(host.length) + " · ws");
  return s;
}

const frames = [];
const framesByDir = new Map();

async function capture(session, id, { state, mode = "work" }) {
  await sleep(160); // let the latest paint settle on the wire
  const term = session.term;
  // The frame's own painted dimensions. Rows can carry stale blank tails
  // from a previous, wider frame (a resize repaints cells but the emulator
  // grid rows keep their old length), so each row is sliced to the frame
  // width — the frame is exactly what the current paint wrote.
  const cols = term.width();
  const rows = term.height();
  const rawRows = [];
  const styleRows = [];
  for (let r = 0; r < rows; r++) {
    const row = (term.row(r) ?? "").slice(0, cols).padEnd(cols, " ");
    rawRows.push(row);
    const styles = [];
    for (let c = 0; c < cols; c++) {
      const style = term.styles?.[r]?.[c] ?? null;
      styles.push(style && (style.fg || style.bg) ? style : null);
    }
    styleRows.push(styles);
  }
  const scrubbed = rawRows.map(scrubRow);

  const txt = buildTxt(id, state, mode, cols, rows, scrubbed);
  const svg = buildSvg(scrubbed, styleRows, cols, rows);
  const frame = { id, state, mode, cols, rows, scrubbed, styleRows, txt, svg };
  frames.push(frame);
  framesByDir.set(id, frame);
  await Promise.all([
    fs.writeFile(path.join(FRAMES_DIR, id + ".txt"), txt),
    fs.writeFile(path.join(FRAMES_DIR, id + ".svg"), svg)
  ]);
  console.log(`captured ${id} (${state}, ${cols}x${rows})`);
  return frame;
}

function buildTxt(id, state, mode, cols, rows, scrubbed) {
  const head = [
    "# 0x2F TUI frame — " + id,
    "# state: " + state + "   mode: " + mode + "   terminal: " + cols + "x" + rows,
    "# captured from `2f tui` on a real PTY with deterministic fake providers",
    "# timestamps, durations, machine hostname and scratch paths are scrubbed for stability",
    ""
  ];
  return head.join("\n") + scrubbed.join("\n") + "\n";
}

function xml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Colored SVG at fixed cell metrics — a deterministic rendering of the same
// cells a real terminal would show, independent of any developer's font or
// screenshot tooling.
function buildSvg(scrubbed, styleRows, cols, rows) {
  const CW = 8;
  const CH = 15;
  const W = cols * CW;
  const H = rows * CH;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="12">`,
    `<title>0x2F TUI frame — ${cols}x${rows}</title>`,
    `<rect width="${W}" height="${H}" fill="${P.bg}"/>`
  ];
  for (let r = 0; r < rows; r++) {
    const row = scrubbed[r] ?? "";
    const styles = styleRows[r] ?? [];
    const y = r * CH + CH - 4;
    let runStart = 0;
    let runStyle = null;
    const flush = end => {
      if (end <= runStart) return;
      const text = row.slice(runStart, end);
      const style = runStyle ?? {};
      const bg = style.bg ?? P.bg;
      const fg = style.fg ?? P.fg;
      const x = runStart * CW;
      out.push(
        `<rect x="${x}" y="${r * CH}" width="${(end - runStart) * CW}" height="${CH}" fill="${bg}"/>`,
        `<text x="${x}" y="${y}" fill="${fg}"${style.bold ? ' font-weight="700"' : ""}>${xml(text)}</text>`
      );
    };
    for (let c = 0; c < cols; c++) {
      const key = runStyle ? `${runStyle.fg}|${runStyle.bg}|${runStyle.bold}` : "";
      const next = styles[c] ?? null;
      const nextKey = next ? `${next.fg}|${next.bg}|${next.bold}` : "";
      if (key !== nextKey) {
        flush(c);
        runStart = c;
        runStyle = next;
      }
    }
    flush(cols);
  }
  out.push("</svg>");
  return out.join("\n");
}

function buildGallery() {
  const out = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>0x2F TUI — captured frames</title>',
    "<style>",
    "body{background:#10151a;color:#e2e8ee;font-family:ui-monospace,Menlo,monospace;margin:2rem}",
    "h1{font-size:1.4rem} h2{font-size:1rem;color:#8fb2ee}",
    ".frame{margin:2rem 0} svg{display:block;background:#161c21;border:1px solid #39434b;max-width:100%;height:auto}",
    "</style></head><body><h1>0x2F TUI — captured frames</h1>"
  ];
  for (const frame of frames) {
    out.push(
      `<div class="frame"><h2>${frame.id} — ${frame.state} (${frame.cols}x${frame.rows})</h2>`,
      frame.svg,
      "</div>"
    );
  }
  out.push("</body></html>");
  return out.join("\n");
}

// --- scenarios -------------------------------------------------------------------

async function quit(session) {
  session.press("q");
  await session.waitForText(/detached\./, { timeout: 10000, label: "the detach frame" });
  const outcome = await session.waitForExit({ timeout: 10000 });
  if (outcome.code !== 0) throw new Error("the TUI exited " + outcome.code + " on q");
}

async function scenarioJourney() {
  const { base, markers } = await makeWorkspace({ name: "ws" });
  const session = await startTui({ workspace: base, cols: 120, rows: 36 });
  try {
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });

    // composer — a typed multi-line brief.
    session.press("n");
    await session.waitForText(/NEW TASK/, { label: "the composer" });
    session.type(BRIEF[0]);
    session.press("ctrl-n");
    session.type(BRIEF[1]);
    session.press("ctrl-n");
    session.type(BRIEF[2]);
    await session.waitForText(/Use whole seconds for Retry-After\./, { label: "the typed brief" });
    await capture(session, "composer-120x36", { state: "composer", mode: "composer" });

    // Create the task.
    session.press("enter");
    await session.waitForText(/#001 opened · run 1 on ALPHA/, { label: "the create flash" });

    // WORKING — inside the fake agent's 2s permission window. Wait for the
    // run's first real activity so the trace is populated, not empty.
    await session.waitForText(/WORKING/, { label: "the WORKING group" });
    await session.waitForText(/executing/, { label: "the detail state word" });
    await session.waitForText(/src\/app\.ts/, { label: "the reported file change" });
    await capture(session, "working-120x36", { state: "working", mode: "work" });

    // NEEDS YOU — live permission.
    await session.waitForText(/NEEDS YOU · PERMISSION/, { timeout: 15000, label: "the permission halt" });
    await capture(session, "needs-you-permission-120x36", { state: "permission", mode: "work" });

    // ALLOW -> READY.
    session.press("enter");
    await session.waitForText(/complete · awaiting you/, { label: "the ready detail" });
    await capture(session, "ready-120x36", { state: "ready", mode: "work" });

    // CHANGES / the real diff.
    session.press("d");
    await session.waitForText(/working tree vs HEAD/, { label: "the loaded diff" });
    await capture(session, "diff-120x36", { state: "ready-diff", mode: "diff" });
    session.press("escape");
    await session.waitForText(/complete · awaiting you/, { label: "back to the work frame" });

    // SEND BACK -> DECISION.
    session.press("x");
    await session.waitForText(/SEND BACK/, { label: "the send-back input" });
    session.type(markers.correction);
    session.press("enter");
    await session.waitForText(/NEEDS YOU · DECISION/, { timeout: 15000, label: "the decision halt" });
    await capture(session, "decision-120x36", { state: "decision", mode: "work" });

    // help — in the work frame (the composer would type it into the brief).
    session.press("?");
    await session.waitForText(/KEYS/, { label: "the help frame" });
    await capture(session, "help-120x36", { state: "help", mode: "help" });
    session.press("escape");
    await session.waitForText(/NEEDS YOU · DECISION/, { label: "back to the work frame" });

    await quit(session);
    return { base };
  } catch (error) {
    session.kill();
    await session.waitForExit({ timeout: 3000 }).catch(() => {});
    throw error;
  }
}

async function scenarioFailed() {
  const { base } = await makeWorkspace({ name: "ws", routingDefault: "bravo" });
  const session = await startTui({ workspace: base, cols: 120, rows: 36 });
  try {
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
    session.press("n");
    await session.waitForText(/NEW TASK/, { label: "the composer" });
    session.type("Re-authenticate the ingest worker");
    session.press("enter");
    await session.waitForText(/FAILED/, { timeout: 20000, label: "the FAILED group" });
    await session.waitForText(/authentication is no longer valid/, { label: "the auth band" });
    await capture(session, "failed-auth-120x36", { state: "failed-auth", mode: "work" });
    await quit(session);
    return { base };
  } catch (error) {
    session.kill();
    await session.waitForExit({ timeout: 3000 }).catch(() => {});
    throw error;
  }
}

async function seedOverview(base) {
  const store = storeOf(base);
  const specs = [];
  // needs — the LAST one is the long-question decision, which gives it the
  // highest id in the group, so the cursor lands on it first.
  specs.push({ title: "dedupe ingest", status: "needs_you", blockedOn: { type: "decision", text: "Which retry policy?" } });
  specs.push({ title: "rate-limit headers", status: "needs_you", blockedOn: { type: "permission", tool: "Edit", file: path.join(base, "src", "app.ts"), live: false } });
  specs.push({ title: "flaky retry", status: "needs_you", blockedOn: { type: "permission", tool: "Edit", file: path.join(base, "src", "app.ts"), live: false } });
  specs.push({ title: "queue backoff", status: "needs_you", blockedOn: { type: "decision", text: "Which backoff schedule?" } });
  specs.push({ title: "multi-region cache strategy", status: "needs_you", blockedOn: { type: "decision", text: LONG_QUESTION } });
  specs.push({ title: "retry storm", status: "failed", error: "exit 1" });
  specs.push({ title: "bad gateway", status: "failed", error: "exit 1" });
  specs.push({ title: "auth replay", status: "failed", error: "Authentication failed: invalid API key (401 expired)." });
  specs.push({ title: "timeout drift", status: "failed", error: "exit 1" });
  for (const title of ["strip paths", "dedupe events", "truncate logs", "pin versions", "cache keys", "sort runs"]) {
    specs.push({ title, status: "ready" });
  }
  for (const title of ["audit auth", "migrate store", "backfill queue", "index events", "rotate keys", "rename columns"]) {
    specs.push({ title, status: "working" });
  }
  for (const title of ["fix typos", "update readme", "add tests", "bump deps", "remove dead code"]) {
    specs.push({ title, status: "done" });
  }
  for (const spec of specs) {
    const task = await store.createTask(
      { title: spec.title, brief: spec.title, prompt: spec.title },
      { provider: "claude-code" }
    );
    let updated = task;
    if (spec.status === "needs_you") {
      updated = applyOutcome(task, { status: "needs_you", blockedOn: spec.blockedOn });
    } else if (spec.status === "ready") {
      updated = applyOutcome(task, { status: "ready", result: "done" });
    } else if (spec.status === "failed") {
      updated = applyOutcome(task, { status: "failed", error: spec.error });
    } else if (spec.status === "done") {
      updated = closeTask(task);
    }
    await store.updateTask(updated);
  }
}

async function scenarioOverview() {
  const { base } = await makeWorkspace({ name: "ws", providerRoles: {}, routingDefault: "auto" });
  await seedOverview(base);
  const session = await startTui({ workspace: base, cols: 120, rows: 36 });
  try {
    await session.waitForText(/0x2F/, { timeout: 15000, label: "the product frame" });
    await session.waitForText(/multi-region cache strategy/, { label: "the selected task" });

    // The populated overview — the cursor sits on the long decision.
    await capture(session, "overview-many-120x36", { state: "overview", mode: "work" });

    // The long question, scrolled: the detail shows the question body and
    // the scroll indicator.
    session.press("J");
    session.press("J");
    session.press("J");
    await sleep(250);
    await capture(session, "decision-long-120x36", { state: "decision-long", mode: "work" });

    // A constrained terminal: resize and capture the same states.
    session.resize(24, 80);
    await session.waitForFrame(24, 80);
    await capture(session, "overview-many-80x24", { state: "overview", mode: "work" });
    session.press("J");
    session.press("J");
    await sleep(250);
    await capture(session, "decision-long-80x24", { state: "decision-long", mode: "work" });

    await quit(session);
    return { base };
  } catch (error) {
    session.kill();
    await session.waitForExit({ timeout: 3000 }).catch(() => {});
    throw error;
  }
}

// --- objective local checks --------------------------------------------------------
//
// Always run — deterministic structural invariants that catch real layout
// regressions without any model. The AI reviewer (when present) adds the
// qualitative layer on top.

const EXPECT = {
  "composer-120x36": { cols: 120, rows: 36, mode: "composer", landmarks: ["NEW TASK", "↵ START", "ALPHA"], focus: 0 },
  "help-120x36": { cols: 120, rows: 36, mode: "help", landmarks: ["KEYS", "a TASK is permanent", "any key"], focus: 0 },
  "working-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["WORKING", "executing"], focus: 1 },
  "needs-you-permission-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["NEEDS YOU · PERMISSION", "ALLOW", "REJECT", "src/app.ts"], focus: 1 },
  "ready-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["complete · awaiting you", "ACCEPT", "SEND BACK"], focus: 1 },
  "diff-120x36": { cols: 120, rows: 36, mode: "diff", landmarks: ["CHANGES", "working tree vs HEAD", "retry with backoff"], focus: 0 },
  "decision-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["NEEDS YOU · DECISION", "ANSWER & CONTINUE", "503 policy"], focus: 1 },
  "failed-auth-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["FAILED", "authentication is no longer valid", "RETRY"], focus: 1 },
  "overview-many-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["! 5", "✕ 4", "✓ 6", "▶ 6", "· 5", "NEEDS YOU", "FAILED"], focus: 1 },
  "decision-long-120x36": { cols: 120, rows: 36, mode: "work", landmarks: ["NEEDS YOU · DECISION", "multi-region", "J K"], focus: 1 },
  "overview-many-80x24": { cols: 80, rows: 24, mode: "work", landmarks: ["! 5", "✕ 4", "· 5", "NEEDS YOU", "0x2F", "…"], focus: 1 },
  "decision-long-80x24": { cols: 80, rows: 24, mode: "work", landmarks: ["multi-region", "ANSWER & CONTINUE"], focus: 1 }
};

function runChecks(frame, expect) {
  const findings = [];
  const text = frame.scrubbed.join("\n");

  // The frame filled the terminal at the size this scenario was captured at.
  if (frame.cols !== expect.cols || frame.rows !== expect.rows) {
    findings.push(`frame painted ${frame.cols}x${frame.rows}, expected ${expect.cols}x${expect.rows}`);
  }
  for (let r = 0; r < frame.rows; r++) {
    if (frame.scrubbed[r].length !== frame.cols) {
      findings.push(`row ${r} is ${frame.scrubbed[r].length} wide, expected ${frame.cols}`);
      break;
    }
  }

  // No control characters / ANSI leaks / lone surrogates in the grid.
  for (let r = 0; r < frame.rows; r++) {
    for (const ch of frame.scrubbed[r]) {
      const code = ch.codePointAt(0);
      if (code < 32 || code === 127 || code === 0xfffd) {
        findings.push(`control/odd character ${JSON.stringify(ch)} at row ${r}`);
        break;
      }
      if (ch === "\u001b") {
        findings.push(`ANSI escape leaked into the grid at row ${r}`);
        break;
      }
    }
    if (findings.length) break;
  }

  // Content present.
  const nonBlank = frame.scrubbed.filter(row => row.trim().length).length;
  if (nonBlank < 5) findings.push(`frame is nearly empty (${nonBlank} non-blank rows)`);

  // Landmarks.
  for (const landmark of expect.landmarks) {
    if (!text.includes(landmark)) findings.push(`missing landmark ${JSON.stringify(landmark)}`);
  }

  // Focus marker: exactly one selected row in work-mode frames with a task.
  const caret = (text.match(/❯/g) ?? []).length;
  if (caret !== expect.focus) {
    findings.push(`focus marker count is ${caret}, expected ${expect.focus}`);
  }

  // The last row (hint) is painted — the footer never scrolls away. The
  // composer mode carries its own hint inside the frame, so only check the
  // footer hint for the framed modes.
  if (expect.mode !== "composer") {
    const lastRow = frame.scrubbed[frame.rows - 1] ?? "";
    if (!lastRow.trim().length) findings.push("the footer hint row is blank");
  }

  return findings;
}

// --- the AI reviewer ---------------------------------------------------------------

const REVIEW_PROMPT = `You are a visual regression reviewer for a terminal user interface (a TUI). You review ONLY the visual/UI quality of rendered terminal frames. You do NOT review code, you do NOT suggest features, you do NOT redesign the interface, and you do NOT modify any files: this is a strictly read-only review of the frames below.

Focus only on these visual categories:
- overflow: content extends beyond its pane or the terminal edge
- clipping: content is cut off with no indication that more exists
- broken grid alignment: columns or rows misaligned, ragged edges
- poor visual hierarchy: the important line (status, the pinned action) is not visually distinct from secondary text
- unreadable truncation: text cut mid-word without an ellipsis marker
- focus/selection ambiguity: it is not clear which ledger row is selected
- inconsistent spacing: uneven gaps within a pane
- behavior at narrow sizes: the 80x24 frames specifically

Each frame below is a monospace terminal capture: a fixed-width grid of exactly W columns and H rows (rows are padded with spaces to W). The frame id names the state. The separator "│" splits the left ledger pane from the right detail pane; the last three rows are a fixed footer (a rule, a message line, a hint line).

For EVERY frame reply with a verdict. Reply with ONLY a JSON object of this exact shape:
{"frames":[{"id":"<frame id>","verdict":"PASS"|"FINDINGS","findings":["<concrete issue, 1-2 sentences, quoting the offending line>"]}]}
A frame that is genuinely fine gets verdict PASS and an empty findings list. Findings must be concrete and observable in the frame; do not invent issues, and never suggest new features or a redesign.`;

function buildReviewPrompt(frames) {
  const blocks = frames.map(frame => {
    const body = frame.scrubbed.map(row => row.replace(/\s+$/, "")).join("\n");
    return `### ${frame.id} — ${frame.state} (${frame.cols}x${frame.rows})\n\`\`\`\n${body}\n\`\`\``;
  });
  return REVIEW_PROMPT + "\n\n" + blocks.join("\n\n");
}

function runCommand(bin, args, { cwd, timeoutMs = 300000, env = {} } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ok: false, error: error.message, out: "", err: "" });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", c => (out += c.toString()));
    child.stderr.on("data", c => (err += c.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, out, err });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err });
    });
  });
}

function executableOnPath(bin) {
  if (bin.includes("/") || bin.includes("\\")) {
    try {
      fsSync.accessSync(bin, fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some(dir => {
    try {
      fsSync.accessSync(path.join(dir, bin), fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function detectBackend(forced) {
  if (forced === "none") return null;
  if (forced === "claude" || forced === "deepseek") return forced;
  if (process.env.CLAUDE_BIN ? executableOnPath(process.env.CLAUDE_BIN) : executableOnPath("claude")) return "claude";
  if (process.env.DSH_BIN ? executableOnPath(process.env.DSH_BIN) : executableOnPath("dsh")) return "deepseek";
  return null;
}

async function runReviewer(backend, prompt) {
  // The reviewer runs with cwd inside `.review/` — no repository tree is
  // reachable, and the frames are inline so no tools are needed at all.
  if (backend === "claude") {
    const bin = process.env.CLAUDE_BIN ?? "claude";
    console.log(`review: running Claude Code CLI (${bin}) — read-only, ${frames.length} frames inline`);
    const result = await runCommand(bin, ["-p", prompt, "--disallowedTools", "Edit,Write,MultiEdit,Bash,NotebookEdit"], { cwd: OUT_DIR });
    return { ...result, label: "claude" };
  }
  if (backend === "deepseek") {
    const bin = process.env.DSH_BIN ?? "dsh";
    console.log(`review: running DeepSeek Harness (${bin} --profile headless) — read-only, ${frames.length} frames inline`);
    const result = await runCommand(bin, ["--profile", "headless", prompt], { cwd: OUT_DIR });
    return { ...result, label: "deepseek" };
  }
  return { ok: false, error: "no reviewer backend", label: null };
}

// Extract the JSON object from the model's reply — models occasionally wrap
// it in prose or a code fence despite the instruction.
function parseReviewJson(text) {
  let t = String(text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* not clean JSON — fall through */
    }
  }
  return null;
}

// --- the report --------------------------------------------------------------------

async function writeReport({ reviewer, aiStatus, aiNote, aiRaw, localFailures, aiFindingsCount, summary }) {
  const lines = [
    "# 0x2F TUI — visual review",
    "",
    `- frames captured: ${frames.length}`,
    `- AI reviewer: ${reviewer ?? "none (skipped — configure claude or dsh, or --ai claude/--ai deepseek)"}${aiNote ? " — " + aiNote : ""}`,
    `- local structural checks: ${localFailures} failure${localFailures === 1 ? "" : "s"}`,
    `- AI findings: ${aiFindingsCount}`,
    "- captured " + new Date().toISOString(),
    "",
    "## verdicts",
    "",
    "| frame | state | size | verdict |",
    "|---|---|---|---|",
  ];
  for (const frame of frames) {
    lines.push(`| ${frame.id} | ${frame.state} | ${frame.cols}x${frame.rows} | ${frame.verdict} |`);
  }

  lines.push("", "## findings", "");
  let any = false;
  for (const frame of frames) {
    if (!frame.checks.length && !frame.aiFindings.length) continue;
    any = true;
    lines.push(`### ${frame.id}`);
    for (const finding of frame.checks) lines.push(`- [check] ${finding}`);
    for (const finding of frame.aiFindings) lines.push(`- [ai] ${finding}`);
    lines.push("");
  }
  if (!any) lines.push("_No findings._", "");

  if (aiRaw) {
    lines.push("## reviewer raw reply", "");
    lines.push("```");
    lines.push(String(aiRaw).slice(0, 4000));
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "## frames",
    "",
    `- gallery: \`${path.relative(REPO, path.join(FRAMES_DIR, "index.html"))}\``,
    `- normalized text: \`.review/frames/<id>.txt\` (scrubbed, fixed-width)`,
    `- colored SVG: \`.review/frames/<id>.svg\` (fixed cell metrics)`,
    "",
    "## re-run",
    "",
    "```bash",
    "npm run review:tui                # capture + local checks + AI if available",
    "npm run review:tui -- --no-ai     # capture + local checks only",
    "npm run review:tui -- --ai claude # force the Claude Code CLI reviewer",
    "npm run review:tui -- --ai deepseek",
    "```"
  );

  await fs.writeFile(path.join(OUT_DIR, "report.md"), lines.join("\n") + "\n");

  const json = {
    capturedAt: new Date().toISOString(),
    reviewer,
    aiStatus,
    frames: frames.map(frame => ({
      id: frame.id,
      state: frame.state,
      mode: frame.mode,
      cols: frame.cols,
      rows: frame.rows,
      verdict: frame.verdict,
      checks: frame.checks,
      aiVerdict: frame.aiVerdict,
      aiFindings: frame.aiFindings,
      txt: `.review/frames/${frame.id}.txt`,
      svg: `.review/frames/${frame.id}.svg`
    }))
  };
  await fs.writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(json, null, 2) + "\n");
  return summary;
}

// --- main ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  const bases = [];

  try {
    console.log("0x2F TUI visual review — capturing deterministic frames");
    console.log("frames →", FRAMES_DIR);

    const journey = await scenarioJourney();
    if (journey.base) bases.push(journey.base);
    const failed = await scenarioFailed();
    if (failed.base) bases.push(failed.base);
    const overview = await scenarioOverview();
    if (overview.base) bases.push(overview.base);

    // The gallery + manifest.
    await fs.writeFile(path.join(FRAMES_DIR, "index.html"), buildGallery());
    await fs.writeFile(
      path.join(FRAMES_DIR, "manifest.json"),
      JSON.stringify(
        {
          frames: frames.map(frame => ({
            id: frame.id,
            state: frame.state,
            mode: frame.mode,
            cols: frame.cols,
            rows: frame.rows,
            txt: frame.id + ".txt",
            svg: frame.id + ".svg"
          }))
        },
        null,
        2
      ) + "\n"
    );

    // Local checks.
    for (const frame of frames) {
      const expect = EXPECT[frame.id] ?? { landmarks: [], focus: -1 };
      frame.checks = runChecks(frame, expect);
      frame.verdict = frame.checks.length ? "FAIL" : "PASS";
      frame.aiVerdict = null;
      frame.aiFindings = [];
      const word = frame.checks.length ? "FAIL" : "PASS";
      console.log(`check ${frame.id}: ${word}${frame.checks.length ? " — " + frame.checks.join("; ") : ""}`);
    }

    // Optional AI review.
    const backend = detectBackend(AI_MODE);
    let reviewer = null;
    let aiStatus = "skipped";
    let aiNote = null;
    let aiRaw = null;
    let aiFindingsCount = 0;
    if (backend) {
      const prompt = buildReviewPrompt(frames);
      const result = await runReviewer(backend, prompt);
      reviewer = result.label;
      if (!result.ok) {
        aiStatus = "failed";
        aiNote =
          result.error ??
          (result.code === null
            ? "killed before finishing (timeout or signal)"
            : `exit ${result.code}`);
        if (result.err) aiNote += " — " + result.err.trim().slice(0, 300);
        console.warn(`review: AI review failed (${aiNote}) — continuing with local checks only`);
      } else {
        aiStatus = "ok";
        aiRaw = result.out;
        const parsed = parseReviewJson(result.out);
        if (parsed && Array.isArray(parsed.frames)) {
          const byId = new Map(frames.map(frame => [frame.id, frame]));
          for (const item of parsed.frames) {
            const frame = byId.get(String(item.id ?? ""));
            if (!frame) continue;
            frame.aiVerdict = item.verdict === "FINDINGS" ? "FINDINGS" : "PASS";
            frame.aiFindings = Array.isArray(item.findings) ? item.findings.map(String) : [];
            aiFindingsCount += frame.aiFindings.length;
            if (frame.aiVerdict === "FINDINGS" && frame.verdict === "PASS") frame.verdict = "FINDINGS";
          }
          const reviewed = parsed.frames.filter(item => byId.has(String(item.id ?? ""))).length;
          console.log(`review: ${backend} reviewed ${reviewed}/${frames.length} frames, ${aiFindingsCount} findings`);
        } else {
          aiNote = "reply did not parse as JSON — raw reply kept in the report";
          console.warn("review: AI reply did not parse as JSON — raw reply kept in the report");
        }
      }
    } else if (AI_MODE !== "none") {
      console.log("review: no Claude or DeepSeek reviewer found on PATH — skipping AI review (local checks still run)");
    }

    // Report + exit code.
    const localFailures = frames.filter(frame => frame.verdict === "FAIL").length;
    const findingsFrames = frames.filter(frame => frame.verdict === "FINDINGS").length;
    await writeReport({
      reviewer,
      aiStatus,
      aiNote,
      aiRaw,
      localFailures,
      aiFindingsCount,
      summary: null
    });

    console.log("");
    console.log(`report → ${path.join(OUT_DIR, "report.md")}`);
    console.log(`frames  → ${FRAMES_DIR} (gallery: index.html)`);
    console.log(
      `verdicts: ${frames.length} frames · ${localFailures} FAIL · ${findingsFrames} FINDINGS · ` +
        `${frames.length - localFailures - findingsFrames} PASS`
    );

    if (localFailures > 0) {
      console.error(`\nVISUAL REVIEW FAILED: ${localFailures} frame(s) failed structural checks.`);
      return 1;
    }
    if (STRICT && findingsFrames > 0) {
      console.error(`\nSTRICT: ${findingsFrames} frame(s) with AI findings.`);
      return 1;
    }
    return 0;
  } finally {
    if (!KEEP) {
      // Each workspace lives at <tmp-parent>/ws; remove the parent (which
      // covers the workspace). A just-exited relay/worker can hold the
      // directory for a moment, so retry briefly.
      for (const base of bases) {
        const parent = path.dirname(base);
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fs.rm(parent, { recursive: true, force: true });
            break;
          } catch {
            await sleep(250);
          }
        }
      }
    }
  }
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(`\nREVIEW FAILED: ${error.message}`);
  process.exitCode = 1;
});
