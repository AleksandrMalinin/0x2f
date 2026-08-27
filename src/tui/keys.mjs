// Raw stdin bytes -> key names. Pure, so the whole input path is testable
// without a terminal.
//
// One chunk from a raw-mode tty is one key press (or one paste). That is
// what makes ESC unambiguous: a lone "\x1b" chunk is the Escape key, while
// "\x1b" FOLLOWED by more bytes in the SAME chunk is a modifier prefix —
// either an escape sequence (arrows, shift-tab) or Alt+<key>, which is how
// terminals deliver ⌥↵. A timing-based ESC disambiguator would add latency
// to the most-pressed key in the design's keymap; the chunk boundary the tty
// already gives us is both faster and simpler.
//
// A decoded key is { name, ch?, alt?, ctrl? }:
//
//   name  "char" | "enter" | "escape" | "backspace" | "tab" | "shift-tab"
//         | "up" | "down" | "left" | "right" | "ctrl-c" | "unknown"
//   ch    the character, for name === "char"

const SEQUENCES = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[Z": "shift-tab",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left"
};

// Shift+Enter, when the terminal can deliver it. Kitty sends the CSI-u form,
// xterm with modifyOtherKeys the CSI~ form, and some emitters the alternate
// ordering; in all three, modifier 2 is Shift and the code is 13 (Enter).
// Default macOS Terminal and stock Windows Terminal send the same byte as
// plain Enter, so ⌃n stays the universal fallback — a terminal that cannot
// distinguish the two simply never produces these bytes.
const SHIFT_ENTER = new Set([
  "\u001b[13;2u", // Kitty keyboard protocol / CSI-u
  "\u001b[27;2;13~", // xterm modifyOtherKeys
  "\u001b[27;2;13u" // alternate ordering some emitters use
]);

function simple(code) {
  if (code === 3) return { name: "ctrl-c" };
  if (code === 13 || code === 10) return { name: "enter" };
  if (code === 9) return { name: "tab" };
  if (code === 127 || code === 8) return { name: "backspace" };
  return null;
}

// Decode ONE chunk into the keys it represents. A chunk is normally one key;
// a paste is many characters, which decode to a run of "char" keys so typing
// and pasting behave identically in an input line.
export function decodeKeys(chunk) {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (!text.length) return [];

  if (text === "\x1b") return [{ name: "escape" }];

  if (text.charCodeAt(0) === 0x1b && text.length > 1) {
    if (SHIFT_ENTER.has(text)) return [{ name: "enter", shift: true }];
    const rest = text.slice(1);
    const named = SEQUENCES[rest.slice(0, 2)];
    if (named) return [{ name: named }];
    // Anything else after ESC in the same chunk is Alt+<key>: ⌥↵ (the
    // design's "expand this note into a brief"), ⌥<char>, and so on.
    const first = simple(rest.charCodeAt(0));
    if (first) return [{ ...first, alt: true }];
    if (rest.length === 1) return [{ name: "char", ch: rest, alt: true }];
    return [{ name: "unknown" }];
  }

  const keys = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const named = simple(code);
    if (named) {
      keys.push(named);
      continue;
    }
    // Ctrl+<letter> arrives as the control code; the design uses Ctrl+N
    // (newline in the composer — the fallback when the terminal cannot send
    // ⇧↵) and Ctrl+Z (revert the brief).
    if (code < 32) {
      keys.push({ name: "char", ch: String.fromCharCode(code + 96), ctrl: true });
      continue;
    }
    keys.push({ name: "char", ch });
  }
  return keys;
}

// Is this key a plain printable character (no modifier)? The single test
// every text-entry path makes before appending to a draft.
export function isPrintable(key) {
  return key.name === "char" && !key.ctrl && !key.alt && key.ch >= " " && key.ch !== "\x7f";
}
