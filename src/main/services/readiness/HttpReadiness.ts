import http from 'node:http';
import https from 'node:https';
import type { ReadinessHandle, ReadinessWatcher } from './index';

const POLL_MS = 700;
const REQUEST_TIMEOUT_MS = 2500;

/**
 * Ready when an HTTP GET to `url` returns the expected status (default: any 2xx or 3xx).
 *
 * This is the signal for a service that binds its port BEFORE it can actually serve - e.g.
 * an API that opens :4000 while Postgres/Redis are still connecting. A port probe would call
 * it ready too early; hitting its /ready endpoint does not. Loopback dev servers over HTTPS
 * are typically self-signed, so TLS is not certificate-verified here (the readiness URL is
 * operator-configured and points at localhost).
 */
export function makeHttpWatcher(
  url: string,
  expectStatus: number | undefined,
  handle: ReadinessHandle
): ReadinessWatcher {
  let disposed = false;
  let resolveReady!: (v: boolean) => void;
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });

  const offStatus = handle.onStatus((state) => {
    if (state === 'exited' || state === 'crashed') {
      if (!disposed) resolveReady(false);
    }
  });

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null; // invalid URL: never fires; the readiness timeout will clear the spinner
  }
  // Only skip TLS verification for a loopback target (self-signed dev certs). The MCP
  // set_readiness tool already restricts to loopback; a URL set via the UI could point
  // elsewhere, and for those we verify certs normally rather than blanket-trusting.
  const loopback =
    !!parsed && ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase());

  const schedule = (): void => {
    if (!disposed) setTimeout(check, POLL_MS);
  };

  const check = (): void => {
    if (disposed || !parsed) {
      if (!disposed) schedule();
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      parsed,
      { timeout: REQUEST_TIMEOUT_MS, rejectUnauthorized: !loopback } as https.RequestOptions,
      (res) => {
        res.resume(); // drain the body so the socket frees
        const code = res.statusCode ?? 0;
        const ok = expectStatus != null ? code === expectStatus : code >= 200 && code < 400;
        if (ok) {
          if (!disposed) resolveReady(true);
        } else {
          schedule();
        }
      }
    );
    req.on('error', () => schedule());
    req.on('timeout', () => req.destroy());
  };

  setTimeout(check, POLL_MS);

  return {
    ready,
    dispose: () => {
      disposed = true;
      offStatus();
    }
  };
}
