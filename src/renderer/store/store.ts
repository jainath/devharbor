import { create } from 'zustand';
import type {
  App,
  AppId,
  ProcessState,
  RunningProcess,
  RunningTask,
  Task,
  TaskId
} from '@shared/types';
import { APP_SORT_KEY, type AppSortMode } from '../lib/sortApps';

export type RendererView = 'dashboard' | 'app';

function readAppSort(): AppSortMode {
  try {
    const v = localStorage.getItem(APP_SORT_KEY);
    if (v === 'name' || v === 'recent' || v === 'running') return v;
  } catch {
    // ignore
  }
  return 'name';
}

export interface EnvFileChange {
  appId: AppId;
  path: string;
  event: 'add' | 'change' | 'unlink';
  modifiedAt: number;
}

interface State {
  apps: App[];
  loaded: boolean;
  view: RendererView;
  selectedAppId: AppId | null;

  // Shared app-list sort, applied to both the Sidebar and Dashboard.
  appSort: AppSortMode;

  // appId -> Task[] (in display order)
  tasksByApp: Record<string, Task[]>;

  // appId -> currently selected task tab
  selectedTaskByApp: Record<string, TaskId | null>;

  // App-level aggregate from main.
  running: Record<string, RunningProcess>;
  appState: Record<string, ProcessState>;
  appExitCode: Record<string, number | null>;

  // Per-task running state (keyed by taskId).
  runningTasks: Record<string, RunningTask>;
  taskState: Record<string, ProcessState>;
  taskReady: Record<string, boolean>;
  taskExitCode: Record<string, number | null>;
  taskCpu: Record<string, number>;
  taskMemMB: Record<string, number>;
  taskPorts: Record<string, number[]>;

  // Pending env-file-change banners, keyed by appId. Most recent first.
  envFileChanges: Record<string, EnvFileChange[]>;

  setApps: (apps: App[]) => void;
  upsertApp: (app: App) => void;
  removeApp: (id: AppId) => void;
  setSelected: (id: AppId | null) => void;
  setView: (view: RendererView) => void;
  setAppSort: (mode: AppSortMode) => void;

  setTasksForApp: (appId: AppId, tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (id: TaskId) => void;
  selectTaskTab: (appId: AppId, taskId: TaskId) => void;

  setRunningApps: (list: RunningProcess[]) => void;
  setRunningTasks: (list: RunningTask[]) => void;

  applyAppStatus: (id: AppId, state: ProcessState, exitCode?: number | null) => void;
  applyTaskStatus: (
    id: TaskId,
    appId: AppId,
    state: ProcessState,
    ready: boolean,
    exitCode?: number | null
  ) => void;
  applyTaskStats: (id: TaskId, cpu: number, memMB: number) => void;
  applyTaskPorts: (id: TaskId, ports: number[]) => void;

  applyEnvFileChange: (change: EnvFileChange) => void;
  dismissEnvFileChanges: (appId: AppId) => void;
}

export const useStore = create<State>((set) => ({
  apps: [],
  loaded: false,
  // Default landing is the dashboard. Cmd+R / boot lands here; clicking an app
  // in the sidebar takes you to the app detail (see setSelected).
  view: 'dashboard',
  selectedAppId: null,
  appSort: readAppSort(),
  tasksByApp: {},
  selectedTaskByApp: {},

  running: {},
  appState: {},
  appExitCode: {},

  runningTasks: {},
  taskState: {},
  taskReady: {},
  taskExitCode: {},
  taskCpu: {},
  taskMemMB: {},
  taskPorts: {},

  envFileChanges: {},

  setApps: (apps) =>
    set((s) => ({
      apps,
      loaded: true,
      selectedAppId: s.selectedAppId ?? apps[0]?.id ?? null
    })),

  upsertApp: (app) =>
    set((s) => {
      const idx = s.apps.findIndex((a) => a.id === app.id);
      const next = idx === -1 ? [app, ...s.apps] : s.apps.map((a) => (a.id === app.id ? app : a));
      return { apps: next, selectedAppId: s.selectedAppId ?? app.id };
    }),

  removeApp: (id) =>
    set((s) => {
      const apps = s.apps.filter((a) => a.id !== id);
      const selectedAppId = s.selectedAppId === id ? apps[0]?.id ?? null : s.selectedAppId;
      const { [id]: _r, ...running } = s.running;
      const { [id]: _as, ...appState } = s.appState;
      const { [id]: _ae, ...appExitCode } = s.appExitCode;
      const { [id]: _tasks, ...tasksByApp } = s.tasksByApp;
      const { [id]: _sel, ...selectedTaskByApp } = s.selectedTaskByApp;
      return {
        apps,
        selectedAppId,
        running,
        appState,
        appExitCode,
        tasksByApp,
        selectedTaskByApp
      };
    }),

  setSelected: (id) => set({ selectedAppId: id, view: id ? 'app' : 'dashboard' }),
  setView: (view) => set({ view }),
  setAppSort: (mode) => {
    try {
      localStorage.setItem(APP_SORT_KEY, mode);
    } catch {
      // ignore
    }
    set({ appSort: mode });
  },

  setTasksForApp: (appId, tasks) =>
    set((s) => ({
      tasksByApp: { ...s.tasksByApp, [appId]: tasks },
      selectedTaskByApp: {
        ...s.selectedTaskByApp,
        [appId]: s.selectedTaskByApp[appId] ?? tasks[0]?.id ?? null
      }
    })),

  upsertTask: (task) =>
    set((s) => {
      const existing = s.tasksByApp[task.appId] ?? [];
      const idx = existing.findIndex((t) => t.id === task.id);
      const next = idx === -1 ? [...existing, task] : existing.map((t) => (t.id === task.id ? task : t));
      next.sort((a, b) => a.position - b.position);
      return {
        tasksByApp: { ...s.tasksByApp, [task.appId]: next },
        selectedTaskByApp: {
          ...s.selectedTaskByApp,
          [task.appId]: s.selectedTaskByApp[task.appId] ?? task.id
        }
      };
    }),

  removeTask: (id) =>
    set((s) => {
      const next: Record<string, Task[]> = {};
      let owner: AppId | null = null;
      for (const [appId, tasks] of Object.entries(s.tasksByApp)) {
        const filtered = tasks.filter((t) => {
          if (t.id === id) {
            owner = appId as AppId;
            return false;
          }
          return true;
        });
        next[appId] = filtered;
      }
      const selectedTaskByApp = { ...s.selectedTaskByApp };
      if (owner && selectedTaskByApp[owner] === id) {
        selectedTaskByApp[owner] = next[owner]?.[0]?.id ?? null;
      }
      const { [id]: _r, ...runningTasks } = s.runningTasks;
      const { [id]: _ts, ...taskState } = s.taskState;
      const { [id]: _tr, ...taskReady } = s.taskReady;
      const { [id]: _te, ...taskExitCode } = s.taskExitCode;
      return {
        tasksByApp: next,
        selectedTaskByApp,
        runningTasks,
        taskState,
        taskReady,
        taskExitCode
      };
    }),

  selectTaskTab: (appId, taskId) =>
    set((s) => ({ selectedTaskByApp: { ...s.selectedTaskByApp, [appId]: taskId } })),

  setRunningApps: (list) =>
    set(() => {
      const running: Record<string, RunningProcess> = {};
      const appState: Record<string, ProcessState> = {};
      for (const p of list) {
        running[p.appId] = p;
        appState[p.appId] = p.state;
      }
      return { running, appState };
    }),

  setRunningTasks: (list) =>
    set(() => {
      const runningTasks: Record<string, RunningTask> = {};
      const taskState: Record<string, ProcessState> = {};
      const taskReady: Record<string, boolean> = {};
      const taskCpu: Record<string, number> = {};
      const taskMemMB: Record<string, number> = {};
      const taskPorts: Record<string, number[]> = {};
      // Hydrate ALL per-task derived state from the IPC snapshot. Critical: the
      // `task:ports` event only fires when the port set CHANGES, so on a renderer
      // refresh (Cmd+R) we'd otherwise have empty `taskPorts` for already-running
      // tasks until they happen to discover a new port.
      for (const t of list) {
        runningTasks[t.taskId] = t;
        taskState[t.taskId] = t.state;
        taskReady[t.taskId] = t.ready;
        taskCpu[t.taskId] = t.cpu;
        taskMemMB[t.taskId] = t.memMB;
        taskPorts[t.taskId] = t.ports;
      }
      return { runningTasks, taskState, taskReady, taskCpu, taskMemMB, taskPorts };
    }),

  applyAppStatus: (id, state, exitCode) =>
    set((s) => {
      const out: Partial<State> = {
        appState: { ...s.appState, [id]: state }
      };
      if (exitCode !== undefined) {
        out.appExitCode = { ...s.appExitCode, [id]: exitCode ?? null };
      }
      if (state === 'exited' || state === 'crashed' || state === 'idle') {
        const { [id]: _removed, ...rest } = s.running;
        out.running = rest;
      }
      // On 'starting', bump the cached lastStartedAt locally so the Recent strip
      // surfaces the just-started app immediately (main also persists this).
      // This does NOT affect the main card grid, which is sorted alphabetically.
      if (state === 'starting') {
        const idx = s.apps.findIndex((a) => a.id === id);
        if (idx >= 0) {
          const next = [...s.apps];
          next[idx] = { ...next[idx]!, lastStartedAt: Date.now() };
          out.apps = next;
        }
      }
      return out;
    }),

  applyTaskStatus: (id, _appId, state, ready, exitCode) =>
    set((s) => {
      const out: Partial<State> = {
        taskState: { ...s.taskState, [id]: state },
        taskReady: { ...s.taskReady, [id]: ready }
      };
      if (exitCode !== undefined) {
        out.taskExitCode = { ...s.taskExitCode, [id]: exitCode ?? null };
      }
      if (state === 'exited' || state === 'crashed') {
        const { [id]: _removed, ...rest } = s.runningTasks;
        out.runningTasks = rest;
      } else if (s.runningTasks[id]) {
        out.runningTasks = { ...s.runningTasks, [id]: { ...s.runningTasks[id]!, state, ready } };
      }
      // Clear stale CPU/mem/ports whenever a task leaves the running state. Without this,
      // a restart ('starting' before fresh samples arrive) briefly shows the previous run's
      // memory and port chips in the dashboard aggregate and cards.
      if (state !== 'running') {
        out.taskCpu = { ...s.taskCpu, [id]: 0 };
        out.taskMemMB = { ...s.taskMemMB, [id]: 0 };
        out.taskPorts = { ...s.taskPorts, [id]: [] };
      }
      return out;
    }),

  applyTaskStats: (id, cpu, memMB) =>
    set((s) => ({
      taskCpu: { ...s.taskCpu, [id]: cpu },
      taskMemMB: { ...s.taskMemMB, [id]: memMB }
    })),

  applyTaskPorts: (id, ports) =>
    set((s) => ({ taskPorts: { ...s.taskPorts, [id]: ports } })),

  applyEnvFileChange: (change) =>
    set((s) => {
      const existing = s.envFileChanges[change.appId] ?? [];
      // Coalesce by path: keep one entry per file, with the latest event.
      const filtered = existing.filter((c) => c.path !== change.path);
      return {
        envFileChanges: {
          ...s.envFileChanges,
          [change.appId]: [change, ...filtered]
        }
      };
    }),

  dismissEnvFileChanges: (appId) =>
    set((s) => {
      const { [appId]: _, ...rest } = s.envFileChanges;
      return { envFileChanges: rest };
    })
}));
