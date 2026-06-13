import { EventEmitter } from 'node:events';
import { relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import type { AppId } from '@shared/types';

const DEFAULT_GLOBS = ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const DEBOUNCE_MS = 500;
// Directory names that must never be recursively watched (FD/CPU blowup).
const IGNORE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage'
]);

/**
 * Builds the match/ignore predicates for one app's watch globs.
 *
 * chokidar v4+ REMOVED glob support, so passing `src/**` to chokidar.watch (as before) made
 * the watcher silently dead - it treated the pattern as a literal non-existent path and never
 * fired, disabling restart-on-change entirely (IMPROVEMENT-PLAN 5.1). The working approach is
 * to watch the app DIRECTORY with a function-based `ignored` (so node_modules/.git/dist are
 * pruned, avoiding a recursive-watch blowup), then filter emitted paths through picomatch.
 */
function makePredicates(dir: string, globs: string[]): {
  ignored: (p: string) => boolean;
  matches: (p: string) => boolean;
} {
  const patterns = globs.length > 0 ? globs : DEFAULT_GLOBS;
  const isMatch = picomatch(patterns, { dot: false });
  const ignored = (p: string): boolean => {
    const rel = relative(dir, p);
    if (rel === '') return false; // the watched root itself
    if (rel.startsWith('..')) return true; // outside the app dir
    return rel.split(sep).some((seg) => IGNORE_SEGMENTS.has(seg));
  };
  const matches = (p: string): boolean => {
    const rel = relative(dir, p);
    return rel !== '' && !rel.startsWith('..') && isMatch(rel);
  };
  return { ignored, matches };
}

/**
 * Watches each app's source files; when they change, emits a debounced 'restart' event.
 * App-side wires this to `orchestrator.restartApp(appId)`.
 */
export class RestartWatcher extends EventEmitter {
  private readonly watchers = new Map<AppId, FSWatcher>();
  private readonly timers = new Map<AppId, NodeJS.Timeout>();

  watch(appId: AppId, dir: string, globs: string[]): void {
    this.unwatch(appId);
    const { ignored, matches } = makePredicates(dir, globs);
    const w = chokidar.watch(dir, {
      ignored,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
      followSymlinks: false
    });
    const trigger = (path: string): void => {
      // Only the configured globs count - we watch the whole tree but restart on src changes.
      if (!matches(path)) return;
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
