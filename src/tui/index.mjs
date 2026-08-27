// `2f tui` — the terminal surface's session.
//
// This is the only file in src/tui that touches the outside world: raw-mode
// stdin, the alternate screen buffer, resize, and the live refresh. It owns
// no Work state and no layout; it drives the pure pieces around it.
//
//   stdin  -> keys.decodeKeys -> app.key -> state.apply -> core/actions
//   disk   -> core/events.createTailer  -> app.refresh
//   both   -> app.frame -> screen.createPainter -> stdout
//
// Live updates come from the SAME event logs the Web server tails, read
// through store.readEventLogs(). That is what makes the TUI a peer rather
// than a viewer: a run finishing in a detached worker, a `2f allow` typed in
// another terminal and a click in the Web UI all land here, and an action
// taken HERE lands in all of them.

import { createRuntime } from "../runtime.mjs";
import { createTailer } from "../core/events.mjs";
import { decodeKeys } from "./keys.mjs";
import { createApp } from "./app.mjs";
import {
  createPainter,
  ALT_SCREEN_ON,
  ALT_SCREEN_OFF,
  CURSOR_HIDE,
  CURSOR_SHOW,
  RESET
} from "./screen.mjs";

export class TuiError extends Error {
  constructor(message) {
    super(message);
    this.name = "TuiError";
  }
}

// The clock has to tick even when nothing happens: a running task's elapsed
// time and the ledger's wall clock are both live values.
const TICK_MS = 1000;
// New event-log lines are cheap to notice and worth noticing quickly — this
// is the same interval the Web server's tailer uses.
const TAIL_MS = 250;

export async function runTui(opts = {}) {
  const base = opts.base ?? process.cwd();
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  if (!opts.force && !output.isTTY) {
    throw new TuiError(
      "2f tui needs an interactive terminal. Use `2f status` for a one-shot list, or `2f ui` for the Web client."
    );
  }
  if (!opts.force && !input.isTTY) {
    throw new TuiError(
      "2f tui needs an interactive terminal — stdin is not a tty (piped input or a non-interactive shell)."
    );
  }

  const runtime = opts.runtime ?? createRuntime(base);
  const app = createApp(runtime, { theme: opts.theme });
  const painter = createPainter(output);

  let stopped = false;
  let pending = null;

  const size = () => ({
    cols: output.columns || 132,
    rows: output.rows || 38
  });

  const draw = () => {
    if (stopped || !app.model) return;
    const { cols, rows } = size();
    const built = app.frame({ cols, rows });
    painter.paint(built.lines, cols, rows, { bg: built.bg });
  };

  // Coalesce refreshes: a busy run can append many events in one tick, and
  // redrawing per line would be all cost and no information.
  const scheduleRefresh = () => {
    if (stopped || pending) return;
    pending = setTimeout(async () => {
      pending = null;
      try {
        await app.refresh();
        draw();
      } catch {
        // A transient read error (a task directory mid-write) is not worth
        // tearing the session down for — the next tick reads it again.
      }
    }, 60);
    pending.unref?.();
  };

  const tailer = createTailer({
    readLines: () => runtime.store.readEventLogs(),
    emit: scheduleRefresh,
    interval: TAIL_MS
  });

  const onResize = () => {
    painter.reset();
    draw();
  };

  const onKey = async chunk => {
    if (stopped) return;
    for (const key of decodeKeys(chunk)) {
      const before = app.state.mode;
      await app.key(key);
      if (app.state.mode === "quit") {
        // The design's quit is a DETACH: runs keep executing without you.
        // Show the frame that says so, then leave.
        draw();
        if (before === "quit") return stop();
        setTimeout(stop, 450).unref?.();
        return;
      }
      draw();
    }
  };

  let done;
  const finished = new Promise(resolve => {
    done = resolve;
  });

  function restore() {
    try {
      input.setRawMode?.(false);
    } catch {
      /* the tty may already be gone */
    }
    input.pause?.();
    input.off?.("data", onKey);
    output.off?.("resize", onResize);
    output.write(RESET + CURSOR_SHOW + ALT_SCREEN_OFF);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (pending) clearTimeout(pending);
    clearInterval(ticker);
    tailer.stop();
    app.dispose();
    restore();
    done();
  }

  const ticker = setInterval(draw, TICK_MS);
  ticker.unref?.();

  output.write(ALT_SCREEN_ON + CURSOR_HIDE);
  input.setRawMode?.(true);
  input.resume?.();
  input.setEncoding?.("utf8");
  input.on("data", onKey);
  output.on("resize", onResize);

  // Restore the terminal even on the paths that skip `stop`: a TUI that
  // leaves a raw-mode tty with a hidden cursor behind has broken the shell
  // the user came from.
  const onExit = () => restore();
  process.once("exit", onExit);
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGHUP", () => {
    stop();
    process.exit(0);
  });

  await app.refresh();
  draw();
  tailer.start();

  await finished;
  process.off("exit", onExit);
  return { stopped: true };
}
