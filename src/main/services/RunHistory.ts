import { ulid } from 'ulid';
import { db } from '../db/index.js';
import type { AppId, PackageManager, TaskId } from '@shared/types';

export interface RunHistoryRow {
  id: string;
  appId: AppId;
  taskId: TaskId | null;
  taskName: string | null;
  script: string | null;
  customCommand: string | null;
  nodeVersion: string | null;
  packageManager: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  wasKilledByUser: boolean;
}

type DbRow = {
  id: string;
  app_id: string;
  task_id: string | null;
  task_name: string | null;
  script: string | null;
  custom_command: string | null;
  node_version: string | null;
  package_manager: string | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  was_killed_by_user: number;
};

export class RunHistory {
  start(args: {
    appId: AppId;
    taskId: TaskId;
    taskName: string;
    script: string | null;
    customCommand: string | null;
    nodeVersion: string;
    packageManager: PackageManager;
  }): string {
    const id = ulid();
    db()
      .prepare(
        `INSERT INTO run_history
          (id, app_id, task_id, task_name, started_at, ended_at, script, custom_command,
           node_version, package_manager, exit_code, exit_signal, was_killed_by_user)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 0)`
      )
      .run(
        id,
        args.appId,
        args.taskId,
        args.taskName,
        Date.now(),
        args.script,
        args.customCommand,
        args.nodeVersion,
        args.packageManager
      );
    return id;
  }

  finish(
    runId: string,
    args: { exitCode: number | null; exitSignal: string | null; wasKilledByUser: boolean }
  ): void {
    db()
      .prepare(
        `UPDATE run_history
           SET ended_at = ?, exit_code = ?, exit_signal = ?, was_killed_by_user = ?
         WHERE id = ?`
      )
      .run(Date.now(), args.exitCode, args.exitSignal, args.wasKilledByUser ? 1 : 0, runId);
  }

  list(appId: AppId, limit = 100): RunHistoryRow[] {
    const rows = db()
      .prepare<unknown[], DbRow>(
        `SELECT * FROM run_history
         WHERE app_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(appId, limit);
    return rows.map(toRow);
  }

  /**
   * Trim run_history to the most recent `perAppLimit` rows per app.
   *
   * WHY: nothing else ever deletes from run_history, and with
   * restart-on-change a single app can append hundreds of rows/day. Left
   * unchecked the table grows without bound, bloating the DB and slowing
   * list() queries. Pruning per app_id (rather than a global cap) keeps a
   * usable window of history for every app regardless of how active others
   * are. The DELETE runs as one statement so it stays atomic and cheap to
   * call once on boot.
   *
   * A non-positive limit is treated as "no cap" and is a no-op - we never
   * want a misconfigured setting to wipe the entire table.
   */
  prune(perAppLimit: number): void {
    if (perAppLimit <= 0) return;
    db()
      .prepare(
        `DELETE FROM run_history
         WHERE id NOT IN (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY app_id ORDER BY started_at DESC
                    ) AS rn
             FROM run_history
           )
           WHERE rn <= ?
         )`
      )
      .run(perAppLimit);
  }
}

function toRow(r: DbRow): RunHistoryRow {
  return {
    id: r.id,
    appId: r.app_id as AppId,
    taskId: r.task_id ? (r.task_id as TaskId) : null,
    taskName: r.task_name,
    script: r.script,
    customCommand: r.custom_command,
    nodeVersion: r.node_version,
    packageManager: r.package_manager,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    exitCode: r.exit_code,
    exitSignal: r.exit_signal,
    wasKilledByUser: !!r.was_killed_by_user
  };
}
