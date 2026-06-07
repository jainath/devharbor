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

export function db(): DB {
  if (_db) return _db;

  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });

  const file = join(dir, 'devharbor.db');
  _db = new Database(file);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  ensureMigrationsTable(_db);
  runMigrations(_db);
  backfillTasksForExistingApps();

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
      // path looks like './migrations/0001_init.sql' — strip prefix + extension for the version key.
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
  _db?.close();
  _db = null;
}
