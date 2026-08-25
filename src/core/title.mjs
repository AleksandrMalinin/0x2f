// Task title derivation — the brief a human wrote -> the label a list shows.
//
// A Task carries ONE piece of user text: the brief (`task.brief`), the
// user's own words, verbatim. What a ledger row, a queue line, a tab title
// or a notification needs is a short label, and that label is DERIVED from
// the brief — never a second thing the user has to write, and never a
// separate field in a form.
//
// Deterministic on purpose: no model call. Title derivation runs on the task
// CREATE path, so a model call would make task creation fail whenever a
// provider's auth expires (exactly the §01 failure the dogfood review just
// fixed), would cost a run's latency before the run starts, and would make
// the same brief produce different titles on different days. The rule below
// works because engineers already write briefs summary-first — the same
// observation that lets a decision question split into heading + body
// (`firstSentence` in web/ledger.mjs, which does the related but distinct
// job of splitting agent prose for rendering rather than cutting a label).
//
// This module is imported by BOTH Node (core/actions.mjs, which persists the
// derived title) and the browser (web/ledger.mjs, which decides whether a
// detail view still needs to show the brief). The relative specifier
// "../core/title.mjs" resolves in Node and — because src/server.mjs serves
// this file at /core/title.mjs — in the browser too, exactly like
// web/e2e.mjs's import of ../relay/protocol.mjs. One rule, one
// implementation, no drift between what is stored and what is rendered.

// The length a derived title aims for. Not a hard cap — MAX_TITLE in
// limits.mjs remains the storage guard. This is the point past which a label
// stops being scannable in a list column.
export const TITLE_TARGET = 80;

// Leading markdown decoration on the brief's first line. A brief pasted from
// a doc or an issue often opens with "# ", "- ", "1. " or "> "; none of that
// is part of the sentence a human reads as the title.
const DECORATION_RE = /^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)+/;

// Sentence terminators. A Latin one must be followed by whitespace or the
// end — so a version like "v0.5.2" never splits a title mid-number. CJK
// terminators (。！？) are not followed by a space, so they end a sentence on
// their own.
const TERMINATOR_RE = /[.?!](?=\s|$)|[。！？]/g;

// Whether the word ending at a Latin period is an abbreviation rather than
// the end of a sentence: "e.g.", "i.e.", "U.S." all carry an internal
// period, and a lone initial ("A.") is one letter. Without this, the title
// for "Use e.g. the shared helper" would be the useless fragment "Use e.g.".
function isAbbreviation(text, index) {
  const start = text.lastIndexOf(" ", index) + 1;
  const word = text.slice(start, index); // the word without its final period
  return word.includes(".") || word.length <= 1;
}

// The brief's opening sentence — the first terminator that genuinely ends
// one. Falls back to the whole line when it contains no sentence break.
function firstSentenceOf(line) {
  TERMINATOR_RE.lastIndex = 0;
  let match;
  while ((match = TERMINATOR_RE.exec(line)) !== null) {
    const isLatin = /[.?!]/.test(match[0]);
    if (isLatin && match[0] === "." && isAbbreviation(line, match.index)) continue;
    return line.slice(0, match.index + match[0].length);
  }
  return line;
}

// Below this, a word-boundary cut would throw away too much of the budget —
// take the hard cut instead (a long unbroken token, or a script that does
// not separate words with spaces).
const MIN_WORD_CUT = Math.floor(TITLE_TARGET * 0.6);

function stripDecoration(line) {
  return line.replace(DECORATION_RE, "");
}

function collapse(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

// The brief reduced to a single comparable line: the first line's decoration
// removed (the same rule the title applies), everything joined, whitespace
// collapsed. This is what "the title fully represents the brief" is measured
// against — never a raw string comparison against the brief itself, which
// would call a title incomplete merely because the brief said "# " first or
// wrapped across two lines.
export function normalizeBrief(brief) {
  const lines = String(brief ?? "").split("\n");
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return "";
  return collapse([stripDecoration(lines[first]), ...lines.slice(first + 1)].join(" "));
}

// Cut to at most `max` characters, preferring the last word boundary so a
// title never ends mid-word. Appends the truncation marker.
function cutAtWord(text, max) {
  const slice = text.slice(0, max);
  const space = slice.lastIndexOf(" ");
  const cut = space >= MIN_WORD_CUT ? slice.slice(0, space) : slice;
  return cut.replace(/[\s,;:—-]+$/, "") + "…";
}

// deriveTitle(brief) -> { title, complete }
//
//   title     the short display label
//   complete  true when the title IS the whole normalized brief — i.e. a
//             detail view showing the brief underneath would only repeat
//             what the heading already said. Callers use this instead of a
//             `brief !== title` inequality, which is wrong whenever the
//             brief carried markdown decoration or a line wrap.
//
// An empty/blank brief yields { title: "", complete: true }; callers reject
// a blank brief before this (createWork requires one).
export function deriveTitle(brief) {
  const lines = String(brief ?? "").split("\n");
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return { title: "", complete: true };

  const opening = collapse(stripDecoration(lines[first]));
  const sentence = firstSentenceOf(opening);

  if (sentence.length <= TITLE_TARGET) {
    // Only a title that was neither shortened by the sentence split nor by
    // truncation can represent the whole brief.
    return { title: sentence, complete: sentence === normalizeBrief(brief) };
  }
  // Truncated: by definition there is more brief than the title shows.
  return { title: cutAtWord(sentence, TITLE_TARGET), complete: false };
}

// briefBody(brief) -> the prose a detail view renders UNDER the derived
// heading, or "" when the heading already said everything.
//
// When the title is the brief's opening sentence, the body is the REST —
// the same heading + body split the decision card uses for an agent's
// question (web/app.js renderDecisionQuestion), and the reason a detail view
// never prints the heading sentence twice. Line structure after the opening
// is preserved untouched, so lists and paragraphs in a pasted brief survive.
//
// A TRUNCATED title is not a clean prefix of anything (it ends mid-sentence
// with "…"), so there the whole brief renders: re-reading the full opening
// sentence is what the reader needs, not a body starting mid-thought.
export function briefBody(brief) {
  const raw = String(brief ?? "");
  const { title, complete } = deriveTitle(raw);
  if (!title || complete) return "";
  if (title.endsWith("…")) return raw.trim();

  const lines = raw.split("\n");
  const first = lines.findIndex(line => line.trim());
  const opening = collapse(stripDecoration(lines[first]));
  if (firstSentenceOf(opening) !== title) return raw.trim();

  const remainder = opening.slice(title.length).trim();
  return [...(remainder ? [remainder] : []), ...lines.slice(first + 1)].join("\n").trim();
}
