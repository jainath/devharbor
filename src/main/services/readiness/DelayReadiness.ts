import type { ReadinessHandle, ReadinessWatcher } from './index';

export function makeDelayWatcher(ms: number, handle: ReadinessHandle): ReadinessWatcher {
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveReady!: (v: boolean) => void;
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });

  timer = setTimeout(() => {
    if (!disposed) resolveReady(true);
  }, Math.max(0, ms));

  const offStatus = handle.onStatus((state) => {
    if (state === 'exited' || state === 'crashed') {
      if (!disposed) resolveReady(false);
    }
  });

  return {
    ready,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      offStatus();
    }
  };
}
