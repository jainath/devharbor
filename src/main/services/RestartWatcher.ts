import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AppId } from '@shared/types';

const DEFAULT_GLOBS = ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const DEBOUNCE_MS = 500;
const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**'
];

/**
 * Watches each app's source files; when they change, emits a debounced 'restart' event.
 * App-side wires this to `orchestrator.restartApp(appId)`.
 */
export class RestartWatcher extends EventEmitter {
  private readonly watchers = new Map<AppId, FSWatcher>();
  private readonly timers = new Map<AppId, NodeJS.Timeout>();

  watch(appId: AppId, dir: string, globs: string[]): void {
    this.unwatch(appId);
    const patterns = (globs.length > 0 ? globs : DEFAULT_GLOBS).map((g) =>
      g.startsWith('/') ? g : `${dir}/${g}`
    );
    const w = chokidar.watch(patterns, {
      ignored: IGNORE_GLOBS,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
      followSymlinks: false
    });
    const trigger = (path: string): void => {
      const t = this.timers.get(appId);
      if (t) clearTimeout(t);
      this.timers.set(
        appId,
        setTimeout(() => {
          this.timers.delete(appId);
          this.emit('restart', { appId, path });
        }, DEBOUNCE_MS)
      );
    };
    w.on('change', trigger);
    w.on('add', trigger);
    w.on('unlink', trigger);
    this.watchers.set(appId, w);
  }

  unwatch(appId: AppId): void {
    const w = this.watchers.get(appId);
    if (w) {
      void w.close();
      this.watchers.delete(appId);
    }
    const t = this.timers.get(appId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(appId);
    }
  }

  disposeAll(): void {
    for (const [, w] of this.watchers) void w.close();
    for (const [, t] of this.timers) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
  }
}
