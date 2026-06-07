import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, statSync, readdirSync } from 'node:fs';
import type { AppId } from '@shared/types';

export interface EnvFileChange {
  appId: AppId;
  path: string;
  event: 'add' | 'change' | 'unlink';
  modifiedAt: number;
}

export interface EnvFileInfo {
  path: string;
  name: string;
  modifiedAt: number;
}

const ENV_GLOBS = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local'];

/**
 * Per-app chokidar watcher restricted to `.env*` files in the app's directory.
 * Emits 'change' { appId, path, event } when a file is touched.
 *
 * Stateful: call `watch(appId, dir)` to start, `unwatch(appId)` to stop.
 */
export class EnvFileWatcher extends EventEmitter {
  private readonly watchers = new Map<AppId, FSWatcher>();

  list(dir: string): EnvFileInfo[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f === '.env' || f.startsWith('.env.'))
        .map((name) => {
          const path = join(dir, name);
          let modifiedAt = 0;
          try {
            modifiedAt = statSync(path).mtimeMs;
          } catch {
            // ignore
          }
          return { path, name, modifiedAt };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  watch(appId: AppId, dir: string): void {
    this.unwatch(appId);
    const paths = ENV_GLOBS.map((g) => join(dir, g));
    const w = chokidar.watch(paths, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    const onAny = (event: 'add' | 'change' | 'unlink', path: string): void => {
      let modifiedAt = Date.now();
      try {
        modifiedAt = statSync(path).mtimeMs;
      } catch {
        // ignore (e.g. on unlink)
      }
      this.emit('change', { appId, path, event, modifiedAt } satisfies EnvFileChange);
    };
    w.on('add', (p) => onAny('add', p));
    w.on('change', (p) => onAny('change', p));
    w.on('unlink', (p) => onAny('unlink', p));
    this.watchers.set(appId, w);
  }

  unwatch(appId: AppId): void {
    const w = this.watchers.get(appId);
    if (w) {
      void w.close();
      this.watchers.delete(appId);
    }
  }

  disposeAll(): void {
    for (const [, w] of this.watchers) void w.close();
    this.watchers.clear();
  }
}
