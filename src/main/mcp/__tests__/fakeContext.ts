import type { App, AppId, EnvVar, RunningTask, Task, TaskId, WorkspaceCandidate } from '@shared/types';
import type { CreateAppInput, GlobalLogMatch } from '@shared/ipc';
import type { McpToolContext } from '../context';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * In-memory McpToolContext for unit-testing the tool catalog without electron/db. Only the
 * surface the tools touch is implemented; everything is a plain object cast to the service
 * types, matching the repo's existing fake-by-cast test convention.
 */
export interface FakeState {
  apps: App[];
  tasks: Record<string, Task[]>;
  appEnv: Record<string, EnvVar[]>;
  globalEnv: EnvVar[];
  running: RunningTask[];
  buffers: Record<string, string>;
  states: Record<string, string>;
  searchMatches: GlobalLogMatch[];
  removed: string[];
  setAppCalls: Array<{ appId: string; vars: EnvVar[] }>;
  startedApps: string[];
  notifyChangedCalls: number;
  createAppCalls: CreateAppInput[];
  detection: {
    scripts: Record<string, string>;
    suggestedDefaultScript: string | null;
    workspaces: WorkspaceCandidate[];
  };
}

export function makeApp(partial: Omit<Partial<App>, 'id'> & { id: string; name: string; path: string }): App {
  return {
    color: '#fff',
    nodeVersionPref: { kind: 'auto' },
    packageManager: 'npm',
    defaultScript: 'dev',
    customCommand: null,
    workingDir: partial.path,
    autoRestartOnChange: false,
    autoStart: false,
    watchGlobs: [],
    portHint: null,
    tags: [],
    folder: null,
    lastStartedAt: null,
    lastExitCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
    id: partial.id as AppId
  } as App;
}

export function makeTask(
  partial: Omit<Partial<Task>, 'id' | 'appId'> & { id: string; appId: string; name: string }
): Task {
  return {
    position: 0,
    commandKind: 'script',
    script: 'dev',
    customCommand: null,
    workingDirOverride: null,
    packageManagerOverride: null,
    nodeVersionPrefOverride: null,
    dependsOn: [],
    readiness: { kind: 'none' },
    oneShot: false,
    enabled: true,
    envOverrides: {},
    createdAt: 1,
    updatedAt: 1,
    ...partial,
    id: partial.id as TaskId,
    appId: partial.appId as AppId
  } as Task;
}

export function makeContext(state: Partial<FakeState> = {}): { ctx: McpToolContext; state: FakeState } {
  const s: FakeState = {
    apps: [],
    tasks: {},
    appEnv: {},
    globalEnv: [],
    running: [],
    buffers: {},
    states: {},
    searchMatches: [],
    removed: [],
    setAppCalls: [],
    startedApps: [],
    notifyChangedCalls: 0,
    createAppCalls: [],
    detection: { scripts: {}, suggestedDefaultScript: null, workspaces: [] },
    ...state
  };

  const runner = {
    list: () => s.running,
    // Port-ownership labels (PortDetector passthrough). Tests can extend per-case.
    ports: { portOwners: (_id: TaskId) => [] as Array<{ port: number; pid: number | null; process: string | null }> },
    get: (id: TaskId) => s.running.find((r) => r.taskId === id) ?? null,
    isRunning: (id: TaskId) =>
      s.running.some((r) => r.taskId === id && (r.state === 'running' || r.state === 'starting')),
    tailBuffer: (id: TaskId, n = 200) => {
      const lines = (s.buffers[id] ?? '').split('\n');
      return lines.slice(Math.max(0, lines.length - n)).join('\n');
    },
    readBuffer: (id: TaskId) => s.buffers[id] ?? '',
    bufferedTaskIds: () => Object.keys(s.buffers) as TaskId[],
    start: async (task: Task) => ({
      snapshot: s.running.find((r) => r.taskId === task.id) ?? {
        taskId: task.id,
        appId: task.appId,
        pid: 1,
        state: 'starting',
        ready: false,
        startedAt: 1,
        command: 'x',
        nodeVersion: '20',
        packageManager: 'npm',
        cpu: 0,
        memMB: 0,
        ports: [],
        exitCode: null,
        exitSignal: null
      },
      awaitReady: Promise.resolve(true)
    })
  };

  const orchestrator = {
    runner,
    appState: (id: AppId) => s.states[id] ?? 'idle',
    startApp: async (id: AppId) => {
      s.startedApps.push(id);
    },
    stopApp: async () => {},
    restartApp: async (id: AppId) => {
      s.startedApps.push(id);
    },
    startTask: async () => {},
    stopTask: async () => {},
    clearOutcome: () => {}
  };

  const registry = {
    list: () => s.apps,
    get: (id: AppId) => s.apps.find((a) => a.id === id) ?? null,
    getByPath: (p: string) => s.apps.find((a) => a.path === p) ?? null,
    remove: (id: AppId) => {
      s.removed.push(id);
      s.apps = s.apps.filter((a) => a.id !== id);
    },
    update: (id: AppId, patch: Partial<App>) => {
      const a = s.apps.find((x) => x.id === id)!;
      Object.assign(a, patch);
      return a;
    }
  };

  const taskRegistry = {
    list: (appId: AppId) => s.tasks[appId] ?? [],
    get: (id: TaskId) => {
      for (const arr of Object.values(s.tasks)) {
        const t = arr.find((x) => x.id === id);
        if (t) return t;
      }
      return null;
    },
    add: (appId: AppId, patch: Partial<Task>) => {
      const t = makeTask({ ...patch, id: `task-${String(patch.name)}`, appId, name: String(patch.name) });
      (s.tasks[appId] ??= []).push(t);
      return t;
    },
    // Mirrors the real registry's dependent guard so remove_task error paths are testable.
    remove: (id: TaskId) => {
      for (const [appId, arr] of Object.entries(s.tasks)) {
        const t = arr.find((x) => x.id === id);
        if (!t) continue;
        const dependents = arr.filter((x) => x.dependsOn.includes(id));
        if (dependents.length) {
          throw new Error(
            `Can't remove "${t.name}" - these tasks depend on it: ${dependents.map((d) => d.name).join(', ')}`
          );
        }
        s.tasks[appId] = arr.filter((x) => x.id !== id);
        return;
      }
      throw new Error(`Task not found: ${id}`);
    },
    update: (id: TaskId, patch: Partial<Task>) => {
      for (const arr of Object.values(s.tasks)) {
        const t = arr.find((x) => x.id === id);
        if (t) {
          Object.assign(t, patch);
          return t;
        }
      }
      throw new Error(`Task not found: ${id}`);
    }
  };

  const envStore = {
    getGlobal: () => s.globalEnv,
    getApp: (id: AppId) => s.appEnv[id] ?? [],
    getTask: () => [],
    setApp: (id: AppId, vars: EnvVar[]) => {
      s.setAppCalls.push({ appId: id, vars });
      s.appEnv[id] = vars;
    }
  };

  const appOps = {
    searchLogs: () => s.searchMatches,
    scanFolder: async () => [],
    removeApp: (id: AppId) => {
      const st = orchestrator.appState(id);
      if (st === 'running' || st === 'starting' || st === 'exiting') {
        throw new Error('Stop the app before removing it.');
      }
      registry.remove(id);
    },
    updateApp: (id: AppId, patch: Partial<App>) => registry.update(id, patch),
    // Captures the atomic-create input and materialises firstTask/tasks so add_app's
    // post-create taskRegistry.list reflects what would have been created.
    createApp: async (input: CreateAppInput) => {
      s.createAppCalls.push(input);
      const app = s.apps[0]!;
      const specs = [...(input.firstTask ? [input.firstTask] : []), ...(input.tasks ?? [])];
      for (const spec of specs) {
        taskRegistry.add(app.id, {
          name: spec.name,
          commandKind: spec.commandKind,
          script: spec.script ?? null,
          customCommand: spec.customCommand ?? null,
          workingDirOverride: spec.workingDirOverride ?? null
        });
      }
      return app;
    }
  };

  const ctx: McpToolContext = {
    appVersion: '9.9.9',
    registry: registry as any,
    taskRegistry: taskRegistry as any,
    orchestrator: orchestrator as any,
    runner: runner as any,
    envStore: envStore as any,
    detector: { detect: async () => s.detection } as any,
    nodes: { list: () => [{ source: 'system', version: '20.0.0', binDir: '/usr/bin' }] } as any,
    runHistory: { list: () => [] } as any,
    settings: { get: () => 0 } as any,
    appOps: appOps as any,
    envFiles: () => [],
    notifyChanged: () => {
      s.notifyChangedCalls++;
    }
  };

  return { ctx, state: s };
}

/** Capture registered tools so a test can invoke a handler directly. */
export interface CapturedTool {
  name: string;
  config: any;
  handler: (args: any) => any;
}

export function captureTools(register: (server: any, ctx: McpToolContext) => void, ctx: McpToolContext): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const fakeServer = {
    registerTool: (name: string, config: any, handler: (args: any) => any) => {
      tools.set(name, { name, config, handler });
    }
  };
  register(fakeServer as any, ctx);
  return tools;
}
