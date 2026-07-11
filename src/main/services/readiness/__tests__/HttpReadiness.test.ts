import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { makeHttpWatcher } from '../HttpReadiness';
import type { ReadinessHandle } from '../index';

/** A ReadinessHandle whose onStatus we can fire; onLog is unused by the http watcher. */
function fakeHandle(): { handle: ReadinessHandle; exit: () => void } {
  let statusListener: ((state: 'exited' | 'crashed', code: number | null) => void) | null = null;
  const handle: ReadinessHandle = {
    pid: 1234,
    onLog: () => () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onStatus: (l: any) => {
      statusListener = l;
      return () => {
        statusListener = null;
      };
    }
  };
  return { handle, exit: () => statusListener?.('exited', 0) };
}

describe('makeHttpWatcher', () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  function serverReturning(getStatus: () => number): Promise<{ url: string; setStatus: (n: number) => void }> {
    let status = getStatus();
    const server = http.createServer((_req, res) => {
      res.writeHead(status);
      res.end('ok');
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        resolve({ url: `http://127.0.0.1:${port}/ready`, setStatus: (n) => (status = n) });
      });
    });
  }

  it('resolves true once the endpoint returns 2xx', async () => {
    const { url } = await serverReturning(() => 200);
    const { handle } = fakeHandle();
    const w = makeHttpWatcher(url, undefined, handle);
    expect(await w.ready).toBe(true);
    w.dispose();
  }, 10_000);

  it('waits for a 503-then-200 flip (service warming up)', async () => {
    const { url, setStatus } = await serverReturning(() => 503);
    const { handle } = fakeHandle();
    const w = makeHttpWatcher(url, undefined, handle);
    setTimeout(() => setStatus(200), 900);
    expect(await w.ready).toBe(true);
    w.dispose();
  }, 10_000);

  it('honors an explicit expected status', async () => {
    const { url } = await serverReturning(() => 204);
    const { handle } = fakeHandle();
    const w = makeHttpWatcher(url, 204, handle);
    expect(await w.ready).toBe(true);
    w.dispose();
    // A 200 would NOT satisfy expectStatus 204.
    const { url: url2 } = await serverReturning(() => 200);
    const { handle: h2, exit } = fakeHandle();
    const w2 = makeHttpWatcher(url2, 204, h2);
    exit(); // task dies before the (never-matching) probe succeeds
    expect(await w2.ready).toBe(false);
    w2.dispose();
  }, 10_000);

  it('resolves false when the task exits before readiness', async () => {
    // Nothing listening on this port; the probe keeps failing until the task exits.
    const { handle, exit } = fakeHandle();
    const w = makeHttpWatcher('http://127.0.0.1:1/never', undefined, handle);
    setTimeout(exit, 300);
    expect(await w.ready).toBe(false);
    w.dispose();
  }, 10_000);
});
