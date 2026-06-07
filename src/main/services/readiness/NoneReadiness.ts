import type { ReadinessWatcher } from './index';

export function makeNoneWatcher(): ReadinessWatcher {
  return {
    ready: Promise.resolve(true),
    dispose: () => {}
  };
}
