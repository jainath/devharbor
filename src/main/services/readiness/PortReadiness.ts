import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReadinessHandle, ReadinessWatcher } from './index';

const execFileP = promisify(execFile);
const POLL_MS = 500;

/**
 * Ready when the task's process group is listening on `port`.
 * Uses lsof to enumerate listen sockets and matches by parent PID.
 */
export function makePortWatcher(port: number, handle: ReadinessHandle): ReadinessWatcher {
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

  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      const listening = await listListeningPidsOnPort(port);
      if (await pidGroupIncludes(handle.pid, listening)) {
        if (!disposed) resolveReady(true);
        return;
      }
    } catch {
      // lsof can transiently fail; just keep polling.
    }
    if (!disposed) setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);

  return {
    ready,
    dispose: () => {
      disposed = true;
      offStatus();
    }
  };
}

async function listListeningPidsOnPort(port: number): Promise<Set<number>> {
  // -n no DNS, -P no port name resolution, -iTCP only TCP, -sTCP:LISTEN listen state.
  // Output one line per matching listen socket: "<pid>". We use `-Fp` (field 'p') to
  // get just the pid lines.
  try {
    const { stdout } = await execFileP('lsof', [
      '-nP',
      '-iTCP:' + port,
      '-sTCP:LISTEN',
      '-Fp'
    ]);
    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('p')) {
        const n = Number.parseInt(line.slice(1), 10);
        if (!Number.isNaN(n)) pids.add(n);
      }
    }
    return pids;
  } catch (e) {
    // lsof exits 1 when nothing matches — that's "not yet listening", not an error.
    const err = e as { code?: number; stdout?: string };
    if (typeof err.code === 'number' && err.code === 1) return new Set();
    throw e;
  }
}

/**
 * True if `pid` (the parent we spawned) is an ancestor of any of `pids`.
 * We follow ppid via `ps -o ppid= -p <pid>`.
 */
async function pidGroupIncludes(parent: number, pids: Set<number>): Promise<boolean> {
  if (pids.size === 0) return false;
  if (pids.has(parent)) return true;
  // Build child→parent map for each candidate.
  for (const candidate of pids) {
    let cur = candidate;
    let safety = 8;
    while (safety-- > 0) {
      const ppid = await getPpid(cur);
      if (ppid == null || ppid <= 1) break;
      if (ppid === parent) return true;
      cur = ppid;
    }
  }
  return false;
}

async function getPpid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}
