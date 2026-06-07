import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { ulid } from 'ulid';
import { db } from '../db/index.js';
import type { App, AppId, NodeVersionPref, PackageManager } from '@shared/types';
import { DetectionService } from './DetectionService';

const PALETTE = [
  '#7aa2f7', '#bb9af7', '#f7768e', '#e0af68', '#9ece6a',
  '#73daca', '#7dcfff', '#ff9e64', '#c0caf5', '#f4b8e4',
  '#a6e3a1', '#fab387'
];

type AppRow = {
  id: string;
  name: string;
  path: string;
  color: string;
  icon: string | null;
  node_version_pref: string;
  package_manager: string | null;
  default_script: string | null;
  custom_command: string | null;
  working_dir: string;
  auto_restart_on_change: number;
  watch_globs: string;
  port_hint: number | null;
  tags: string;
  folder: string | null;
  last_started_at: number | null;
  last_exit_code: number | null;
  created_at: number;
  updated_at: number;
};

export class AppRegistry {
  constructor(private readonly detector = new DetectionService()) {}

  list(): App[] {
    const rows = db()
      .prepare<unknown[], AppRow>('SELECT * FROM apps ORDER BY updated_at DESC')
      .all();
    return rows.map(rowToApp);
  }

  get(id: AppId): App | null {
    const row = db()
      .prepare<unknown[], AppRow>('SELECT * FROM apps WHERE id = ?')
      .get(id);
    return row ? rowToApp(row) : null;
  }

  getByPath(path: string): App | null {
    const row = db()
      .prepare<unknown[], AppRow>('SELECT * FROM apps WHERE path = ?')
      .get(path);
    return row ? rowToApp(row) : null;
  }

  async add(rawPath: string): Promise<App> {
    const path = this.normalisePath(rawPath);
    const existing = this.getByPath(path);
    if (existing) return existing;

    const detection = await this.detector.detect(path);

    const id = ulid() as AppId;
    const now = Date.now();
    const color = PALETTE[this.list().length % PALETTE.length]!;

    const nodeVersionPref: NodeVersionPref = { kind: 'auto' };

    db()
      .prepare(
        `INSERT INTO apps
        (id, name, path, color, icon, node_version_pref, package_manager, default_script,
         custom_command, working_dir, auto_restart_on_change, watch_globs, port_hint, tags,
         last_started_at, last_exit_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, 0, '[]', NULL, '[]', NULL, NULL, ?, ?)`
      )
      .run(
        id,
        basename(path),
        path,
        color,
        JSON.stringify(nodeVersionPref),
        detection.packageManager,
        detection.suggestedDefaultScript,
        path,
        now,
        now
      );

    const app = this.get(id);
    if (!app) throw new Error('Failed to read app back after insert.');
    return app;
  }

  update(id: AppId, patch: Partial<App>): App {
    const current = this.get(id);
    if (!current) throw new Error(`App not found: ${id}`);

    const next: App = { ...current, ...patch, updatedAt: Date.now() };

    db()
      .prepare(
        `UPDATE apps SET
          name = ?, color = ?, icon = ?, node_version_pref = ?, package_manager = ?,
          default_script = ?, custom_command = ?, working_dir = ?,
          auto_restart_on_change = ?, watch_globs = ?, port_hint = ?, tags = ?,
          folder = ?, last_started_at = ?, last_exit_code = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        next.name,
        next.color,
        next.icon ?? null,
        JSON.stringify(next.nodeVersionPref),
        next.packageManager,
        next.defaultScript,
        next.customCommand,
        next.workingDir,
        next.autoRestartOnChange ? 1 : 0,
        JSON.stringify(next.watchGlobs),
        next.portHint,
        JSON.stringify(next.tags),
        normaliseFolder(next.folder),
        next.lastStartedAt,
        next.lastExitCode,
        next.updatedAt,
        next.id
      );

    return next;
  }

  remove(id: AppId): void {
    db().prepare('DELETE FROM apps WHERE id = ?').run(id);
  }

  /**
   * Distinct folder names across all apps, sorted alphabetically (case-insensitive).
   * Excludes NULL — that's the "(Ungrouped)" pseudo-folder, handled at render time.
   */
  listFolders(): string[] {
    const rows = db()
      .prepare<unknown[], { folder: string }>(
        `SELECT DISTINCT folder FROM apps WHERE folder IS NOT NULL AND folder != '' ORDER BY folder COLLATE NOCASE ASC`
      )
      .all();
    return rows.map((r) => r.folder);
  }

  /**
   * Rename all apps with `from` folder to `to`. Pass `to === ''` or whitespace to clear.
   * Case-insensitive match on the source name; destination is stored verbatim (trimmed).
   */
  renameFolder(from: string, to: string): void {
    const now = Date.now();
    const dest = normaliseFolder(to);
    db()
      .prepare(
        `UPDATE apps SET folder = ?, updated_at = ? WHERE folder IS NOT NULL AND folder = ? COLLATE NOCASE`
      )
      .run(dest, now, from);
  }

  /**
   * Move all apps with `name` folder back to NULL. Apps fall under "(Ungrouped)".
   */
  clearFolder(name: string): void {
    const now = Date.now();
    db()
      .prepare(
        `UPDATE apps SET folder = NULL, updated_at = ? WHERE folder IS NOT NULL AND folder = ? COLLATE NOCASE`
      )
      .run(now, name);
  }

  private normalisePath(p: string): string {
    try {
      const real = realpathSync(p);
      const s = statSync(real);
      if (!s.isDirectory()) throw new Error(`Not a directory: ${p}`);
      return real;
    } catch (err) {
      throw new Error(`Invalid path: ${p} (${(err as Error).message})`);
    }
  }
}

function rowToApp(r: AppRow): App {
  return {
    id: r.id as AppId,
    name: r.name,
    path: r.path,
    color: r.color,
    icon: r.icon ?? undefined,
    nodeVersionPref: JSON.parse(r.node_version_pref) as NodeVersionPref,
    packageManager: (r.package_manager as PackageManager | null) ?? null,
    defaultScript: r.default_script,
    customCommand: r.custom_command,
    workingDir: r.working_dir,
    autoRestartOnChange: !!r.auto_restart_on_change,
    watchGlobs: JSON.parse(r.watch_globs) as string[],
    portHint: r.port_hint,
    tags: JSON.parse(r.tags) as string[],
    folder: r.folder ?? null,
    lastStartedAt: r.last_started_at,
    lastExitCode: r.last_exit_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/** Trim, cap at 60 chars, treat empty/whitespace as NULL. */
function normaliseFolder(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 60);
}
