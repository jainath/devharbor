import { describe, expect, it } from 'vitest';

/**
 * Mirrors the layering performed inside EnvBuilder.build():
 *   process < global < app < task < .env  (later wins)
 *
 * This is replicated as a pure function here (same pattern as PortDetector.test.ts) —
 * any change to EnvBuilder's order must also change this test, surfacing the diff.
 *
 * See specs/03-features.md F6 and specs/02-data-model.md "Scope layering".
 */
type EnvRow = { key: string; value: string; enabled: boolean };

function layer(
  base: Record<string, string>,
  rows: EnvRow[]
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const r of rows) {
    if (!r.enabled || !r.key) continue;
    out[r.key] = r.value;
  }
  return out;
}

function buildEffective(args: {
  processEnv: Record<string, string>;
  global: EnvRow[];
  app: EnvRow[];
  task: EnvRow[];
  dotEnv: Record<string, string>;
}): Record<string, string> {
  let env = { ...args.processEnv };
  env = layer(env, args.global);
  env = layer(env, args.app);
  env = layer(env, args.task);
  env = { ...env, ...args.dotEnv };
  return env;
}

describe('env layering (3-scope, Phase 7)', () => {
  it('global value wins when no app or task override', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'DEBUG', value: 'app:*', enabled: true }],
      app: [],
      task: [],
      dotEnv: {}
    });
    expect(env.DEBUG).toBe('app:*');
  });

  it('app value overrides global', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'DEBUG', value: 'app:*', enabled: true }],
      app: [{ key: 'DEBUG', value: 'app:auth', enabled: true }],
      task: [],
      dotEnv: {}
    });
    expect(env.DEBUG).toBe('app:auth');
  });

  it('task value overrides app and global', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'DEBUG', value: 'app:*', enabled: true }],
      app: [{ key: 'DEBUG', value: 'app:auth', enabled: true }],
      task: [{ key: 'DEBUG', value: 'app:auth:trace', enabled: true }],
      dotEnv: {}
    });
    expect(env.DEBUG).toBe('app:auth:trace');
  });

  it('task can override global directly with no app row in between', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'NODE_ENV', value: 'development', enabled: true }],
      app: [],
      task: [{ key: 'NODE_ENV', value: 'test', enabled: true }],
      dotEnv: {}
    });
    expect(env.NODE_ENV).toBe('test');
  });

  it('disabled rows are skipped at every scope', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'PORT', value: '3000', enabled: true }],
      app: [{ key: 'PORT', value: '4000', enabled: false }],
      task: [{ key: 'PORT', value: '5000', enabled: false }],
      dotEnv: {}
    });
    // app + task rows are disabled → global wins
    expect(env.PORT).toBe('3000');
  });

  it('.env from the task cwd is the outermost layer and overrides everything', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: 'API_URL', value: 'https://global', enabled: true }],
      app: [{ key: 'API_URL', value: 'https://app', enabled: true }],
      task: [{ key: 'API_URL', value: 'https://task', enabled: true }],
      dotEnv: { API_URL: 'https://dotenv' }
    });
    expect(env.API_URL).toBe('https://dotenv');
  });

  it('inherits process keys that no scope touches', () => {
    const env = buildEffective({
      processEnv: { HOME: '/Users/me', PATH: '/usr/bin' },
      global: [],
      app: [],
      task: [],
      dotEnv: {}
    });
    expect(env.HOME).toBe('/Users/me');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('different tasks of the same app get distinct PORT values', () => {
    const base = {
      processEnv: {},
      global: [{ key: 'NODE_ENV', value: 'development', enabled: true }],
      app: [{ key: 'DATABASE_URL', value: 'postgres://local', enabled: true }],
      dotEnv: {}
    };
    const apiEnv = buildEffective({
      ...base,
      task: [{ key: 'PORT', value: '4000', enabled: true }]
    });
    const webEnv = buildEffective({
      ...base,
      task: [{ key: 'PORT', value: '5173', enabled: true }]
    });
    expect(apiEnv.PORT).toBe('4000');
    expect(webEnv.PORT).toBe('5173');
    // App-shared values still present in both
    expect(apiEnv.DATABASE_URL).toBe('postgres://local');
    expect(webEnv.DATABASE_URL).toBe('postgres://local');
    expect(apiEnv.NODE_ENV).toBe('development');
    expect(webEnv.NODE_ENV).toBe('development');
  });

  it('empty key is ignored (defensive)', () => {
    const env = buildEffective({
      processEnv: {},
      global: [{ key: '', value: 'whatever', enabled: true }],
      app: [],
      task: [],
      dotEnv: {}
    });
    expect(env['']).toBeUndefined();
  });
});
