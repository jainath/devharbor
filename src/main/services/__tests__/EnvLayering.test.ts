import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App, AppId, EnvVar, Task, TaskId } from '@shared/types';
import { EnvBuilder } from '../EnvBuilder';

/**
 * Exercises the REAL EnvBuilder.build() (not a pure-function mirror - the old version of this
 * file re-implemented the layering and silently kept asserting the pre-hardening precedence).
 *
 * Shipped precedence (later wins) - IMPROVEMENT-PLAN 6.1:
 *   sanitized base < computed PATH < project .env files < global < app < task < FORCE_COLOR/TERM
 *
 * Key inversions vs the old behavior, asserted here:
 *   - USER-configured env_vars now override project .env files (UI is the source of truth).
 *   - A project .env can never set process-control keys (PATH, NODE_OPTIONS, DYLD_*, …).
 *
 * EnvBuilder's EnvStore/PathProbe deps are type-only imports, so plain stubs work - no
 * better-sqlite3 needed. The .env files are real files in a temp dir.
 */

const row = (key: string, value: string, enabled = true): EnvVar => ({
  id: key,
  appId: null,
  key,
  value,
  enabled,
  isSecret: false
});

function makeBuilder(scopes: { global?: EnvVar[]; app?: EnvVar[]; task?: EnvVar[] }): EnvBuilder {
  const envStore = {
    getGlobal: () => scopes.global ?? [],
    getApp: (_id: AppId) => scopes.app ?? [],
    getTask: (_id: TaskId) => scopes.task ?? []
  };
  const pathProbe = { get: async () => '/probe/bin:/usr/bin' };
  // Type-only constructor params - structural stubs are sufficient.
  return new EnvBuilder(envStore as never, pathProbe as never);
}

const app = { id: 'a1' as AppId } as App;
const task = { id: 't1' as TaskId } as Task;

let cwd: string;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'envlayer-'));
});
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const build = (
  b: EnvBuilder,
  opts?: { withTask?: boolean; dir?: string }
): Promise<Record<string, string>> =>
  b.build({
    app,
    task: opts?.withTask === false ? null : task,
    nodeBinDir: '/node/bin',
    cwd: opts?.dir ?? cwd
  });

describe('EnvBuilder layering (real builder, shipped precedence)', () => {
  it('global < app < task (later scope wins)', async () => {
    const env = await build(
      makeBuilder({
        global: [row('DEBUG', 'app:*')],
        app: [row('DEBUG', 'app:auth')],
        task: [row('DEBUG', 'app:auth:trace')]
      })
    );
    expect(env.DEBUG).toBe('app:auth:trace');
  });

  it('user-configured vars override the project .env (UI is source of truth)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'envlayer-uservs-'));
    writeFileSync(join(dir, '.env'), 'API_URL=https://dotenv\nONLY_FILE=file-val\n');
    const env = await build(makeBuilder({ app: [row('API_URL', 'https://user')] }), { dir });
    rmSync(dir, { recursive: true, force: true });
    expect(env.API_URL).toBe('https://user'); // OLD behavior was 'https://dotenv'
    expect(env.ONLY_FILE).toBe('file-val'); // untouched keys still flow through
  });

  it('.env can never set process-control keys (PATH / NODE_OPTIONS / DYLD_*)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'envlayer-ctl-'));
    writeFileSync(
      join(dir, '.env'),
      'PATH=/tmp/evil\nNODE_OPTIONS=--require /tmp/evil.js\nDYLD_INSERT_LIBRARIES=/tmp/evil.dylib\nSAFE=ok\n'
    );
    const env = await build(makeBuilder({}), { dir });
    rmSync(dir, { recursive: true, force: true });
    expect(env.PATH).toBe('/node/bin:/probe/bin:/usr/bin'); // computed PATH intact
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.SAFE).toBe('ok');
  });

  it('.env variants load in conventional order (.env < .env.development < .env.local)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'envlayer-variants-'));
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\nC=base\n');
    writeFileSync(join(dir, '.env.development'), 'B=dev\nC=dev\n');
    writeFileSync(join(dir, '.env.local'), 'C=local\n');
    const env = await build(makeBuilder({}), { dir });
    rmSync(dir, { recursive: true, force: true });
    expect(env.A).toBe('base');
    expect(env.B).toBe('dev');
    expect(env.C).toBe('local');
  });

  it('disabled rows are skipped at every scope', async () => {
    const env = await build(
      makeBuilder({
        global: [row('PORT', '3000')],
        app: [row('PORT', '4000', false)],
        task: [row('PORT', '5000', false)]
      })
    );
    expect(env.PORT).toBe('3000');
  });

  it('task scope is only applied when a task is passed', async () => {
    const env = await build(makeBuilder({ task: [row('ONLY_TASK', 'x')] }), { withTask: false });
    expect(env.ONLY_TASK).toBeUndefined();
  });

  it('computed PATH prepends the node bin dir to the probed login-shell PATH', async () => {
    const env = await build(makeBuilder({}));
    expect(env.PATH).toBe('/node/bin:/probe/bin:/usr/bin');
  });

  it('hard-coded runtime keys cap the stack', async () => {
    const env = await build(makeBuilder({ task: [row('TERM', 'dumb'), row('FORCE_COLOR', '0')] }));
    // FORCE_COLOR/TERM are set after all scopes - even a task row can't change them.
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('different tasks of the same app get distinct task-scope values', async () => {
    const base = { global: [row('NODE_ENV', 'development')], app: [row('DB', 'postgres://local')] };
    const api = await build(makeBuilder({ ...base, task: [row('PORT', '4000')] }));
    const web = await build(makeBuilder({ ...base, task: [row('PORT', '5173')] }));
    expect(api.PORT).toBe('4000');
    expect(web.PORT).toBe('5173');
    expect(api.DB).toBe('postgres://local');
    expect(web.NODE_ENV).toBe('development');
  });
});
