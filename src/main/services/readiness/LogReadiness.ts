import type { ReadinessHandle, ReadinessWatcher } from './index';

export function makeLogWatcher(
  pattern: string,
  flags: string | undefined,
  handle: ReadinessHandle
): ReadinessWatcher {
  let disposed = false;
  let resolveReady!: (v: boolean) => void;
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags ?? '');
  } catch (e) {
    // Bad regex - emit a non-ready and let the orchestrator decide.
    queueMicrotask(() => resolveReady(false));
    return { ready, dispose: () => {} };
  }

  const offLog = handle.onLog((chunk) => {
    if (disposed) return;
    if (regex.test(stripAnsi(chunk))) {
      resolveReady(true);
    }
  });

  const offStatus = handle.onStatus((state) => {
    if (disposed) return;
    if (state === 'exited' || state === 'crashed') {
      resolveReady(false);
    }
  });

  return {
    ready,
    dispose: () => {
      disposed = true;
      offLog();
      offStatus();
    }
  };
}

// Tiny ANSI stripper so regexes don't have to anticipate color codes.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
