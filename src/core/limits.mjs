// Input limits — the one place every size cap lives.
//
// Shared actions enforce the text caps so the CLI and the Web API behave
// identically; the API layer enforces the HTTP body cap before any parsing.
// Generous on purpose: these stop unbounded bodies/prompts from becoming
// memory or argv abuse, not normal use.

export const MAX_BODY_BYTES = 1_000_000; // HTTP request body cap (1 MB)
// The task brief — the user's own words, the full engineering task. Same
// tier as a note or an answer, because it is the same KIND of thing: user
// prose. It used to be capped at MAX_TITLE (400), which is a sane cap for a
// label and an absurd one for a brief — dogfooding rejected a real ~1,000
// character security-audit brief on that limit.
export const MAX_BRIEF = 16_000; // task brief characters
// The DERIVED display title (core/title.mjs). Derivation targets ~80
// characters, so this is a storage guard on a value 0x2F computes itself,
// never a limit the user can hit by writing.
export const MAX_TITLE = 400; // task title characters
export const MAX_NOTE = 16_000; // note / constraint characters
export const MAX_ANSWER = 16_000; // decision answer characters
export const MAX_SELECTOR = 200; // provider / model id characters
