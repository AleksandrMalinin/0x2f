// Input limits — the one place every size cap lives.
//
// Shared actions enforce the text caps so the CLI and the Web API behave
// identically; the API layer enforces the HTTP body cap before any parsing.
// Generous on purpose: these stop unbounded bodies/prompts from becoming
// memory or argv abuse, not normal use.

export const MAX_BODY_BYTES = 1_000_000; // HTTP request body cap (1 MB)
export const MAX_TITLE = 400; // task title characters
export const MAX_NOTE = 16_000; // note / constraint characters
export const MAX_ANSWER = 16_000; // decision answer characters
export const MAX_SELECTOR = 200; // provider / model id characters
