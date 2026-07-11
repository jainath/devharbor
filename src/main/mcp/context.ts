import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { App, AppId, EnvVar, Task, TaskId } from '@shared/types';
import type { EnvFileInfo } from '@shared/ipc';
import type { AppRegistry } from '../services/AppRegistry';
import type { TaskRegistry } from '../services/TaskRegistry';
import type { AppOrchestrator } from '../services/AppOrchestrator';
import type { TaskRunner } from '../services/TaskRunner';
import type { EnvStore } from '../services/EnvStore';
import type { DetectionService } from '../services/DetectionService';
import type { NodeResolver } from '../services/NodeResolver';
import type { RunHistory } from '../services/RunHistory';
import type { Settings } from '../services/Settings';
import type { AppOps } from '../services/AppOps';

/**
 * Everything the MCP tools operate on - the same singletons the IPC layer uses, plus AppOps
 * for the shared create/update/remove/scan/search flows. Injected so the tool layer stays
 * free of electron/db imports and can be exercised with fakes.
 */
export interface McpToolContext {
  appVersion: string;
  registry: AppRegistry;
  taskRegistry: TaskRegistry;
  orchestrator: AppOrchestrator;
  runner: TaskRunner;
  envStore: EnvStore;
  detector: DetectionService;
  nodes: NodeResolver;
  runHistory: RunHistory;
  settings: Settings;
  appOps: AppOps;
  /** Env files discovered in an app's project dir (read-only). */
  envFiles: (appId: AppId) => EnvFileInfo[];
  /**
   * Called by every MUTATING tool after it changes app/task/env/lifecycle state, so the
   * desktop UI (which caches its view and normally only updates on its own actions) can
   * re-sync. No-op-safe; the renderer debounces.
   */
  notifyChanged: () => void;
}

/** An actionable resolution failure - the tool layer turns this into an isError result. */
export class ResolutionError extends Error {}

/** Strip trailing slashes then realpath (best-effort) so path addressing matches app.path. */
function canonicalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, '') || '/';
  try {
    return realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Resolve an `app` argument that may be an app id, an exact (case-insensitive) name, or an
 * absolute path. Ambiguous names and unknown references throw ResolutionError with the
 * candidate/nearest list so the agent can correct itself in one step.
 */
export function resolveApp(ctx: McpToolContext, ref: string): App {
  const needle = ref.trim();
  if (!needle) throw new ResolutionError('An app id, name, or absolute path is required.');
  const all = ctx.registry.list();

  const byId = all.find((a) => a.id === needle);
  if (byId) return byId;

  if (isAbsolute(needle)) {
    const real = canonicalizePath(needle);
    const byPath = all.find((a) => a.path === real || a.path === needle.replace(/\/+$/, ''));
    if (byPath) return byPath;
    throw new ResolutionError(
      `No app is registered at path "${needle}". Use add_app to register it, or pass an app name/id.`
    );
  }

  const lower = needle.toLowerCase();
  const byName = all.filter((a) => a.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const list = byName.map((a) => `${a.name} (${a.id})`).join(', ');
    throw new ResolutionError(`"${needle}" is ambiguous - matches: ${list}. Pass the id.`);
  }

  const nearest = all
    .filter((a) => a.name.toLowerCase().includes(lower))
    .slice(0, 5)
    .map((a) => a.name);
  const hint = nearest.length ? ` Did you mean: ${nearest.join(', ')}?` : '';
  throw new ResolutionError(`No app matches "${needle}".${hint} Use list_apps to see them all.`);
}

/**
 * Resolve a `task` argument (task id, or task name scoped by an optional `app`). A bare name
 * resolves only if globally unique; otherwise the error lists the app/task candidates.
 */
export function resolveTask(ctx: McpToolContext, ref: string, appRef?: string): Task {
  const needle = ref.trim();
  if (!needle) throw new ResolutionError('A task id or name is required.');

  const byId = ctx.taskRegistry.get(needle as TaskId);
  if (byId) return byId;

  const scopeApp = appRef ? resolveApp(ctx, appRef) : null;
  const searchApps = scopeApp ? [scopeApp] : ctx.registry.list();
  const matches: Array<{ task: Task; app: App }> = [];
  for (const app of searchApps) {
    for (const t of ctx.taskRegistry.list(app.id)) {
      if (t.name.toLowerCase() === needle.toLowerCase()) matches.push({ task: t, app });
    }
  }
  if (matches.length === 1) return matches[0]!.task;
  if (matches.length > 1) {
    const list = matches.map((m) => `${m.app.name}/${m.task.name} (${m.task.id})`).join(', ');
    throw new ResolutionError(
      `Task "${needle}" is ambiguous - matches: ${list}. Pass the task id or scope with app.`
    );
  }
  const scopeMsg = scopeApp ? ` in app "${scopeApp.name}"` : '';
  throw new ResolutionError(`No task named "${needle}"${scopeMsg}. Use get_app to list tasks.`);
}

/**
 * Plaintext values of every secret env var in scope (global + app + the app's tasks), for
 * log redaction. Values < 4 chars are the caller's problem to skip; this returns them all.
 */
export function secretValuesForApp(ctx: McpToolContext, appId: AppId): string[] {
  const out: string[] = [];
  const push = (vars: EnvVar[]): void => {
    for (const v of vars) if (v.isSecret && v.value) out.push(v.value);
  };
  push(ctx.envStore.getGlobal());
  push(ctx.envStore.getApp(appId));
  for (const t of ctx.taskRegistry.list(appId)) push(ctx.envStore.getTask(t.id));
  return out;
}

/** Every secret value across every scope - for global searches that span apps. */
export function allSecretValues(ctx: McpToolContext): string[] {
  const out: string[] = [];
  for (const v of ctx.envStore.getGlobal()) if (v.isSecret && v.value) out.push(v.value);
  for (const app of ctx.registry.list()) {
    for (const v of ctx.envStore.getApp(app.id)) if (v.isSecret && v.value) out.push(v.value);
    for (const t of ctx.taskRegistry.list(app.id)) {
      for (const v of ctx.envStore.getTask(t.id)) if (v.isSecret && v.value) out.push(v.value);
    }
  }
  return out;
}
