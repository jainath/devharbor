import type {
  App,
  AppId,
  CommandKind,
  DetectionResult,
  EnvVar,
  NodeInstallation,
  NodeVersionPref,
  PackageManager,
  ProcessState,
  RunningProcess,
  RunningTask,
  Task,
  TaskId
} from './types';

export interface CreateTaskSpec {
  name: string;
  commandKind: CommandKind;
  script?: string | null;
  customCommand?: string | null;
  /** Run from this subdir (relative to the app path) - used for monorepo workspace tasks. */
  workingDirOverride?: string | null;
}

/** Atomic add-app payload - main creates the app + tasks + env in one DB transaction. */
export interface CreateAppInput {
  path: string;
  name?: string;
  nodeVersionPref?: NodeVersionPref;
  packageManager?: PackageManager | null;
  defaultScript?: string | null;
  /** A single first task (the common case). */
  firstTask?: CreateTaskSpec | null;
  /** Multiple tasks (e.g. one per monorepo workspace package). Created after firstTask. */
  tasks?: CreateTaskSpec[];
  envVars?: { key: string; value: string; isSecret?: boolean }[];
}

/** One candidate project found by a shallow folder scan (bulk import). */
export interface ImportCandidate {
  path: string;
  name: string;
  alreadyRegistered: boolean;
  packageManager: PackageManager | null;
  suggestedScript: string | null;
  scripts: string[];
}

/** A single matching log line from a cross-task global search. */
export interface GlobalLogMatch {
  appId: AppId;
  taskId: TaskId;
  appName: string;
  taskName: string;
  line: string;
}

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
  /** Atomic create: app + first task + env vars in one transaction (replaces the renderer's 4-call add). */
  'apps:create': { req: CreateAppInput; res: App };
  'apps:update': { req: { id: AppId; patch: Partial<App> }; res: App };
  'apps:remove': { req: { id: AppId }; res: void };
  'apps:detect': { req: { path: string }; res: DetectionResult };
  'apps:findByPath': { req: { path: string }; res: App | null };
  /** Shallow-scan a folder for package.json projects (bulk import). */
  'apps:scanFolder': { req: { dir: string }; res: ImportCandidate[] };

  // App-level lifecycle (orchestrator coordinates all tasks).
  'proc:start': { req: { id: AppId }; res: void };
  'proc:stop': { req: { id: AppId }; res: void };
  'proc:restart': { req: { id: AppId }; res: void };
  'proc:list': { req: void; res: RunningProcess[] };

  // Task CRUD.
  'tasks:list': { req: { appId: AppId }; res: Task[] };
  /** All tasks for all apps in one query - used at boot instead of N+1 tasks:list calls. */
  'tasks:listAll': { req: void; res: Record<string, Task[]> };
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

  // Visibility-gated log streaming: the renderer subscribes to the task(s) it's showing so
  // main only forwards `task:log` events for those, instead of every running task.
  'task:subscribeLogs': { req: { id: TaskId }; res: void };
  'task:unsubscribeLogs': { req: { id: TaskId }; res: void };

  // Cross-task global log search (fans over every live task's buffer in main).
  'logs:searchAll': { req: { query: string; flags?: string; limit?: number }; res: GlobalLogMatch[] };

  // Resize the PTY when the renderer's xterm grid changes.
  'task:resize': { req: { id: TaskId; cols: number; rows: number }; res: void };

  // Run history.
  'runs:list': { req: { appId: AppId; limit?: number }; res: RunHistoryRow[] };

  // Env files discovered in a project (read-only - for the side panel).
  'env:files': { req: { id: AppId }; res: EnvFileInfo[] };

  // Settings.
  'settings:get': { req: void; res: SettingsState };
  'settings:set': { req: { patch: Partial<SettingsState> }; res: SettingsState };

  // Apply a downloaded auto-update (quit & install).
  'update:install': { req: void; res: void };
  /** Manual "Check for Updates…" - re-runs the feed check now. */
  'update:check': { req: void; res: void };

  // Diagnostics: DevHarbor's own local log file (no telemetry - for bug reports).
  'logs:path': { req: void; res: string };
  'logs:openFolder': { req: void; res: void };

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

  // Phase 8 - F21 folder operations. App-level folder field is set via apps:update.
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
  'update:available': { version: string; releaseNotes?: string };

  /** Download progress for an in-flight update. */
  'update:progress': { percent: number; bytesPerSecond: number; transferred: number; total: number };

  /** An update has finished downloading; the user should restart to install. */
  'update:ready': { version: string; releaseNotes?: string };

  /** The update feed could not be reached / validated (offline, rate-limited, signature). */
  'update:error': { message: string };

  /** A manual or periodic check found no newer version. */
  'update:notAvailable': { version: string };

  /** Deep link: focus a specific app. The renderer selects it in the sidebar. */
  'deepLink:focusApp': { appId: AppId };

  /** Deep link: a path was requested via open?path= but isn't registered. */
  'deepLink:unknownPath': { path: string };

  /**
   * Deep link: `devharbor://start?id=…` asked to start an app. We do NOT start it silently - 
   * any web page can fire this - so the renderer must confirm with the user first, then call
   * `proc:start`. This keeps a clicked link from running local shell commands without consent.
   */
  'deepLink:confirmStart': { appId: AppId; appName: string };

  /** macOS application-menu actions → renderer. (Settings ⌘, / Add App ⌘N / Add Folder ⌘⇧N) */
  'menu:openSettings': Record<string, never>;
  'menu:addApp': Record<string, never>;
  'menu:newFolder': Record<string, never>;
  /** Help → Check for Updates… - renderer invokes update:check so the result toasts. */
  'menu:checkUpdates': Record<string, never>;
  /** Help → Open Logs Folder - renderer invokes logs:openFolder. */
  'menu:openLogs': Record<string, never>;
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
  /** Show a desktop notification when a task crashes while DevHarbor is backgrounded. */
  notify_on_crash: boolean;
  /** Show a desktop notification when an app finishes starting (readiness reached). */
  notify_on_ready: boolean;
  /** Launch DevHarbor automatically at macOS login. */
  launch_at_login: boolean;
  /** Show the menubar tray icon. */
  tray_enabled: boolean;
  /** Keep at most this many run_history rows per app (older rows pruned on boot). */
  run_history_limit: number;
  /** Abort a task's start if its readiness signal hasn't fired within this many ms. */
  readiness_timeout_ms: number;
}

export type InvokeChannelName = keyof InvokeChannels;
export type EventChannelName = keyof EventChannels;

export type InvokeReq<C extends InvokeChannelName> = InvokeChannels[C]['req'];
export type InvokeRes<C extends InvokeChannelName> = InvokeChannels[C]['res'];
export type EventPayload<C extends EventChannelName> = EventChannels[C];

/**
 * The runtime allow-lists the preload bridge checks against. Derived from a `satisfies
 * Record<…, true>` map so that adding a channel to the type but forgetting it here is a
 * COMPILE error (and vice-versa) - the arrays can no longer silently drift from the types.
 */
const INVOKE_CHANNEL_FLAGS = {
  'app:ping': true,
  'apps:list': true,
  'apps:add': true,
  'apps:create': true,
  'apps:update': true,
  'apps:remove': true,
  'apps:detect': true,
  'apps:findByPath': true,
  'apps:scanFolder': true,
  'proc:start': true,
  'proc:stop': true,
  'proc:restart': true,
  'proc:list': true,
  'tasks:list': true,
  'tasks:listAll': true,
  'tasks:add': true,
  'tasks:update': true,
  'tasks:remove': true,
  'tasks:reorder': true,
  'task:start': true,
  'task:stop': true,
  'task:list': true,
  'task:readBuffer': true,
  'task:tailBuffer': true,
  'task:clearBuffer': true,
  'task:subscribeLogs': true,
  'task:unsubscribeLogs': true,
  'logs:searchAll': true,
  'task:resize': true,
  'runs:list': true,
  'env:files': true,
  'settings:get': true,
  'settings:set': true,
  'update:install': true,
  'update:check': true,
  'logs:path': true,
  'logs:openFolder': true,
  'openIn:caps': true,
  'openIn:open': true,
  'db:export': true,
  'db:reset': true,
  'db:path': true,
  'env:getGlobal': true,
  'env:setGlobal': true,
  'env:getApp': true,
  'env:setApp': true,
  'env:getTask': true,
  'env:setTask': true,
  'folders:list': true,
  'folders:rename': true,
  'folders:clear': true,
  'node:list': true,
  'node:resolve': true,
  'dialog:browse': true
} satisfies Record<InvokeChannelName, true>;

export const INVOKE_CHANNELS = Object.keys(INVOKE_CHANNEL_FLAGS) as InvokeChannelName[];

const EVENT_CHANNEL_FLAGS = {
  'task:log': true,
  'task:status': true,
  'task:stats': true,
  'task:ports': true,
  'proc:status': true,
  'env:fileChanged': true,
  'update:available': true,
  'update:progress': true,
  'update:ready': true,
  'update:error': true,
  'update:notAvailable': true,
  'deepLink:focusApp': true,
  'deepLink:unknownPath': true,
  'deepLink:confirmStart': true,
  'menu:openSettings': true,
  'menu:addApp': true,
  'menu:newFolder': true,
  'menu:checkUpdates': true,
  'menu:openLogs': true
} satisfies Record<EventChannelName, true>;

export const EVENT_CHANNELS = Object.keys(EVENT_CHANNEL_FLAGS) as EventChannelName[];

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
