// TUI palettes and provider identity — presentation only.
//
// The colours are the finalized TUI design's two palettes, verbatim. They
// are deliberately NOT src/web/ledger.mjs's COLORS: that palette is tuned
// for a white browser page, and the terminal's dark ground needs its own.
// What both surfaces DO share is the meaning behind a colour (accent =
// wants you, bad = failed, ok = ready), which lives in the state model, not
// here.

export const PALETTES = {
  dark: {
    bg: "#161c21",
    fg: "#e2e8ee",
    dim: "#96a1aa",
    rule: "#39434b",
    accent: "#8fb2ee",
    ok: "#7ac9a5",
    bad: "#e79274",
    sel: "#232c34",
    ghost: "#5d6870"
  },
  light: {
    bg: "#f2f4f6",
    fg: "#10161c",
    dim: "#4d5760",
    rule: "#c4ccd3",
    accent: "#1f4f9e",
    ok: "#1c6b4e",
    bad: "#a33a1e",
    sel: "#dfe6ed",
    ghost: "#98a3ac"
  }
};

export function palette(theme) {
  return PALETTES[theme] ?? PALETTES.dark;
}

// --- provider identity -------------------------------------------------------
//
// The ledger row has room for two characters of provider, not twelve. The
// design fixes signatures for the four native providers; a configured
// (ACP/command manifest) provider gets a derived one, because the TUI must
// be provider-agnostic — it may not have a table of every provider that can
// ever exist.
const NATIVE_SIGNATURES = {
  "claude-code": "CC",
  "deepseek-harness": "DS",
  codex: "CX",
  gemini: "GM"
};

// Initials of a two-word name ("Acme Agent" -> "AA"), else the first two
// letters of the id. Always exactly two characters, always upper case.
export function providerSignature(id, displayName = "") {
  if (!id) return "??";
  if (NATIVE_SIGNATURES[id]) return NATIVE_SIGNATURES[id];
  const words = String(displayName || id)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const sig =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : String(words[0] ?? id).slice(0, 2);
  return sig.toUpperCase().padEnd(2, "·").slice(0, 2);
}

// The name the ledger prints beside the signature. Upper case is the TUI's
// register for identity, the same way the Web ledger uppercases run rows.
export function providerName(id, displayName = "") {
  return String(displayName || id || "unknown").toUpperCase();
}
