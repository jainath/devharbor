export type AppId = string & { readonly __brand: 'AppId' };

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export type NodeVersionPref =
  | { kind: 'auto' }
  | { kind: 'system' }
  | { kind: 'explicit'; version: string };

export interface App {
  id: AppId;
  name: string;
  path: string;
  color: string;
  icon?: string;
  nodeVersionPref: NodeVersionPref;
  packageManager: PackageManager | null;
  defaultScript: string | null;
  customCommand: string | null;
  workingDir: string;
  autoRestartOnChange: boolean;
  /** Start this app automatically when DevHarbor launches. */
  autoStart: boolean;
  watchGlobs: string[];
  portHint: number | null;
  tags: string[];
  /** Phase 8: visual grouping in the sidebar. NULL = "(Ungrouped)". One folder per app. */
  folder: string | null;
  lastStartedAt: number | null;
  lastExitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnvVar {
  id: string;
  appId: AppId | null;
  key: string;
  value: string;
  enabled: boolean;
  isSecret: boolean;
  note?: string;
}

export type ProcessState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'exiting'
  | 'exited'
  | 'crashed';

export interface RunningProcess {
  appId: AppId;
  pid: number;
  state: ProcessState;
  startedAt: number;
  script: string | null;
  command: string;
  nodeVersion: string;
  packageManager: PackageManager;
  cpu: number;
  memMB: number;
  ports: number[];
  exitCode: number | null;
  exitSignal: string | null;
}

export type TaskId = string & { readonly __brand: 'TaskId' };

export type ReadinessSignal =
  | { kind: 'none' }
  | { kind: 'port'; port: number; host?: string }
  | { kind: 'log'; regex: string; flags?: string }
  | { kind: 'exit'; code?: number }
  | { kind: 'delay'; ms: number };

export type CommandKind = 'script' | 'custom';

export interface Task {
  id: TaskId;
  appId: AppId;
  name: string;
  position: number;
  commandKind: CommandKind;
  script: string | null;
  customCommand: string | null;
  workingDirOverride: string | null;
  packageManagerOverride: PackageManager | null;
  nodeVersionPrefOverride: NodeVersionPref | null;
  dependsOn: TaskId[];
  readiness: ReadinessSignal;
  oneShot: boolean;
  enabled: boolean;
  envOverrides: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface RunningTask {
  taskId: TaskId;
  appId: AppId;
  pid: number;
  state: ProcessState;
  ready: boolean;
  startedAt: number;
  command: string;
  nodeVersion: string;
  packageManager: PackageManager;
  cpu: number;
  memMB: number;
  ports: number[];
  exitCode: number | null;
  exitSignal: string | null;
}

export interface WorkspaceCandidate {
  /** Package name (or directory name) of the workspace package. */
  name: string;
  /** Path relative to the repo root, e.g. "apps/api". */
  relPath: string;
  scripts: string[];
  suggestedScript: string | null;
}

export interface DetectionResult {
  packageManager: PackageManager | null;
  nodeVersionFromProject: string | null;
  scripts: Record<string, string>;
  hasEnvFile: boolean;
  envFiles: string[];
  suggestedDefaultScript: string | null;
  /** False when the chosen folder has no package.json - the add flow warns instead of silently accepting. */
  hasPackageJson: boolean;
  /** Workspace packages found via pnpm-workspace.yaml / package.json "workspaces" (monorepo support). */
  workspaces: WorkspaceCandidate[];
}

export interface NodeInstallation {
  source: 'nvm' | 'fnm' | 'volta' | 'asdf' | 'system';
  version: string;
  binDir: string;
}
