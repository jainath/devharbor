import { safeStorage } from 'electron';
import { ulid } from 'ulid';
import { db } from '../db/index.js';
import type { AppId, EnvVar, TaskId } from '@shared/types';

/**
 * Prefix tagging a value as encrypted-at-rest via Electron safeStorage.
 * Versioned so a future scheme change (e.g. 'enc2:') can be distinguished without
 * a destructive migration. Plaintext rows carry no prefix.
 */
const ENC_PREFIX = 'enc1:';

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
      .map(this.rowToEnvVar);
  }

  private listApp(appId: AppId): EnvVar[] {
    return db()
      .prepare<unknown[], EnvRow>(
        `SELECT * FROM env_vars WHERE app_id = ? AND task_id IS NULL ORDER BY key ASC`
      )
      .all(appId)
      .map(this.rowToEnvVar);
  }

  private listTask(taskId: TaskId): EnvVar[] {
    return db()
      .prepare<unknown[], EnvRow>(
        `SELECT * FROM env_vars WHERE task_id = ? ORDER BY key ASC`
      )
      .all(taskId)
      .map(this.rowToEnvVar);
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
    // Permanently neutralise the legacy tasks.env_overrides JSON in the SAME
    // transaction as the delete+insert. Without this, deleting all of a task's
    // vars (setTask(id, [])) leaves COUNT(env_vars)=0, and on next launch
    // ensureTaskBackfilled would re-insert the frozen JSON, resurrecting the
    // deleted values (IMPROVEMENT-PLAN 5.7). '{}' is the persistent done-marker.
    const neutralizeLegacy = db().prepare(
      `UPDATE tasks SET env_overrides = '{}' WHERE id = ?`
    );
    this.replaceTx(
      () => {
        deleteAll.run(taskId);
        neutralizeLegacy.run(taskId);
      },
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
          // Encrypt secret values at rest; non-secrets stored verbatim. getX still
          // returns decrypted plaintext via rowToEnvVar, so callers are unaffected.
          this.encMaybe(v.value ?? '', v.isSecret),
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
   *
   * IMPROVEMENT-PLAN 5.7: on EVERY return path we collapse tasks.env_overrides to
   * '{}' (the persistent done-marker from the 0004 migration). Without this, a task
   * whose vars were all deleted would have COUNT(env_vars)=0 on next launch and the
   * frozen JSON would be re-backfilled, resurrecting the deleted values. Stamping
   * '{}' once and for all makes resurrection impossible across relaunches.
   */
  private ensureTaskBackfilled(taskId: TaskId): void {
    if (this.backfilledTasks.has(taskId)) return;
    const existing = db()
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM env_vars WHERE task_id = ?`
      )
      .get(taskId);
    if (existing && existing.n > 0) {
      this.neutralizeLegacyOverrides(taskId);
      this.backfilledTasks.add(taskId);
      return;
    }
    const row = db()
      .prepare<unknown[], { app_id: string; env_overrides: string }>(
        `SELECT app_id, env_overrides FROM tasks WHERE id = ?`
      )
      .get(taskId);
    if (!row || !row.env_overrides) {
      this.neutralizeLegacyOverrides(taskId);
      this.backfilledTasks.add(taskId);
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.env_overrides) as Record<string, unknown>;
    } catch {
      this.neutralizeLegacyOverrides(taskId);
      this.backfilledTasks.add(taskId);
      return;
    }
    const entries = Object.entries(parsed).filter(([, v]) => typeof v === 'string');
    if (entries.length === 0) {
      this.neutralizeLegacyOverrides(taskId);
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
    // replaceTask already stamps env_overrides='{}' inside its transaction, so the
    // backfill itself is self-neutralising; the explicit stamps above cover the
    // paths where replaceTask is never reached.
    this.replaceTask(taskId, incoming);
    this.backfilledTasks.add(taskId);
  }

  /** Collapse a task's legacy env_overrides JSON to the '{}' done-marker (idempotent). */
  private neutralizeLegacyOverrides(taskId: TaskId): void {
    db()
      .prepare(`UPDATE tasks SET env_overrides = '{}' WHERE id = ?`)
      .run(taskId);
  }

  /**
   * Encrypt a value for storage when it is a secret and OS-backed encryption is
   * available. Returns 'enc1:'+base64(ciphertext) for secrets, otherwise the value
   * verbatim. When safeStorage is unavailable (e.g. headless/Linux without a keyring)
   * we silently fall back to plaintext rather than block saves.
   */
  private encMaybe(value: string, isSecret: boolean): string {
    if (isSecret && safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
    }
    return value;
  }

  /**
   * Inverse of encMaybe: decrypt 'enc1:'-tagged SECRET values back to plaintext; pass
   * everything else through unchanged. Only rows flagged is_secret are ever decrypted - 
   * a non-secret value that legitimately begins with 'enc1:' must not be interpreted as
   * ciphertext. On decrypt failure (keychain unavailable, corrupt blob) we return the RAW
   * stored string rather than '' - destroying the value would make a transient keychain
   * hiccup permanent the moment the user hits Save.
   */
  private decMaybe(value: string, isSecret: boolean): string {
    if (isSecret && value.startsWith(ENC_PREFIX)) {
      try {
        return safeStorage.decryptString(
          Buffer.from(value.slice(ENC_PREFIX.length), 'base64')
        );
      } catch {
        return value;
      }
    }
    return value;
  }

  /**
   * One-shot, idempotent boot migration: re-encrypt any secret rows still stored
   * as plaintext (is_secret = 1 AND value NOT LIKE 'enc1:%'). Called once on boot by
   * the IPC layer. No-op when encryption is unavailable, so plaintext stays readable.
   */
  migratePlaintextSecrets(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const rows = db()
      .prepare<unknown[], { id: string; value: string }>(
        `SELECT id, value FROM env_vars WHERE is_secret = 1 AND value NOT LIKE 'enc1:%'`
      )
      .all();
    if (rows.length === 0) return;
    const update = db().prepare(`UPDATE env_vars SET value = ? WHERE id = ?`);
    const tx = db().transaction(() => {
      for (const r of rows) {
        update.run(this.encMaybe(r.value, true), r.id);
      }
    });
    tx();
  }

  /**
   * Map a raw env_vars row to the public EnvVar shape, transparently decrypting
   * secret values so EnvBuilder/EnvEditor always see plaintext. Arrow-bound so it
   * can be passed directly to Array.map without losing `this` (needs this.decMaybe).
   */
  private readonly rowToEnvVar = (r: EnvRow): EnvVar => ({
    id: r.id,
    appId: (r.app_id as AppId | null) ?? null,
    key: r.key,
    value: this.decMaybe(r.value, !!r.is_secret),
    enabled: !!r.enabled,
    isSecret: !!r.is_secret,
    note: r.note ?? undefined
  });
}

