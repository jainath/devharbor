/**
 * Request gatekeeping for the MCP HTTP listener (see specs/07-mcp-server.md).
 *
 * Pure functions over header strings - no electron/db imports - so the DNS-rebinding and
 * auth logic unit-tests under plain node.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// Exact hostname equality only. A suffix or substring test would wave through
// `localhost.evil.com` / `127.0.0.1.evil.com`, which is precisely the DNS-rebinding
// trick the check exists to stop.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Strip a trailing `:port` from a Host header value, keeping IPv6 brackets intact:
 * `127.0.0.1:6872` → `127.0.0.1`, `[::1]:6872` → `[::1]`, `[::1]` → `[::1]`.
 */
function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** Is the Host header's hostname exactly a loopback name? Missing header fails closed. */
export function hostHeaderAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK_HOSTNAMES.has(hostWithoutPort(host.trim().toLowerCase()));
}

/** Exact-match loopback hostname check (for a URL's `hostname`, already port-stripped). */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Origin policy: no Origin header (non-browser client) passes; a present Origin must
 * parse and have a loopback hostname (MCP Inspector runs on localhost and sends one).
 * Anything else - including the literal string "null" a sandboxed iframe sends - fails.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin == null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/**
 * Constant-time bearer check. Both sides are sha256-hashed to equal-length buffers first:
 * `timingSafeEqual` THROWS on length mismatch (and the client controls the presented
 * length), while a length pre-check would leak the token's length. Hash-then-compare
 * sidesteps both.
 */
export function bearerMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header || !expectedToken) return false;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m || !m[1]) return false;
  const presented = createHash('sha256').update(m[1]).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(presented, expected);
}
