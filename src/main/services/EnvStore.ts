import { ulid } from 'ulid';
import { db } from '../db/index.js';
import type { AppId, EnvVar, TaskId } from '@shared/types';

type EnvRow = {
  id: string;
  app_id: string | null;
  task_id: string | null;
  key: string;
  value: string;
  enabled: number;
  is_secret: number;
  note: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * CRUD on the layered env_vars table.
 *
 * Three scopes since Phase 7:
 *   global → app_id IS NULL AND task_id IS NULL
 *   app    → app_id = ?      AND task_id IS NULL
 *   task   → task_id = ?                            (app_id denormalised for cascade)
 *
 * Replace-semantics on save: callers send the full desired set of vars for a scope.
 */
export class EnvStore {
  /** Set of taskIds whose env_overrides JSON has already been migrated this process. */
  private readonly backfilledTasks = new Set<string>();

  getGlobal(): EnvVar[] {
    return this.listGlobal();
  }

  getApp(appId: AppId): EnvVar[] {
    return this.listApp(appId);
  }

  getTask(taskId: TaskId): EnvVar[] {
    this.ensureTaskBackfilled(taskId);
    return this.listTask(taskId);
  }

  setGlobal(vars: EnvVar[]): void {
    this.replaceGlobal(vars);
  }

  setApp(appId: AppId, vars: EnvVar[]): void {
    this.replaceApp(appId, vars);
  }

  setTask(taskId: TaskId, vars: EnvVar[]): void {
    this.ensureTaskBackfilled(taskId);
    this.replaceTask(taskId, vars);
  }

  private listGlobal(): EnvVar[] {
    return db()
      .prepare<unknown[], EnvRow>(
        `SELECT * FROM env_vars WHERE app_id IS NULL AND task_id IS NULL ORDER BY key ASC`
      )
      .all()
      .map(rowToEnvVar);
  }

  private listApp(appId: AppId): EnvVar[] {
    return db()
      .prepare<unknown[], EnvRow>(
        `SELECT * FROM env_vars WHERE app_id = ? AND task_id IS NULL ORDER BY key ASC`
      )
      .all(appId)
      .map(rowToEnvVar);
  }

  private listTask(taskId: TaskId): EnvVar[] {
    return db()
      .prepare<unknown[], EnvRow>(
        `SELECT * FROM env_vars WHERE task_id = ? ORDER BY key ASC`
      )
      .all(taskId)
      .map(rowToEnvVar);
  }

  private replaceGlobal(incoming: EnvVar[]): void {
    const deleteAll = db().prepare(
      `DELETE FROM env_vars WHERE app_id IS NULL AND task_id IS NULL`
    );
    this.replaceTx(
      () => deleteAll.run(),
      incoming,
      { appId: null, taskId: null }
    );
  }

  private replaceApp(appId: AppId, incoming: EnvVar[]): void {
    const deleteAll = db().prepare(
      `DELETE FROM env_vars WHERE app_id = ? AND task_id IS NULL`
    );
    this.replaceTx(
      () => deleteAll.run(appId),
      incoming,
      { appId, taskId: null }
    );
  }

  private replaceTask(taskId: TaskId, incoming: EnvVar[]): void {
    // Look up the task's app_id so we can denormalise it for cascade-on-app-delete.
    const row = db()
      .prepare<unknown[], { app_id: string }>(`SELECT app_id FROM tasks WHERE id = ?`)
      .get(taskId);
    if (!row) throw new Error(`Task ${taskId} not found`);
    const appId = row.app_id as AppId;
    const deleteAll = db().prepare(`DELETE FROM env_vars WHERE task_id = ?`);
    this.replaceTx(
      () => deleteAll.run(taskId),
      incoming,
      { appId, taskId }
    );
  }

  private replaceTx(
    runDelete: () => void,
    incoming: EnvVar[],
    scope: { appId: AppId | null; taskId: TaskId | null }
  ): void {
    const now = Date.now();
    const insert = db().prepare(
      `INSERT INTO env_vars (id, app_id, task_id, key, value, enabled, is_secret, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db().transaction(() => {
      runDelete();
      const seenKeys = new Set<string>();
      for (const v of incoming) {
        const key = v.key.trim();
        if (!key) continue;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        insert.run(
          v.id || ulid(),
          scope.appId,
          scope.taskId,
          key,
          v.value ?? '',
          v.enabled ? 1 : 0,
          v.isSecret ? 1 : 0,
          v.note ?? null,
          now,
          now
        );
      }
    });
    tx();
  }

  /**
   * One-time migration of tasks.env_overrides JSON into env_vars rows.
   *
   * Idempotent: if the task already has any rows in env_vars (task_id = ?) we assume
   * it's already migrated and skip. We also remember the taskId in-memory so we don't
   * re-check on every call within one process lifetime.
   */
  private ensureTaskBackfilled(taskId: TaskId): void {
    if (this.backfilledTasks.has(taskId)) return;
    const existing = db()
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM env_vars WHERE task_id = ?`
      )
      .get(taskId);
    if (existing && existing.n > 0) {
      this.backfilledTasks.add(taskId);
      return;
    }
    const row = db()
      .prepare<unknown[], { app_id: string; env_overrides: string }>(
        `SELECT app_id, env_overrides FROM tasks WHERE id = ?`
      )
      .get(taskId);
    if (!row || !row.env_overrides) {
      this.backfilledTasks.add(taskId);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.env_overrides) as Record<string, unknown>;
    } catch {
      this.backfilledTasks.add(taskId);
      return;
    }
    const entries = Object.entries(parsed).filter(([, v]) => typeof v === 'string');
    if (entries.length === 0) {
      this.backfilledTasks.add(taskId);
      return;
    }
    const incoming: EnvVar[] = entries.map(([k, v]) => ({
      id: ulid(),
      appId: row.app_id as AppId,
      key: k,
      value: v as string,
      enabled: true,
      isSecret: /SECRET|TOKEN|PASSWORD|KEY|PRIVATE/i.test(k)
    }));
    this.replaceTask(taskId, incoming);
    this.backfilledTasks.add(taskId);
  }
}

function rowToEnvVar(r: EnvRow): EnvVar {
  return {
    id: r.id,
    appId: (r.app_id as AppId | null) ?? null,
    key: r.key,
    value: r.value,
    enabled: !!r.enabled,
    isSecret: !!r.is_secret,
    note: r.note ?? undefined
  };
}
