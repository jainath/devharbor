import { ulid } from 'ulid';
import { db } from '../db/index.js';
import type {
  AppId,
  CommandKind,
  NodeVersionPref,
  PackageManager,
  ReadinessSignal,
  Task,
  TaskId
} from '@shared/types';
import { findCycle } from './topo';

type TaskRow = {
  id: string;
  app_id: string;
  name: string;
  position: number;
  command_kind: string;
  script: string | null;
  custom_command: string | null;
  working_dir_override: string | null;
  package_manager_override: string | null;
  node_version_pref_override: string | null;
  depends_on: string;
  readiness: string;
  one_shot: number;
  enabled: number;
  env_overrides: string;
  created_at: number;
  updated_at: number;
};

export class TaskRegistry {
  list(appId: AppId): Task[] {
    const rows = db()
      .prepare<unknown[], TaskRow>(
        'SELECT * FROM tasks WHERE app_id = ? ORDER BY position ASC, created_at ASC'
      )
      .all(appId);
    return rows.map(rowToTask);
  }

  /**
   * Load every task across every app in a single query, grouped by app id.
   * The boot path needs tasks for all apps at once; doing this as one ordered
   * scan replaces an N+1 of per-app `list()` calls. Rows arrive pre-sorted by
   * (app_id, position, created_at) so each group is already in position order.
   */
  listAll(): Record<string, Task[]> {
    const rows = db()
      .prepare<unknown[], TaskRow>(
        'SELECT * FROM tasks ORDER BY app_id ASC, position ASC, created_at ASC'
      )
      .all();
    const grouped: Record<string, Task[]> = {};
    for (const row of rows) {
      const task = rowToTask(row);
      (grouped[task.appId] ??= []).push(task);
    }
    return grouped;
  }

  get(id: TaskId): Task | null {
    const row = db()
      .prepare<unknown[], TaskRow>('SELECT * FROM tasks WHERE id = ?')
      .get(id);
    return row ? rowToTask(row) : null;
  }

  add(appId: AppId, patch: Partial<Task>): Task {
    const existing = this.list(appId);
    const position = patch.position ?? existing.length;
    const id = (patch.id as TaskId | undefined) ?? (ulid() as TaskId);
    const now = Date.now();
    const task: Task = {
      id,
      appId,
      name: patch.name?.trim() || `task-${existing.length + 1}`,
      position,
      commandKind: patch.commandKind ?? 'script',
      script: patch.script ?? null,
      customCommand: patch.customCommand ?? null,
      workingDirOverride: patch.workingDirOverride ?? null,
      packageManagerOverride: patch.packageManagerOverride ?? null,
      nodeVersionPrefOverride: patch.nodeVersionPrefOverride ?? null,
      dependsOn: patch.dependsOn ?? [],
      readiness: patch.readiness ?? { kind: 'none' },
      oneShot: patch.oneShot ?? false,
      enabled: patch.enabled ?? true,
      envOverrides: patch.envOverrides ?? {},
      createdAt: now,
      updatedAt: now
    };

    this.validateName(appId, task.name, null);
    this.validateOneShot(task);
    this.validateGraphAfter(appId, task, null);

    db()
      .prepare(
        `INSERT INTO tasks
          (id, app_id, name, position, command_kind, script, custom_command,
           working_dir_override, package_manager_override, node_version_pref_override,
           depends_on, readiness, one_shot, enabled, env_overrides, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.appId,
        task.name,
        task.position,
        task.commandKind,
        task.script,
        task.customCommand,
        task.workingDirOverride,
        task.packageManagerOverride,
        task.nodeVersionPrefOverride
          ? JSON.stringify(task.nodeVersionPrefOverride)
          : null,
        JSON.stringify(task.dependsOn),
        JSON.stringify(task.readiness),
        task.oneShot ? 1 : 0,
        task.enabled ? 1 : 0,
        JSON.stringify(task.envOverrides),
        task.createdAt,
        task.updatedAt
      );
    return task;
  }

  update(id: TaskId, patch: Partial<Task>): Task {
    const current = this.get(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    // Phase 7: tasks.env_overrides is frozen - the source of truth is now
    // env_vars rows with task_id set. Ignore any patch.envOverrides so the
    // legacy JSON column can never silently drift from the rows.
    const next: Task = {
      ...current,
      ...patch,
      id: current.id,
      appId: current.appId,
      envOverrides: current.envOverrides,
      updatedAt: Date.now()
    };

    if (next.name !== current.name) this.validateName(next.appId, next.name, current.id);
    this.validateOneShot(next);
    if (
      next.dependsOn !== current.dependsOn ||
      JSON.stringify(next.dependsOn) !== JSON.stringify(current.dependsOn)
    ) {
      this.validateGraphAfter(next.appId, next, current.id);
    }

    db()
      .prepare(
        `UPDATE tasks SET
          name = ?, position = ?, command_kind = ?, script = ?, custom_command = ?,
          working_dir_override = ?, package_manager_override = ?, node_version_pref_override = ?,
          depends_on = ?, readiness = ?, one_shot = ?, enabled = ?, env_overrides = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        next.name,
        next.position,
        next.commandKind,
        next.script,
        next.customCommand,
        next.workingDirOverride,
        next.packageManagerOverride,
        next.nodeVersionPrefOverride
          ? JSON.stringify(next.nodeVersionPrefOverride)
          : null,
        JSON.stringify(next.dependsOn),
        JSON.stringify(next.readiness),
        next.oneShot ? 1 : 0,
        next.enabled ? 1 : 0,
        JSON.stringify(next.envOverrides),
        next.updatedAt,
        next.id
      );
    return next;
  }

  remove(id: TaskId): void {
    const task = this.get(id);
    if (!task) return;
    // If other tasks in the same app depend on this one, surface a clear error.
    const siblings = this.list(task.appId).filter((t) => t.id !== id);
    const dependents = siblings.filter((t) => t.dependsOn.includes(id));
    if (dependents.length > 0) {
      throw new Error(
        `Can't remove "${task.name}" - these tasks depend on it: ${dependents.map((d) => d.name).join(', ')}`
      );
    }
    db().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  reorder(appId: AppId, taskIds: TaskId[]): void {
    const update = db().prepare('UPDATE tasks SET position = ?, updated_at = ? WHERE id = ? AND app_id = ?');
    const tx = db().transaction((ids: TaskId[]) => {
      const now = Date.now();
      ids.forEach((id, idx) => update.run(idx, now, id, appId));
    });
    tx(taskIds);
  }

  private validateName(appId: AppId, name: string, excludeId: TaskId | null): void {
    if (!name.trim()) throw new Error('Task name cannot be empty.');
    const conflict = this.list(appId).find((t) => t.name === name && t.id !== excludeId);
    if (conflict) throw new Error(`A task named "${name}" already exists in this app.`);
  }

  private validateOneShot(t: Task): void {
    if (t.oneShot && t.readiness.kind !== 'exit') {
      throw new Error('One-shot tasks must use readiness "exit".');
    }
  }

  /**
   * Re-run cycle detection on the *new* graph (after the proposed add/update applied).
   * Throws with the cycle path if there is one.
   */
  private validateGraphAfter(appId: AppId, draft: Task, replaceId: TaskId | null): void {
    const all = this.list(appId).filter((t) => t.id !== replaceId);
    all.push(draft);
    const deps = new Map<TaskId, TaskId[]>();
    for (const t of all) deps.set(t.id, t.dependsOn);
    // Validate that all dependsOn entries exist within this app.
    const valid = new Set(all.map((t) => t.id));
    for (const d of draft.dependsOn) {
      if (!valid.has(d)) {
        throw new Error(`Task "${draft.name}" depends on unknown task id: ${d}`);
      }
      if (d === draft.id) {
        throw new Error(`Task "${draft.name}" can't depend on itself.`);
      }
    }
    const cycle = findCycle<TaskId>(
      all.map((t) => t.id),
      deps
    );
    if (cycle) {
      const names = cycle
        .map((cid) => all.find((t) => t.id === cid)?.name ?? cid)
        .join(' → ');
      throw new Error(`Dependency cycle: ${names}`);
    }
  }
}

/**
 * Parse a JSON column defensively. A single hand-edited or corrupt cell must not
 * take down the whole tasks:list query (IMPROVEMENT-PLAN 8.3): a bad row should
 * degrade to its fallback rather than throw and blank out every task in the app.
 * `null` is treated as "absent" and returns the fallback without warning, since
 * NULL is a legitimate empty state for these columns.
 */
function safeJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn('TaskRegistry: ignoring corrupt JSON column, using fallback', err);
    return fallback;
  }
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id as TaskId,
    appId: r.app_id as AppId,
    name: r.name,
    position: r.position,
    commandKind: r.command_kind as CommandKind,
    script: r.script,
    customCommand: r.custom_command,
    workingDirOverride: r.working_dir_override,
    packageManagerOverride: (r.package_manager_override as PackageManager | null) ?? null,
    // Only parse when the column is non-null so the absent case stays null (no warning).
    nodeVersionPrefOverride: r.node_version_pref_override
      ? safeJson<NodeVersionPref | null>(r.node_version_pref_override, null)
      : null,
    dependsOn: safeJson<string[]>(r.depends_on, []).map((s) => s as TaskId),
    readiness: safeJson<ReadinessSignal>(r.readiness, { kind: 'none' }),
    oneShot: !!r.one_shot,
    enabled: !!r.enabled,
    envOverrides: safeJson<Record<string, string>>(r.env_overrides, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
