import type { ProcessState, Task } from '@shared/types';

/**
 * Shared process-state predicates. These were hand-inlined 16+ times across Sidebar,
 * Dashboard, AppDetail, TaskTabs, CommandPalette and StatusDot; centralising them means a
 * new ProcessState only has to be classified once.
 */

/** "Live" = spawned or transitioning. Gates Stop/Restart affordances. */
export function isLive(state: ProcessState | undefined | null): boolean {
  return state === 'running' || state === 'starting' || state === 'exiting';
}

/** "Active" = started and not yet tearing down. Use where 'exiting' should read as stopping. */
export function isActive(state: ProcessState | undefined | null): boolean {
  return state === 'running' || state === 'starting';
}

/** Last path segment, e.g. /Users/me/proj → "proj". */
export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export interface TaskPortEntry {
  taskId: Task['id'];
  taskName: string;
  ports: number[];
}

/**
 * Per-task port chips for an app, in task display order, skipping tasks with no ports.
 * Shared by the Dashboard cards and the AppDetail header so the two never diverge.
 */
export function buildTaskPortEntries(
  tasks: Task[],
  taskPorts: Record<string, number[]>
): TaskPortEntry[] {
  const out: TaskPortEntry[] = [];
  for (const t of tasks) {
    const ports = taskPorts[t.id] ?? [];
    if (ports.length === 0) continue;
    out.push({ taskId: t.id, taskName: t.name, ports });
  }
  return out;
}
