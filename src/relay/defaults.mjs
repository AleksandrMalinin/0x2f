// The hosted 0x2F endpoints `2f pair` uses when no --relay / --client flag is
// given and no prior pairing config exists — the "just run `2f pair`" flow for
// a real phone.
//
// Two origins, on purpose (see deploy/README.md): the relay and the client
// origin are separate HTTPS endpoints, because the E2E guarantee "a
// compromised relay can neither read nor forge phone <-> Mac traffic" holds
// only while the pairing page and the web client are served from an origin
// the relay process does not control. If one service served both, it could
// substitute a pairing page that captures the code the user types and derive
// the E2E key. Both default URLs are https-only; plain HTTP stays blocked for
// anything but explicit loopback (see validateRelayUrl in pair.mjs).
//
// The constants below are the product's hosted endpoints. An operator who
// deploys elsewhere overrides them per-machine (or per-build) with:
//
//   0X2F_RELAY_URL=https://relay.example.com \
//   0X2F_CLIENT_ORIGIN=https://app.example.com \
//   2f pair
//
// --relay / --client still win over everything for development.

export const DEFAULT_RELAY_URL = "https://relay.0x2f.dev";
export const DEFAULT_CLIENT_ORIGIN = "https://app.0x2f.dev";

export function defaultRelayUrl() {
  return (process.env["0X2F_RELAY_URL"] ?? "").trim() || DEFAULT_RELAY_URL;
}

export function defaultClientOrigin() {
  return (process.env["0X2F_CLIENT_ORIGIN"] ?? "").trim() || DEFAULT_CLIENT_ORIGIN;
}
