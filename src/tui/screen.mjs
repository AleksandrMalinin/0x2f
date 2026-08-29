// The frame: a grid of styled cells -> ANSI, and the writer that puts it on
// a terminal.
//
// A CELL is the design's own unit, kept verbatim so the view builders read
// like the handoff:
//
//   { t, c, b, bg, cur }
//     t    the text
//     c    foreground, hex
//     b    weight — 600 renders bold, anything lower renders plain
//     bg   background hex, or "transparent"
//     cur  this cell is the caret (drawn inverse, so it is visible without
//          moving the real terminal cursor, which stays hidden)
//
// `renderFrame` is pure: cells in, array of ANSI strings out. That is what
// lets the entire visual layer be asserted in tests without a tty.

const ESC = "\x1b[";

export const RESET = ESC + "0m";
export const ALT_SCREEN_ON = ESC + "?1049h";
export const ALT_SCREEN_OFF = ESC + "?1049l";
export const CURSOR_HIDE = ESC + "?25l";
export const CURSOR_SHOW = ESC + "?25h";

function hex(value) {
  const s = String(value ?? "").replace("#", "");
  if (s.length !== 6) return null;
  const n = Number.parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 24-bit colour when the terminal advertises it, else the xterm-256 cube.
// Degrading is a rendering concern only — no view builder ever asks which
// mode is in use, so the design's palette is written once.
function cube(v) {
  if (v < 48) return 0;
  if (v < 115) return 1;
  return Math.min(5, Math.round((v - 55) / 40));
}

function to256([r, g, b]) {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    const level = Math.round(((r + g + b) / 3 - 8) / 247 * 24);
    if (level <= 0) return 16;
    if (level >= 24) return 231;
    return 232 + (level - 1);
  }
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
}

export function colorSupport(env = process.env) {
  if (env.NO_COLOR) return "none";
  const colorterm = String(env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = String(env.TERM ?? "");
  if (/-truecolor$/.test(term)) return "truecolor";
  if (term === "dumb" || !term) return "none";
  return "256";
}

function sgrColor(value, background, support) {
  const rgb = hex(value);
  if (!rgb || support === "none") return "";
  const lead = background ? "48" : "38";
  if (support === "truecolor") return `${lead};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  return `${lead};5;${to256(rgb)}`;
}

// One line of cells -> one ANSI string, padded/trimmed to `cols`. Style is
// re-emitted per cell run rather than diffed: a line is at most a few dozen
// runs, and a stateless line cannot inherit a stale colour from the line
// above it.
//
// `bg` is the frame's GROUND, and it is painted under every cell — including
// the trailing pad. A full-screen surface that names its own palette has to
// paint the ground that palette was drawn against: the design's two themes
// specify #161c21 and #f2f4f6 precisely, and the ink colours are contrast-
// tuned against them. Inheriting the terminal's own background instead would
// make the light theme dark ink on a dark ground for anyone whose terminal is
// dark — a theme flag that only works if you already had that theme. The alt
// screen buffer keeps this contained: the user's terminal is untouched the
// moment the session exits.
export function renderLine(cells, cols, opts = {}) {
  const { support = "truecolor", bg = null } = opts;
  let out = "";
  let width = 0;
  for (const cell of cells ?? []) {
    if (width >= cols) break;
    const text = String(cell.t ?? "");
    if (!text.length) continue;
    const room = cols - width;
    const slice = text.length > room ? text.slice(0, room) : text;
    width += slice.length;

    const codes = [];
    if (cell.cur) {
      // The caret: the cell's colour becomes the ground it sits on.
      const ground = sgrColor(cell.c, true, support);
      const ink = sgrColor(bg, false, support);
      if (ground) codes.push(ground);
      if (ink) codes.push(ink);
    } else {
      const fg = sgrColor(cell.c, false, support);
      if (fg) codes.push(fg);
      // A cell's own background (a selected row, the provider chip) wins;
      // everything else sits on the frame's ground.
      const ground = cell.bg && cell.bg !== "transparent" ? cell.bg : bg;
      const back = ground ? sgrColor(ground, true, support) : "";
      if (back) codes.push(back);
      // Weight is styling too: a terminal we are not styling for (NO_COLOR,
      // a dumb TERM, a test asserting on plain text) gets plain text, not
      // text with the colour stripped and the bold left behind.
      if (support !== "none" && Number(cell.b) >= 600) codes.push("1");
    }
    out += codes.length ? ESC + codes.join(";") + "m" + slice + RESET : slice;
  }
  if (width < cols) {
    // The pad is ground too — an unpainted tail would stripe every short
    // line with the terminal's own background.
    const pad = " ".repeat(cols - width);
    const back = bg ? sgrColor(bg, true, support) : "";
    out += back ? ESC + back + "m" + pad + RESET : pad;
  }
  return out;
}

// A whole frame: `lines` is [{ cells }], one per terminal row.
export function renderFrame(lines, cols, rows, opts = {}) {
  const out = [];
  for (let i = 0; i < rows; i++) {
    out.push(renderLine(lines[i]?.cells ?? [], cols, opts));
  }
  return out;
}

// Puts frames on a stream, rewriting only the rows that changed. Full
// repaints are reserved for the first frame and for a resize — a resized
// terminal has no meaningful previous frame to diff against.
export function createPainter(stream, opts = {}) {
  const support = opts.support ?? colorSupport();
  let previous = [];
  let lastCols = 0;
  let lastRows = 0;

  return {
    support,
    paint(lines, cols, rows, frameOpts = {}) {
      const next = renderFrame(lines, cols, rows, { support, ...frameOpts });
      const resized = cols !== lastCols || rows !== lastRows;
      let out = "";
      if (resized) {
        out += ESC + "2J";
        previous = [];
      }
      for (let i = 0; i < next.length; i++) {
        if (!resized && previous[i] === next[i]) continue;
        out += ESC + (i + 1) + ";1H" + next[i];
      }
      previous = next;
      lastCols = cols;
      lastRows = rows;
      if (out) stream.write(out + RESET);
      return next;
    },
    reset() {
      previous = [];
      lastCols = 0;
      lastRows = 0;
    }
  };
}
