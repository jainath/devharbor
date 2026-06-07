import type { ProcessState, ReadinessSignal } from '@shared/types';

/**
 * A watcher inspects a running task and resolves once it judges the task "ready"
 * (whatever that means for its signal kind). The owner unsubscribes via `dispose()`
 * regardless of whether `ready` has resolved.
 */
export interface ReadinessWatcher {
  /** Resolves with `true` when the signal fires, or `false` if the task exited first. */
  readonly ready: Promise<boolean>;
  dispose(): void;
}

export interface ReadinessHandle {
  pid: number;
  onLog(listener: (chunk: string) => void): () => void;
  onStatus(listener: (state: ProcessState, exitCode: number | null) => void): () => void;
}

import { makeNoneWatcher } from './NoneReadiness';
import { makePortWatcher } from './PortReadiness';
import { makeLogWatcher } from './LogReadiness';
import { makeExitWatcher } from './ExitReadiness';
import { makeDelayWatcher } from './DelayReadiness';

export function createReadinessWatcher(
  signal: ReadinessSignal,
  handle: ReadinessHandle
): ReadinessWatcher {
  switch (signal.kind) {
    case 'none':
      return makeNoneWatcher();
    case 'port':
      return makePortWatcher(signal.port, handle);
    case 'log':
      return makeLogWatcher(signal.regex, signal.flags, handle);
    case 'exit':
      return makeExitWatcher(signal.code ?? 0, handle);
    case 'delay':
      return makeDelayWatcher(signal.ms, handle);
  }
}
