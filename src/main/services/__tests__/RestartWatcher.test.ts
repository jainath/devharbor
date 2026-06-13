import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AppId } from '@shared/types';
import { RestartWatcher } from '../RestartWatcher';

/**
 * Regression guard for IMPROVEMENT-PLAN 5.1: chokidar v4+ removed glob support, so the old
 * `chokidar.watch(['src/**'])` watcher was silently dead. The watcher must (a) fire on a
 * change to a file matching the configured globs and (b) ignore node_modules.
 */
describe('RestartWatcher (chokidar v5 directory-watch + glob filter)', () => {
  it('fires on a matching src change and ignores node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-test-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));

    const w = new RestartWatcher();
    const fired: string[] = [];
    w.on('restart', ({ path }: { path: string }) => fired.push(path));
    w.watch('app1' as AppId, dir, []); // [] → DEFAULT_GLOBS (src/**/*.{ts,...})

    // Let the watcher finish its initial scan before touching files.
    await new Promise((r) => setTimeout(r, 800));
    writeFileSync(join(dir, 'node_modules', 'junk.ts'), 'x'); // must be ignored
    writeFileSync(join(dir, 'src', 'a.ts'), 'x'); // must trigger (after 500ms debounce)
    await new Promise((r) => setTimeout(r, 1500));

    w.unwatch('app1' as AppId);
    rmSync(dir, { recursive: true, force: true });

    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((p) => !p.includes('node_modules'))).toBe(true);
    expect(fired.some((p) => p.endsWith('a.ts'))).toBe(true);
  }, 10000);
});
