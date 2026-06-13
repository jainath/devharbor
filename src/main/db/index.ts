import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { backfillTasksForExistingApps } from './backfill.js';

// Bundle migration SQL into the main bundle at build time.
// Keys are like '../db/migrations/0001_init.sql' (relative to this file).
const migrationModules = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

let _db: DB | null = null;
let shuttingDown = false;

export function dbFile(): string {
  return join(app.getPath('userData'), 'devharbor.db');
}

export function db(): DB {
  if (_db) return _db;

  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'devharbor.db');

  // A late write during shutdown (e.g. a final run_history UPDATE) must NOT re-run migrations
  // + backfill on a freshly-opened handle. The schema already exists - open minimally.
  if (shuttingDown) {
    const reopened = new Database(file);
    reopened.pragma('journal_mode = WAL');
    reopened.pragma('foreign_keys = ON');
    _db = reopened;
    return _db;
  }

  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  try {
    ensureMigrationsTable(database);
    runMigrations(database);
    // backfill reads through db(), so the handle must be assigned first - but only AFTER
    // migrations succeed, so a thrown migration never leaves a half-migrated handle cached.
    _db = database;
    backfillTasksForExistingApps();
  } catch (e) {
    _db = null;
    try {
      database.close();
    } catch {
      // ignore
    }
    throw e;
  }

  return _db;
}

function ensureMigrationsTable(d: DB): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function runMigrations(d: DB): void {
  const applied = new Set(
    (d.prepare('SELECT version FROM _schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version
    )
  );

  const entries = Object.entries(migrationModules)
    .map(([path, sql]) => {
      // path looks like './migrations/0001_init.sql' - strip prefix + extension for the version key.
      const file = path.split('/').pop() ?? path;
      const version = file.replace(/\.sql$/, '');
      return { version, sql };
    })
    .sort((a, b) => a.version.localeCompare(b.version));

  const insertVersion = d.prepare(
    'INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)'
  );

  for (const { version, sql } of entries) {
    if (applied.has(version)) continue;
    const tx = d.transaction(() => {
      d.exec(sql);
      insertVersion.run(version, Date.now());
    });
    tx();
  }
}

export function closeDb(): void {
  shuttingDown = true;
  if (_db) {
    // Flush the WAL into the main db file so an export/backup taken right after isn't missing
    // recent writes, and so db:reset doesn't strand an orphaned -wal (IMPROVEMENT-PLAN 5.11).
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore
    }
    _db.close();
  }
  _db = null;
}
