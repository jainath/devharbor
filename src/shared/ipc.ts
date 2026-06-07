import type {
  App,
  AppId,
  DetectionResult,
  EnvVar,
  NodeInstallation,
  ProcessState,
  RunningProcess,
  RunningTask,
  Task,
  TaskId
} from './types';

/** Mirrored from src/main/services/RunHistory.ts so the renderer can render rows. */
export interface RunHistoryRow {
  id: string;
  appId: AppId;
  taskId: TaskId | null;
  taskName: string | null;
  script: string | null;
  customCommand: string | null;
  nodeVersion: string | null;
  packageManager: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  wasKilledByUser: boolean;
}

/**
 * Single source of truth for IPC channels.
 *
 * - `invoke` channels: request/response (`ipcRenderer.invoke` ↔ `ipcMain.handle`).
 * - `event` channels: main-pushed streams (`webContents.send` → `ipcRenderer.on`).
 */
export type InvokeChannels = {
  'app:ping': { req: string; res: string };

  'apps:list': { req: void; res: App[] };
  'apps:add': { req: { path: string }; res: App };
  'apps:update': { req: { id: AppId; patch: Partial<App> }; res: App };
  'apps:remove': { req: { id: AppId }; res: void };
  'apps:detect': { req: { path: string }; res: DetectionResult };
  'apps:findByPath': { req: { path: string }; res: App | null };

  // App-level lifecycle (orchestrator coordinates all tasks).
  'proc:start': { req: { id: AppId }; res: void };
  'proc:stop': { req: { id: AppId }; res: void };
  'proc:restart': { req: { id: AppId }; res: void };
  'proc:list': { req: void; res: RunningProcess[] };

  // Task CRUD.
  'tasks:list': { req: { appId: AppId }; res: Task[] };
  'tasks:add': { req: { appId: AppId; patch: Partial<Task> }; res: Task };
  'tasks:update': { req: { id: TaskId; patch: Partial<Task> }; res: Task };
  'tasks:remove': { req: { id: TaskId }; res: void };
  'tasks:reorder': { req: { appId: AppId; taskIds: TaskId[] }; res: void };

  // Per-task lifecycle (for manual control / debugging).
  'task:start': { req: { id: TaskId }; res: RunningTask };
  'task:stop': { req: { id: TaskId }; res: void };
  'task:list': { req: void; res: RunningTask[] };

  // Phase 2: main holds the authoritative log ring buffer.
  'task:readBuffer': { req: { id: TaskId }; res: string };
  'task:tailBuffer': { req: { id: TaskId; maxLines?: number }; res: string };
  'task:clearBuffer': { req: { id: TaskId }; res: void };

  // Resize the PTY when the renderer's xterm grid changes.
  'task:resize': { req: { id: TaskId; cols: number; rows: number }; res: void };

  // Run history.
  'runs:list': { req: { appId: AppId; limit?: number }; res: RunHistoryRow[] };

  // Env files discovered in a project (read-only — for the side panel).
  'env:files': { req: { id: AppId }; res: EnvFileInfo[] };

  // Settings.
  'settings:get': { req: void; res: SettingsState };
  'settings:set': { req: { patch: Partial<SettingsState> }; res: SettingsState };

  // Apply a downloaded auto-update (quit & install).
  'update:install': { req: void; res: void };

  // DB danger zone.
  'db:export': { req: void; res: string | null };          // returns the saved-to path, or null if user cancelled
  'db:reset':  { req: void; res: void };                   // wipes DB; requires app restart
  'db:path':   { req: void; res: string };                 // userData/devharbor.db

  // "Open in" helpers for the AppDetail header.
  'openIn:caps': { req: void; res: OpenInCapabilities };
  'openIn:open': { req: { target: OpenInTarget; path: string }; res: void };

  'env:getGlobal': { req: void; res: EnvVar[] };
  'env:setGlobal': { req: { vars: EnvVar[] }; res: void };
  'env:getApp': { req: { id: AppId }; res: EnvVar[] };
  'env:setApp': { req: { id: AppId; vars: EnvVar[] }; res: void };
  'env:getTask': { req: { id: TaskId }; res: EnvVar[] };
  'env:setTask': { req: { id: TaskId; vars: EnvVar[] }; res: void };

  // Phase 8 — F21 folder operations. App-level folder field is set via apps:update.
  'folders:list': { req: void; res: string[] };
  'folders:rename': { req: { from: string; to: string }; res: void };
  'folders:clear': { req: { name: string }; res: void };

  'node:list': { req: void; res: NodeInstallation[] };
  'node:resolve': { req: { id: AppId }; res: NodeInstallation };

  'dialog:browse': { req: void; res: string | null };
};

export type EventChannels = {
  /** Per-task log chunk. Renderer keys log buffers by taskId. */
  'task:log': { taskId: TaskId; appId: AppId; chunk: string; ts: number };

  /** Per-task status transition. */
  'task:status': {
    taskId: TaskId;
    appId: AppId;
    state: ProcessState;
    ready: boolean;
    exitCode?: number | null;
    exitSignal?: string | null;
  };

  /** App-level rolled-up status (derived from tasks). */
  'proc:status': {
    appId: AppId;
    state: ProcessState;
    exitCode?: number | null;
    exitSignal?: string | null;
  };

  /** Per-task CPU/RAM sample. */
  'task:stats': {
    taskId: TaskId;
    appId: AppId;
    cpu: number;
    memMB: number;
  };

  /** Per-task listening port set. */
  'task:ports': {
    taskId: TaskId;
    appId: AppId;
    ports: number[];
  };

  /** A `.env*` file in an app's project dir changed on disk. */
  'env:fileChanged': {
    appId: AppId;
    path: string;
    event: 'add' | 'change' | 'unlink';
    modifiedAt: number;
  };

  /** An update is available (download starting). */
  'update:available': { version: string };

  /** Download progress for an in-flight update. */
  'update:progress': { percent: number; bytesPerSecond: number; transferred: number; total: number };

  /** An update has finished downloading; the user should restart to install. */
  'update:ready': { version: string };

  /** Deep link: focus a specific app. The renderer selects it in the sidebar. */
  'deepLink:focusApp': { appId: AppId };

  /** Deep link: a path was requested via open?path= but isn't registered. */
  'deepLink:unknownPath': { path: string };

  /**
   * Deep link: `devharbor://start?id=…` asked to start an app. We do NOT start it silently —
   * any web page can fire this — so the renderer must confirm with the user first, then call
   * `proc:start`. This keeps a clicked link from running local shell commands without consent.
   */
  'deepLink:confirmStart': { appId: AppId; appName: string };

  /** macOS application-menu actions → renderer. (Settings ⌘, / Add App ⌘N / Add Folder ⌘⇧N) */
  'menu:openSettings': Record<string, never>;
  'menu:addApp': Record<string, never>;
  'menu:newFolder': Record<string, never>;
};

export interface EnvFileInfo {
  path: string;
  name: string;
  modifiedAt: number;
}

export type OpenInTarget = 'finder' | 'terminal' | 'vscode' | 'cursor' | 'sublime';

export interface OpenInCapabilities {
  finder: boolean;
  terminal: boolean;
  vscode: boolean;
  cursor: boolean;
  sublime: boolean;
}

export interface SettingsState {
  log_ring_size: number;
  kill_grace_ms: number;
  auto_update: boolean;
  theme: 'light' | 'dark' | 'system';
  dashboard_refresh_ms: number;
}

export type InvokeChannelName = keyof InvokeChannels;
export type EventChannelName = keyof EventChannels;

export type InvokeReq<C extends InvokeChannelName> = InvokeChannels[C]['req'];
export type InvokeRes<C extends InvokeChannelName> = InvokeChannels[C]['res'];
export type EventPayload<C extends EventChannelName> = EventChannels[C];

export const INVOKE_CHANNELS: readonly InvokeChannelName[] = [
  'app:ping',
  'apps:list',
  'apps:add',
  'apps:update',
  'apps:remove',
  'apps:detect',
  'apps:findByPath',
  'proc:start',
  'proc:stop',
  'proc:restart',
  'proc:list',
  'tasks:list',
  'tasks:add',
  'tasks:update',
  'tasks:remove',
  'tasks:reorder',
  'task:start',
  'task:stop',
  'task:list',
  'task:readBuffer',
  'task:tailBuffer',
  'task:clearBuffer',
  'task:resize',
  'runs:list',
  'env:files',
  'settings:get',
  'settings:set',
  'update:install',
  'openIn:caps',
  'openIn:open',
  'db:export',
  'db:reset',
  'db:path',
  'env:getGlobal',
  'env:setGlobal',
  'env:getApp',
  'env:setApp',
  'env:getTask',
  'env:setTask',
  'folders:list',
  'folders:rename',
  'folders:clear',
  'node:list',
  'node:resolve',
  'dialog:browse'
] as const;

export const EVENT_CHANNELS: readonly EventChannelName[] = [
  'task:log',
  'task:status',
  'task:stats',
  'task:ports',
  'proc:status',
  'env:fileChanged',
  'update:available',
  'update:progress',
  'update:ready',
  'deepLink:focusApp',
  'deepLink:unknownPath',
  'deepLink:confirmStart',
  'menu:openSettings',
  'menu:addApp',
  'menu:newFolder'
] as const;

export type Api = {
  invoke: <C extends InvokeChannelName>(
    channel: C,
    req: InvokeReq<C>
  ) => Promise<InvokeRes<C>>;
  on: <C extends EventChannelName>(
    channel: C,
    listener: (payload: EventPayload<C>) => void
  ) => () => void;
};
