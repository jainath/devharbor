import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, AppId, EnvVar, Task } from '@shared/types';
import { parseDotEnv } from '@shared/dotenv';
import type { EnvStore } from './EnvStore';
import type { PathProbe } from './PathProbe';

/**
 * Process-control keys that an on-disk project `.env` is NEVER allowed to set.
 *
 * IMPROVEMENT-PLAN 6.1: a checked-in or malicious `.env` could otherwise hijack
 * the spawned process by overriding the computed PATH (shadowing real binaries
 * with attacker-controlled ones on disk), or by injecting loader/runtime hooks
 * via NODE_OPTIONS / NODE_PATH / DYLD_* / LD_* (e.g. DYLD_INSERT_LIBRARIES code
 * injection on macOS). We strip these from file vars entirely - they can only
 * come from the sanitized base, the computed PATH, or user-configured env_vars.
 */
const PROCESS_CONTROL_KEYS = new Set(['PATH', 'NODE_OPTIONS', 'NODE_PATH']);

/** True if a key from a project `.env` must be dropped (see {@link PROCESS_CONTROL_KEYS}). */
function isProcessControlKey(key: string): boolean {
  return PROCESS_CONTROL_KEYS.has(key) || /^(DYLD_|LD_)/.test(key);
}

/**
 * Build the env handed to a spawned task.
 *
 * Layering order (later wins). IMPROVEMENT-PLAN 6.1: user-configured vars now
 * sit ABOVE project `.env` files so the UI is the source of truth, and project
 * files can never override process-control keys (see {@link isProcessControlKey}).
 *
 *   1. Sanitized OS base (HOME, USER, LANG, SSH_AUTH_SOCK, …)
 *   2. Computed PATH (Node bin dir prepended to the login-shell PATH probe)
 *   3. Project .env files (process-control keys stripped - see parseEnvFiles)
 *   4. Global env_vars rows (enabled only)
 *   5. App env_vars rows (enabled only)
 *   6. Task env_vars rows (enabled only) - Phase 7
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
      'SHELL',
      // Forward the agent socket so git-over-SSH / `ssh` in a task authenticates
      // the same way it does in the user's terminal instead of prompting/failing.
      'SSH_AUTH_SOCK',
      // Terminal identity hints so CLIs that probe these (e.g. for hyperlink or
      // truecolor support) behave like they would in a real terminal.
      'TERM_PROGRAM',
      'COLORTERM'
    ]);

    const userPath = await this.pathProbe.get();
    const env: Record<string, string> = {
      ...sanitizedBase,
      PATH: `${nodeBinDir}:${userPath}`
    };

    // Project .env files first, so user-configured env_vars below always win and
    // process-control keys (PATH, NODE_OPTIONS, …) are stripped (see parseEnvFiles).
    Object.assign(env, this.parseEnvFiles(cwd));

    // Global env vars (from settings → env_vars table)
    layerVars(env, this.envStore.getGlobal());

    // App env vars
    layerVars(env, this.envStore.getApp(app.id as AppId));

    // Task env vars - Phase 7. EnvStore.getTask backfills from legacy
    // tasks.env_overrides JSON on first read if no rows exist yet.
    if (task) {
      layerVars(env, this.envStore.getTask(task.id));
    }

    // Hard-coded runtime
    env.FORCE_COLOR = '1';
    env.TERM = 'xterm-256color';

    return env;
  }

  private parseEnvFiles(dir: string): Record<string, string> {
    // Conventional dev-tool precedence (later wins): base, then env-specific,
    // then local overrides, then env-specific local overrides. All of these
    // still sit BELOW user-configured env_vars in build().
    const files = ['.env', '.env.development', '.env.local', '.env.development.local'];
    const out: Record<string, string> = {};
    for (const f of files) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      try {
        const parsed = parseDotEnv(readFileSync(p, 'utf8'));
        for (const [key, value] of Object.entries(parsed)) {
          // Never let a project file hijack the process - drop control keys.
          if (isProcessControlKey(key)) continue;
          out[key] = value;
        }
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

