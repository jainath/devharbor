import type { ProcessState } from '@shared/types';
import { cn } from '../lib/cn';

/**
 * Single status dot (DevHarbor UI reference): one dot conveys run state.
 *   running           → green + glow + pulse
 *   starting/exiting   → amber, static
 *   crashed            → red, static + ring (non-color cue)
 *   idle/exited        → muted gray, no glow
 *
 * The glow/pulse + colors live as `.status-dot*` classes in styles.css so the
 * box-shadow halo and keyframes are reusable and theme-token driven.
 *
 * Accessibility (11.5): the dot is the only signal for run state, so it carries
 * role="img" + an aria-label rather than a hover-only `title`. Crashed adds a
 * ring outline (via `.status-dot-danger`) so it stays distinguishable from idle
 * for users who can't perceive the red/gray hue difference.
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
  // Non-color cue for crashed: a contrasting outline ring so the state reads as
  // "something is wrong" without depending on the red-vs-gray hue alone. Applied
  // inline (rather than in styles.css) to keep the change scoped to this file.
  const crashedRing =
    state === 'crashed' ? 'ring-1 ring-danger-border ring-offset-1 ring-offset-base' : '';
  const label = state ?? 'idle';
  return (
    <span
      className={cn('status-dot', variant, crashedRing, className)}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
