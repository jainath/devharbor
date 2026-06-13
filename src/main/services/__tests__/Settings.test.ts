import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Settings.ts depends on the better-sqlite3 native module which is built for Electron's
 * ABI, not Node's - so we can't import it directly under vitest. We test the parsing
 * helpers indirectly by importing them once they're refactored out.
 *
 * This file is a placeholder showing the test scaffold; the meaningful Settings tests
 * live as integration tests under Playwright (deferred).
 */

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'am-settings-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('Settings (parsing helpers)', () => {
  it('placeholder - see Playwright suite for the integration tests', () => {
    expect(true).toBe(true);
  });
});
