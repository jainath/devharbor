import type { App } from '@shared/types';

/** How the app list is ordered in the Sidebar and Dashboard (shared preference). */
export type AppSortMode = 'name' | 'recent' | 'running';

export const APP_SORT_KEY = 'devharbor:app-sort';

const byName = (a: App, b: App): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Return a sorted copy of `apps`. 'name' is the stable default (never reorders on
 * start/edit); 'recent' (by lastStartedAt) and 'running' (live apps first) are opt-ins that
 * intentionally reorder. Name is always the tiebreaker so ordering is deterministic.
 */
export function sortApps(
  apps: App[],
  mode: AppSortMode,
  isRunning: (id: string) => boolean
): App[] {
  return [...apps].sort((a, b) => {
    if (mode === 'recent') {
      const d = (b.lastStartedAt ?? -Infinity) - (a.lastStartedAt ?? -Infinity);
      return d !== 0 ? d : byName(a, b);
    }
    if (mode === 'running') {
      const ra = isRunning(a.id) ? 0 : 1;
      const rb = isRunning(b.id) ? 0 : 1;
      return ra !== rb ? ra - rb : byName(a, b);
    }
    return byName(a, b);
  });
}
