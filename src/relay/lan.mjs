// LAN transport helpers for LAN-first pairing.
//
// The phone and the Mac are on the same local network; `2f pair` exposes a
// one-time pairing surface on the Mac's private LAN interface and the phone
// talks DIRECTLY to the Mac — no relay, no tunnels, no accounts. The same
// pairing client and E2E encrypted channel are reused: the Mac's runtime
// hosts a local instance of the relay protocol (see src/server.mjs), so the
// phone's pair page, session claim, signed pair-hello, encrypted envelopes
// and SSE stream are byte-for-byte the hosted flow — only the transport
// endpoint differs (http://<lan-ip>:<port> instead of a hosted relay).
//
// Security boundary: plain http is accepted ONLY for private-use IPv4 LAN
// ranges (10/8, 172.16/12, 192.168/16) plus loopback — never for public
// addresses — and only as the explicit consequence of `2f pair` (the local
// API itself stays loopback-only; see src/server.mjs).

import os from "node:os";

// Private-use IPv4 ranges (RFC 1918), as integer ranges.
const PRIVATE_RANGES = [
  { min: 0x0a000000, max: 0x0affffff }, // 10.0.0.0/8
  { min: 0xac100000, max: 0xac1fffff }, // 172.16.0.0/12
  { min: 0xc0a80000, max: 0xc0a8ffff } // 192.168.0.0/16
];

export function isPrivateLanIp(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return PRIVATE_RANGES.some(r => n >= r.min && n <= r.max);
}

// The Mac's private LAN IPv4 address, or null. Prefers a non-internal,
// up-to-date IPv4 address in a private range (os.networkInterfaces order).
// `networkInterfaces` is injectable for tests.
export function detectLanAddress(networkInterfaces = os.networkInterfaces) {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface && iface.family === "IPv4" && !iface.internal && isPrivateLanIp(iface.address)) {
        return iface.address;
      }
    }
  }
  return null;
}
