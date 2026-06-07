import type { ProcessState } from '@shared/types';
import { cn } from '../lib/cn';

/**
 * Single status dot (DevHarbor UI reference): one dot conveys run state.
 *   running           → green + glow + pulse
 *   starting/exiting   → amber, static
 *   crashed            → red, static
 *   idle/exited        → muted gray, no glow
 *
 * The glow/pulse + colors live as `.status-dot*` classes in styles.css so the
 * box-shadow halo and keyframes are reusable and theme-token driven.
 */
export function StatusDot({
  state,
  className
}: {
  state: ProcessState | undefined;
  className?: string;
}): JSX.Element {
  const variant =
    state === 'running'
      ? 'status-dot-run'
      : state === 'starting' || state === 'exiting'
      ? 'status-dot-warn'
      : state === 'crashed'
      ? 'status-dot-danger'
      : 'status-dot-off';
  return <span className={cn('status-dot', variant, className)} title={state ?? 'idle'} />;
}
