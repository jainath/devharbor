import { EventEmitter } from 'node:events';
import { spawn as ptySpawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import treeKill from 'tree-kill';
import { isAbsolute, join } from 'node:path';
import type {
  App,
  PackageManager,
  ProcessState,
  RunningTask,
  Task,
  TaskId
} from '@shared/types';
import { AppRegistry } from './AppRegistry';
import { NodeResolver } from './NodeResolver';
import { EnvBuilder } from './EnvBuilder';
import { LogBuffer } from './LogBuffer';
import { RunHistory } from './RunHistory';
import { StatsMonitor, type StatsTick } from './StatsMonitor';
import { PortDetector, type PortsEvent } from './PortDetector';
import type { Settings } from './Settings';
import {
  createReadinessWatcher,
  type ReadinessHandle,
  type ReadinessWatcher
} from './readiness';

interface Tracked {
  pty: IPty;
  task: Task;
  app: App;
  pid: number;
  state: ProcessState;
  ready: boolean;
  startedAt: number;
  command: string;
  nodeVersion: string;
  packageManager: PackageManager;
  exitCode: number | null;
  exitSignal: string | null;
  ports: number[];
  cpu: number;
  memMB: number;
  userKilled: boolean;
  logListeners: Set<(chunk: string) => void>;
  statusListeners: Set<(state: ProcessState, exitCode: number | null) => void>;
  readinessWatcher: ReadinessWatcher | null;
  runId: string | null;
  // Coalesced-IPC batching state.
  batchedChunks: string[];
  batchedBytes: number;
  batchTimer: NodeJS.Timeout | null;
}

// Coalesce log chunks: flush after BATCH_DELAY_MS of quiet OR when BATCH_MAX_BYTES accrued.
const BATCH_DELAY_MS = 33;          // ~30Hz
const BATCH_MAX_BYTES = 16 * 1024;  // 16KB
const DEFAULT_KILL_GRACE_MS = 5000;

export type TaskLogEvent = {
  taskId: TaskId;
  appId: App['id'];
  chunk: string;
  ts: number;
};
export type TaskStatusEvent = {
  taskId: TaskId;
  appId: App['id'];
  state: ProcessState;
  ready: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
};


/**
 * Owns the lifecycle of a single task's PTY. The AppOrchestrator coordinates many of these.
 */
export class TaskRunner extends EventEmitter {
  private readonly tracked = new Map<TaskId, Tracked>();

  constructor(
    private readonly registry: AppRegistry,
    private readonly env: EnvBuilder,
    private readonly nodes = new NodeResolver(),
    public readonly logs = new LogBuffer(),
    private readonly history = new RunHistory(),
    public readonly stats = new StatsMonitor(),
    public readonly ports = new PortDetector(),
    private readonly settings: Settings | null = null
  ) {
    super();

    // Re-broadcast stats/ports as a unified `stats` event keyed by appId+taskId.
    this.stats.on('stats', (e: StatsTick) => this.onStatsTick(e));
    this.ports.on('ports', (e: PortsEvent) => this.onPortsTick(e));
  }

  /** Read the persistent log buffer for a task (used by the renderer on tab mount). */
  readBuffer(taskId: TaskId): string {
    return this.logs.read(taskId);
  }

  /** Last N lines from the buffer — used by the crash-pin UI. */
  tailBuffer(taskId: TaskId, maxLines = 200): string {
    return this.logs.tail(taskId, maxLines);
  }

  clearBuffer(taskId: TaskId): void {
    this.logs.clear(taskId);
  }

  resize(taskId: TaskId, cols: number, rows: number): void {
    const t = this.tracked.get(taskId);
    if (!t) return;
    try {
      t.pty.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
    } catch {
      // PTY may have exited mid-resize; ignore.
    }
  }

  list(): RunningTask[] {
    return [...this.tracked.values()].map(toRunningTask);
  }

  get(taskId: TaskId): RunningTask | null {
    const t = this.tracked.get(taskId);
    return t ? toRunningTask(t) : null;
  }

  isRunning(taskId: TaskId): boolean {
    const t = this.tracked.get(taskId);
    return !!t && (t.state === 'starting' || t.state === 'running');
  }

  isReady(taskId: TaskId): boolean {
    return this.tracked.get(taskId)?.ready ?? false;
  }

  /**
   * Start one task. Returns a snapshot of the running state.
   * `awaitReady` returns a promise that resolves to true if the task hits its
   * readiness signal, false if it exited first.
   */
  async start(task: Task): Promise<{ snapshot: RunningTask; awaitReady: Promise<boolean> }> {
    if (this.isRunning(task.id)) {
      const t = this.tracked.get(task.id)!;
      return { snapshot: toRunningTask(t), awaitReady: t.readinessWatcher?.ready ?? Promise.resolve(t.ready) };
    }

    const app = this.registry.get(task.appId);
    if (!app) throw new Error(`Unknown app for task: ${task.appId}`);

    const pm: PackageManager = task.packageManagerOverride ?? app.packageManager ?? 'npm';
    const nodePref = task.nodeVersionPrefOverride ?? app.nodeVersionPref;
    const cwd = resolveWorkingDir(app, task);
    const node = this.nodes.resolve(nodePref, cwd);

    const { file, args, commandStr } = buildCommand({
      pm,
      kind: task.commandKind,
      script: task.script,
      customCommand: task.customCommand
    });

    const env = await this.env.build({ app, task, nodeBinDir: node.binDir, cwd });

    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env
    });

    // Open a run_history row.
    const runId = this.history.start({
      appId: app.id,
      taskId: task.id,
      taskName: task.name,
      script: task.script,
      customCommand: task.customCommand,
      nodeVersion: node.version,
      packageManager: pm
    });

    const tracked: Tracked = {
      pty,
      task,
      app,
      pid: pty.pid,
      state: 'starting',
      ready: false,
      startedAt: Date.now(),
      command: commandStr,
      nodeVersion: node.version,
      packageManager: pm,
      exitCode: null,
      exitSignal: null,
      ports: [],
      cpu: 0,
      memMB: 0,
      userKilled: false,
      logListeners: new Set(),
      statusListeners: new Set(),
      readinessWatcher: null,
      runId,
      batchedChunks: [],
      batchedBytes: 0,
      batchTimer: null
    };
    this.tracked.set(task.id, tracked);

    // Start stats + port monitoring.
    this.stats.track(task.id, app.id, pty.pid);
    this.ports.track(task.id, app.id, pty.pid);

    // Bridge PTY → durable log buffer + coalesced IPC + readiness + port hint listeners.
    pty.onData((chunk: string) => {
      this.logs.append(task.id, chunk);
      this.ports.observeChunk(task.id, chunk);
      for (const l of tracked.logListeners) {
        try {
          l(chunk);
        } catch {
          // ignore listener errors
        }
      }
      this.queueLogEmit(tracked, chunk);
    });

    pty.onExit(({ exitCode, signal }) => {
      const t = this.tracked.get(task.id);
      if (!t) return;
      // Flush any pending coalesced log chunk before status flips.
      this.flushLogEmit(t);
      t.exitCode = exitCode;
      t.exitSignal = signal ? String(signal) : null;
      t.state = t.userKilled
        ? 'exited'
        : exitCode === 0
        ? 'exited'
        : 'crashed';

      // Close the run_history row.
      if (t.runId) {
        this.history.finish(t.runId, {
          exitCode: t.exitCode,
          exitSignal: t.exitSignal,
          wasKilledByUser: t.userKilled
        });
      }

      for (const l of t.statusListeners) {
        try {
          l(t.state, t.exitCode);
        } catch {
          // ignore
        }
      }
      this.emitStatus(t);
      // Stop monitoring this task immediately.
      this.stats.untrack(task.id);
      this.ports.untrack(task.id);
      // Keep around briefly so the renderer can read final state.
      setTimeout(() => {
        const cur = this.tracked.get(task.id);
        if (cur && (cur.state === 'exited' || cur.state === 'crashed')) {
          cur.readinessWatcher?.dispose();
          this.tracked.delete(task.id);
        }
      }, 1500);
    });

    // Flip to 'running' next tick so the UI sees the transition.
    // Guarded: if the process exited synchronously (instant crash), onExit already
    // set state to exited/crashed — don't overwrite.
    setTimeout(() => {
      const t = this.tracked.get(task.id);
      if (!t) return;
      if (t.state !== 'starting') return;
      t.state = 'running';
      for (const l of t.statusListeners) {
        try {
          l(t.state, null);
        } catch {
          // ignore
        }
      }
      this.emitStatus(t);
    }, 0);

    // Set up the readiness watcher.
    const handle: ReadinessHandle = {
      pid: tracked.pid,
      onLog: (listener) => {
        tracked.logListeners.add(listener);
        return () => tracked.logListeners.delete(listener);
      },
      onStatus: (listener) => {
        tracked.statusListeners.add(listener);
        return () => tracked.statusListeners.delete(listener);
      }
    };
    const watcher = createReadinessWatcher(task.readiness, handle);
    tracked.readinessWatcher = watcher;

    void watcher.ready.then((ok) => {
      const t = this.tracked.get(task.id);
      if (!t) return;
      t.ready = ok;
      this.emitStatus(t);
    });

    this.emitStatus(tracked);
    return { snapshot: toRunningTask(tracked), awaitReady: watcher.ready };
  }

  async stop(taskId: TaskId): Promise<void> {
    const t = this.tracked.get(taskId);
    if (!t) return;
    if (t.state !== 'running' && t.state !== 'starting') return;

    t.userKilled = true;
    t.state = 'exiting';
    this.emitStatus(t);

    try {
      t.pty.kill('SIGTERM');
    } catch {
      // ignore
    }

    const grace = this.settings?.get('kill_grace_ms') ?? DEFAULT_KILL_GRACE_MS;

    await new Promise<void>((resolve) => {
      const escalate = setTimeout(() => {
        treeKill(t.pid, 'SIGKILL', () => {});
        resolve();
      }, grace);

      const tickUntilExit = setInterval(() => {
        const cur = this.tracked.get(taskId);
        if (!cur || cur.state === 'exited' || cur.state === 'crashed') {
          clearTimeout(escalate);
          clearInterval(tickUntilExit);
          resolve();
        }
      }, 100);
    });
  }

  private queueLogEmit(t: Tracked, chunk: string): void {
    t.batchedChunks.push(chunk);
    t.batchedBytes += chunk.length;
    if (t.batchedBytes >= BATCH_MAX_BYTES) {
      this.flushLogEmit(t);
      return;
    }
    if (t.batchTimer == null) {
      t.batchTimer = setTimeout(() => this.flushLogEmit(t), BATCH_DELAY_MS);
    }
  }

  private flushLogEmit(t: Tracked): void {
    if (t.batchTimer != null) {
      clearTimeout(t.batchTimer);
      t.batchTimer = null;
    }
    if (t.batchedChunks.length === 0) return;
    const merged = t.batchedChunks.join('');
    t.batchedChunks = [];
    t.batchedBytes = 0;
    this.emit('log', {
      taskId: t.task.id,
      appId: t.app.id,
      chunk: merged,
      ts: Date.now()
    } satisfies TaskLogEvent);
  }

  private onStatsTick(e: StatsTick): void {
    const t = this.tracked.get(e.taskId);
    if (t) {
      t.cpu = e.cpu;
      t.memMB = e.memMB;
    }
    this.emit('stats', e);
  }

  private onPortsTick(e: PortsEvent): void {
    const t = this.tracked.get(e.taskId);
    if (t) t.ports = e.ports;
    this.emit('ports', e);
  }

  private emitStatus(t: Tracked): void {
    const evt: TaskStatusEvent = {
      taskId: t.task.id,
      appId: t.app.id,
      state: t.state,
      ready: t.ready,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal
    };
    this.emit('status', evt);
  }
}

function resolveWorkingDir(app: App, task: Task): string {
  if (!task.workingDirOverride) return app.workingDir;
  if (isAbsolute(task.workingDirOverride)) return task.workingDirOverride;
  return join(app.path, task.workingDirOverride);
}

function buildCommand(args: {
  pm: PackageManager;
  kind: 'script' | 'custom';
  script: string | null;
  customCommand: string | null;
}): { file: string; args: string[]; commandStr: string } {
  if (args.kind === 'custom') {
    const cmd = args.customCommand;
    if (!cmd) throw new Error('Custom task has no command.');
    const shell = process.env.SHELL || '/bin/sh';
    return { file: shell, args: ['-l', '-c', cmd], commandStr: cmd };
  }
  const script = args.script;
  if (!script) throw new Error('Script task has no script name.');
  switch (args.pm) {
    case 'npm':
      return { file: 'npm', args: ['run', script], commandStr: `npm run ${script}` };
    case 'yarn':
      return { file: 'yarn', args: [script], commandStr: `yarn ${script}` };
    case 'pnpm':
      return { file: 'pnpm', args: ['run', script], commandStr: `pnpm run ${script}` };
    case 'bun':
      return { file: 'bun', args: ['run', script], commandStr: `bun run ${script}` };
  }
}

function toRunningTask(t: Tracked): RunningTask {
  return {
    taskId: t.task.id,
    appId: t.app.id,
    pid: t.pid,
    state: t.state,
    ready: t.ready,
    startedAt: t.startedAt,
    command: t.command,
    nodeVersion: t.nodeVersion,
    packageManager: t.packageManager,
    cpu: t.cpu,
    memMB: t.memMB,
    ports: t.ports,
    exitCode: t.exitCode,
    exitSignal: t.exitSignal
  };
}
