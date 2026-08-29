// Shared path helpers — pure string functions, browser-safe (served at
// /core/paths.mjs for the web client, imported directly by Node code).
//
// The ONLY thing here is canonicalization of repository-relative path
// strings. Two providers (or a provider and the repository observer) can
// name the same logical file differently — "src/foo.mjs" vs "./src/foo.mjs"
// vs "src/./foo.mjs" — and an aggregate changed-file list must count that
// as ONE file. Canonicalization is lexical and safe: it never touches the
// filesystem, never resolves symlinks, and never turns a relative path into
// an absolute one.

// Collapse "./" prefixes, interior "." segments and redundant separators;
// resolve ".." lexically without ever escaping the first path segment
// (a leading ".." is preserved rather than silently promoting to an
// absolute parent — an out-of-repository path must stay visibly relative).
export function canonicalPath(value) {
  const s = String(value ?? "");
  if (!s) return s;
  // Preserve the absolute marker so the relay can still decide whether an
  // absolute path lives inside the workspace.
  const absolute = s.startsWith("/");
  const segments = s.split("/");
  const out = [];
  for (const part of segments) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Never escape above the repository root: a leading ".." (or a ".."
      // that would pop the last root-level segment) is kept as-is.
      if (out.length > 0 && out[0] !== "..") out.pop();
      else out.push(part);
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return absolute ? "/" + joined : joined;
}
