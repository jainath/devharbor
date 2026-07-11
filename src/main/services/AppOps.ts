import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { App, AppId, EnvVar } from '@shared/types';
import type { CreateAppInput, GlobalLogMatch, ImportCandidate } from '@shared/ipc';
import type { AppRegistry } from './AppRegistry';
import type { TaskRegistry } from './TaskRegistry';
import type { EnvStore } from './EnvStore';
import type { DetectionService } from './DetectionService';
import type { AppOrchestrator } from './AppOrchestrator';

/**
 * Callbacks the composition root supplies so AppOps can keep watchers and the tray in sync
 * after a mutation, without AppOps depending on those services directly.
 */
export interface AppOpsHooks {
  watchEnvFiles: (appId: AppId, path: string) => void;
  unwatchEnvFiles: (appId: AppId) => void;
  syncRestartWatcher: (appId: AppId) => void;
  unwatchRestart: (appId: AppId) => void;
  refreshTray: () => void;
}

/**
 * The non-trivial app/task flows that BOTH the IPC handlers and the MCP tools need:
 * atomic create-with-rollback, watcher-resyncing update, guarded remove, folder scan, and
 * global log search. Extracted here so there is exactly one implementation of each and the
 * two entry points cannot drift (see specs/07-mcp-server.md). Pure orchestration over the
 * injected services; no electron imports, so it is unit-testable with fakes.
 */
export class AppOps {
  constructor(
    private readonly registry: AppRegistry,
    private readonly tasks: TaskRegistry,
    private readonly envStore: EnvStore,
    private readonly detector: DetectionService,
    private readonly orchestrator: AppOrchestrator,
    private readonly hooks: AppOpsHooks
  ) {}

  /**
   * Atomic create: app + tasks + env vars, with best-effort rollback on failure. The path is
   * validated to be an existing directory BEFORE realpath so a bad path reads as a friendly
   * "Invalid path" rather than a raw ENOENT (a fix folded in during the AppOps extraction).
   */
  async createApp(input: CreateAppInput): Promise<App> {
    const real = this.canonicalizeDir(input.path);
    if (this.registry.getByPath(real)) {
      throw new Error('This folder is already registered.');
    }
    const app = await this.registry.add(input.path);
    try {
      const patched = this.registry.update(app.id, {
        name: input.name?.trim() || app.name,
        nodeVersionPref: input.nodeVersionPref ?? { kind: 'auto' },
        packageManager: input.packageManager ?? null,
        defaultScript: input.defaultScript ?? null
      });
      const taskSpecs = [...(input.firstTask ? [input.firstTask] : []), ...(input.tasks ?? [])];
      for (const spec of taskSpecs) {
        this.tasks.add(app.id, {
          name: spec.name,
          commandKind: spec.commandKind,
          script: spec.script ?? null,
          customCommand: spec.customCommand ?? null,
          workingDirOverride: spec.workingDirOverride ?? null,
          enabled: true
        });
      }
      if (input.envVars && input.envVars.length > 0) {
        const vars: EnvVar[] = input.envVars
          .filter((v) => v.key.trim())
          .map((v) => ({
            id: '',
            appId: app.id,
            key: v.key.trim(),
            value: v.value,
            enabled: true,
            isSecret: v.isSecret ?? false
          }));
        this.envStore.setApp(app.id, vars);
      }
      this.hooks.watchEnvFiles(app.id, app.path);
      this.hooks.syncRestartWatcher(app.id);
      this.hooks.refreshTray();
      return patched;
    } catch (err) {
      try {
        this.registry.remove(app.id);
      } catch {
        /* best-effort rollback - FK cascade cleans tasks/env */
      }
      throw err;
    }
  }

  /** Patch an app, re-syncing env-file + restart watchers when the relevant fields changed. */
  updateApp(id: AppId, patch: Partial<App>): App {
    const before = this.registry.get(id);
    const app = this.registry.update(id, patch);
    if (!before || before.path !== app.path) {
      this.hooks.watchEnvFiles(app.id, app.path);
    }
    if (
      !before ||
      before.autoRestartOnChange !== app.autoRestartOnChange ||
      before.path !== app.path ||
      JSON.stringify(before.watchGlobs) !== JSON.stringify(app.watchGlobs)
    ) {
      this.hooks.syncRestartWatcher(app.id);
    }
    this.hooks.refreshTray();
    return app;
  }

  /**
   * Remove an app's registration (never its files on disk). Refuses while the app is live -
   * the same guard the UI enforces, kept here so no caller (IPC or MCP) can bypass it.
   */
  removeApp(id: AppId): void {
    const st = this.orchestrator.appState(id);
    if (st === 'running' || st === 'starting' || st === 'exiting') {
      throw new Error('Stop the app before removing it.');
    }
    this.hooks.unwatchEnvFiles(id);
    this.hooks.unwatchRestart(id);
    this.orchestrator.clearOutcome(id);
    this.registry.remove(id);
    this.hooks.refreshTray();
  }

  /** Shallow one-level scan of a folder for package.json projects (bulk import). */
  async scanFolder(dir: string): Promise<ImportCandidate[]> {
    const out: ImportCandidate[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
        if (!existsSync(join(full, 'package.json'))) continue;
      } catch {
        continue;
      }
      let real = full;
      try {
        real = realpathSync(full);
      } catch {
        // use raw
      }
      const detection = await this.detector.detect(full);
      out.push({
        path: full,
        name: basename(real),
        alreadyRegistered: !!this.registry.getByPath(real),
        packageManager: detection.packageManager,
        suggestedScript: detection.suggestedDefaultScript,
        scripts: Object.keys(detection.scripts)
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Global log search across every task with a retained buffer - including tasks that exited
   * in the last ~10 minutes, not only live ones (a deliberate change during extraction; the
   * old handler only iterated running tasks). Regex by default with a literal fallback on an
   * invalid pattern; `g`/`y` flags are stripped so a stateful RegExp can't skip matches.
   */
  searchLogs(opts: {
    query: string;
    regex?: boolean;
    flags?: string;
    appId?: AppId;
    limit?: number;
  }): GlobalLogMatch[] {
    const out: GlobalLogMatch[] = [];
    const query = opts.query.trim();
    if (!query) return out;

    const useRegex = opts.regex ?? true;
    let re: RegExp;
    if (useRegex) {
      const flags = ((opts.flags ?? 'i').replace(/[gy]/g, '') || 'i');
      try {
        re = new RegExp(query, flags);
      } catch {
        re = new RegExp(escapeRegex(query), 'i');
      }
    } else {
      re = new RegExp(escapeRegex(query), 'i');
    }

    const cap = opts.limit ?? 500;
    const runner = this.orchestrator.runner;
    for (const taskId of runner.bufferedTaskIds()) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      if (opts.appId && task.appId !== opts.appId) continue;
      const app = this.registry.get(task.appId);
      const buf = runner.readBuffer(taskId);
      for (const line of buf.split('\n')) {
        if (re.test(line)) {
          out.push({
            appId: task.appId,
            taskId,
            appName: app?.name ?? '',
            taskName: task.name,
            line: line.length > 2000 ? line.slice(0, 2000) : line
          });
          if (out.length >= cap) return out;
        }
      }
    }
    return out;
  }

  /** Resolve to a canonical, existing directory. Throws a friendly message otherwise. */
  private canonicalizeDir(p: string): string {
    if (!isAbsolute(p)) throw new Error(`Path must be absolute: ${p}`);
    try {
      const real = realpathSync(p);
      if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${p}`);
      return real;
    } catch (err) {
      throw new Error(`Invalid path: ${p} (${(err as Error).message})`);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
