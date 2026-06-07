import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, AppId, EnvVar, Task } from '@shared/types';
import { parseDotEnv } from '@shared/dotenv';
import type { EnvStore } from './EnvStore';
import type { PathProbe } from './PathProbe';

/**
 * Build the env handed to a spawned task.
 *
 * Layering order (later wins):
 *   1. Sanitized OS base (HOME, USER, LANG, …)
 *   2. User's full PATH from the login-shell probe (Node bin prepended in front)
 *   3. Global env_vars rows (enabled only)
 *   4. App env_vars rows (enabled only)
 *   5. Task env_vars rows (enabled only) — Phase 7
 *   6. .env, .env.local from the task's working dir
 *   7. Hard-coded runtime (FORCE_COLOR, TERM)
 */
export class EnvBuilder {
  constructor(
    private readonly envStore: EnvStore,
    private readonly pathProbe: PathProbe
  ) {}

  async build(args: {
    app: App;
    task?: Task | null;
    nodeBinDir: string;
    cwd: string;
  }): Promise<Record<string, string>> {
    const { app, task, nodeBinDir, cwd } = args;

    const sanitizedBase = pick(process.env, [
      'HOME',
      'USER',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'SHELL'
    ]);

    const userPath = await this.pathProbe.get();
    const env: Record<string, string> = {
      ...sanitizedBase,
      PATH: `${nodeBinDir}:${userPath}`
    };

    // Global env vars (from settings → env_vars table)
    layerVars(env, this.envStore.getGlobal());

    // App env vars
    layerVars(env, this.envStore.getApp(app.id as AppId));

    // Task env vars — Phase 7. EnvStore.getTask backfills from legacy
    // tasks.env_overrides JSON on first read if no rows exist yet.
    if (task) {
      layerVars(env, this.envStore.getTask(task.id));
    }

    // .env files in cwd
    Object.assign(env, this.parseEnvFiles(cwd));

    // Hard-coded runtime
    env.FORCE_COLOR = '1';
    env.TERM = 'xterm-256color';

    return env;
  }

  private parseEnvFiles(dir: string): Record<string, string> {
    const files = ['.env', '.env.local'];
    const out: Record<string, string> = {};
    for (const f of files) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      try {
        Object.assign(out, parseDotEnv(readFileSync(p, 'utf8')));
      } catch {
        // ignore unreadable env file
      }
    }
    return out;
  }
}

function layerVars(env: Record<string, string>, vars: EnvVar[]): void {
  for (const v of vars) {
    if (!v.enabled) continue;
    if (!v.key) continue;
    env[v.key] = v.value;
  }
}

function pick<T extends Record<string, unknown>>(
  src: T,
  keys: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

