import type { ReadinessHandle, ReadinessWatcher } from './index';

/**
 * For one-shot tasks. Ready = the process exited with the expected code.
 */
export function makeExitWatcher(
  expectedCode: number,
  handle: ReadinessHandle
): ReadinessWatcher {
  let resolveReady!: (v: boolean) => void;
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });
  let disposed = false;

  const offStatus = handle.onStatus((state, exitCode) => {
    if (disposed) return;
    if (state === 'exited') {
      resolveReady(exitCode === expectedCode);
    } else if (state === 'crashed') {
      resolveReady(exitCode === expectedCode);
    }
  });

  return {
    ready,
    dispose: () => {
      disposed = true;
      offStatus();
    }
  };
}
