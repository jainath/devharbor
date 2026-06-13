import { db } from './index.js';
import { ulid } from 'ulid';

/**
 * Phase 1.5 backfill: every existing App that doesn't yet have any tasks
 * gets one synthesised from its `default_script` / `custom_command`.
 *
 * Idempotent - re-running does nothing once the seed task exists.
 */
export function backfillTasksForExistingApps(): void {
  const d = db();
  const apps = d
    .prepare<unknown[], {
      id: string;
      default_script: string | null;
      custom_command: string | null;
    }>(
      `SELECT a.id, a.default_script, a.custom_command
       FROM apps a
       WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.app_id = a.id)`
    )
    .all();

  if (apps.length === 0) return;

  const insert = d.prepare(
    `INSERT INTO tasks
      (id, app_id, name, position, command_kind, script, custom_command,
       working_dir_override, package_manager_override, node_version_pref_override,
       depends_on, readiness, one_shot, enabled, env_overrides, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL, '[]', '{"kind":"none"}', 0, 1, '{}', ?, ?)`
  );

  const tx = d.transaction(() => {
    const now = Date.now();
    for (const row of apps) {
      const id = ulid();
      if (row.custom_command) {
        insert.run(id, row.id, 'main', 'custom', null, row.custom_command, now, now);
      } else if (row.default_script) {
        insert.run(id, row.id, row.default_script, 'script', row.default_script, null, now, now);
      } else {
        // No script and no custom command - skip. The app needs explicit task creation.
      }
    }
  });
  tx();
}
