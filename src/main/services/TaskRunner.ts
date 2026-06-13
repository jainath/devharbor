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
  // Serialises concurrent start() calls for the SAME task to a single spawn. Without this,
  // `proc:start` + `task:start` (or restart-watcher + a user click) race between the
  // isRunning check and tracked.set and both spawn a PTY (IMPROVEMENT-PLAN 5.3).
  private readonly pending = new Map<TaskId, Promise<{ snapshot: RunningTask; awaitReady: Promise<boolean> }>>();

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

  /** Last N lines from the buffer - used by the crash-pin UI. */
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

  /** Task ids whose start() is still mid-spawn (not yet tracked). The quit path must count
      and stop these too, or a spawn completing after teardown leaves an orphan process. */
  pendingStartIds(): TaskId[] {
    return [...this.pending.keys()];
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
   *
   * Concurrency-safe: if the task is already live (starting/running/exiting) the existing
   * run is returned; if another start() for the same task is mid-flight, its promise is
   * shared rather than spawning a second PTY.
   */
  start(task: Task): Promise<{ snapshot: RunningTask; awaitReady: Promise<boolean> }> {
    const cur = this.tracked.get(task.id);
    if (cur && (cur.state === 'starting' || cur.state === 'running')) {
      return Promise.resolve({
        snapshot: toRunningTask(cur),
        awaitReady: cur.readinessWatcher?.ready ?? Promise.resolve(cur.ready)
      });
    }
    const inflight = this.pending.get(task.id);
    if (inflight) return inflight;
    // 'exiting' = a stop's kill-grace window. Returning the DYING run here would make the
    // caller's start a no-op (its awaitReady may even already be true), so the user's fresh
    // Start would silently never restart the task. Wait for the teardown to finish, then
    // spawn a new run - deduped through `pending` like any other start.
    const p = (
      cur && cur.state === 'exiting'
        ? this.waitForTeardown(task.id, cur).then(() => this.doStart(task))
        : this.doStart(task)
    ).finally(() => this.pending.delete(task.id));
    this.pending.set(task.id, p);
    return p;
  }

  /** Resolve once the given run is gone from tracking (or replaced). Bounded wait. */
  private async waitForTeardown(taskId: TaskId, run: Tracked): Promise<void> {
    const grace = this.settings?.get('kill_grace_ms') ?? DEFAULT_KILL_GRACE_MS;
    const deadline = Date.now() + grace + 5000;
    while (Date.now() < deadline) {
      const cur = this.tracked.get(taskId);
      if (cur !== run || cur.state === 'exited' || cur.state === 'crashed') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async doStart(
    task: Task
  ): Promise<{ snapshot: RunningTask; awaitReady: Promise<boolean> }> {
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

    // env.build is BEFORE spawn - a failure here throws with no live process to orphan.
    const env = await this.env.build({ app, task, nodeBinDir: node.binDir, cwd });

    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env
    });

    // Open a run_history row. NON-FATAL: a DB hiccup here must not leave a spawned PTY with
    // no tracked entry / handlers (an unstoppable orphan) - the rest tolerates runId === null.
    let runId: string | null = null;
    try {
      runId = this.history.start({
        appId: app.id,
        taskId: task.id,
        taskName: task.name,
        script: task.script,
        customCommand: task.customCommand,
        nodeVersion: node.version,
        packageManager: pm
      });
    } catch (e) {
      console.warn('[taskrunner] run_history.start failed; continuing without a history row', e);
    }

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
    // Identity-guarded: a stale PTY (from a superseded run of the same task) must not feed
    // its output into the successor run.
    pty.onData((chunk: string) => {
      if (this.tracked.get(task.id) !== tracked) return;
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
      // Operate on THIS closure's own Tracked instance, never look it up by id - otherwise a
      // stale PTY's exit would mutate the successor run (mark it exited, finish its history,
      // untrack its live stats). Only touch shared/monitoring state if we're still current.
      const isCurrent = this.tracked.get(task.id) === tracked;
      this.flushLogEmit(tracked);
      tracked.exitCode = exitCode;
      tracked.exitSignal = signal ? String(signal) : null;
      tracked.state = tracked.userKilled ? 'exited' : exitCode === 0 ? 'exited' : 'crashed';

      if (tracked.runId) {
        this.history.finish(tracked.runId, {
          exitCode: tracked.exitCode,
          exitSignal: tracked.exitSignal,
          wasKilledByUser: tracked.userKilled
        });
        tracked.runId = null; // guard against a later force-finalize double-finishing
      }

      for (const l of tracked.statusListeners) {
        try {
          l(tracked.state, tracked.exitCode);
        } catch {
          // ignore
        }
      }
      tracked.readinessWatcher?.dispose();

      if (!isCurrent) return; // a newer run replaced this task - leave its state alone
      this.emitStatus(tracked);
      this.stats.untrack(task.id);
      this.ports.untrack(task.id);
      this.logs.markExited(task.id); // buffer becomes evictable + self-frees after a delay

      // Keep around briefly so the renderer can read final state, then delete (identity-checked).
      setTimeout(() => {
        if (this.tracked.get(task.id) === tracked) {
          this.tracked.delete(task.id);
        }
      }, 1500);
    });

    // Flip to 'running' next tick so the UI sees the transition.
    // Guarded: if the process exited synchronously (instant crash), onExit already set
    // state to exited/crashed - don't overwrite; and only act if still the current run.
    setTimeout(() => {
      if (this.tracked.get(task.id) !== tracked) return;
      if (tracked.state !== 'starting') return;
      tracked.state = 'running';
      for (const l of tracked.statusListeners) {
        try {
          l(tracked.state, null);
        } catch {
          // ignore
        }
      }
      this.emitStatus(tracked);
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
      if (this.tracked.get(task.id) !== tracked) return;
      tracked.ready = ok;
      this.emitStatus(tracked);
    });

    // Readiness timeout: without a deadline a port that never opens or a regex that never
    // matches leaves startApp blocked forever and the UI stuck on 'starting'
    // (IMPROVEMENT-PLAN 7.2). On timeout, if the task is still alive we stop blocking and
    // treat it as ready (so the spinner clears) rather than killing a healthy server.
    //
    // Deliberately NOT applied to 'exit' readiness (one-shots: migrations/builds - "ready"
    // means the process FINISHED; forcing ready at 60s would start dependents before the
    // prerequisite completed). For 'delay', honour the user's explicit wait even past the
    // timeout (plus slack) rather than cutting it short.
    const baseTimeout = this.settings?.get('readiness_timeout_ms') ?? 60_000;
    const timeoutMs =
      task.readiness.kind === 'exit'
        ? 0
        : task.readiness.kind === 'delay'
          ? Math.max(baseTimeout, task.readiness.ms + 5000)
          : baseTimeout;
    const awaitReady: Promise<boolean> =
      timeoutMs > 0
        ? new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (v: boolean): void => {
              if (settled) return;
              settled = true;
              clearTimeout(to);
              resolve(v);
            };
            const to = setTimeout(() => {
              if (this.tracked.get(task.id) === tracked && tracked.state === 'running') {
                console.warn(
                  `[taskrunner] readiness timed out for "${task.name}" after ${timeoutMs}ms; treating as ready`
                );
                tracked.ready = true;
                this.emitStatus(tracked);
                finish(true);
              } else {
                finish(false);
              }
            }, timeoutMs);
            void watcher.ready.then(finish);
          })
        : watcher.ready;

    this.emitStatus(tracked);
    return { snapshot: toRunningTask(tracked), awaitReady };
  }

  async stop(taskId: TaskId): Promise<void> {
    // A start() may still be mid-flight (awaiting env build, before tracked.set). Without
    // waiting for it, this stop would silently no-op and the process would spawn anyway - 
    // the user's click lost. Await the pending spawn, then stop the now-tracked run.
    const inflight = this.pending.get(taskId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // the start itself failed - nothing to stop
      }
    }
    const t = this.tracked.get(taskId);
    if (!t) return;
    if (t.state !== 'running' && t.state !== 'starting') return;

    t.userKilled = true;
    t.state = 'exiting';
    this.emitStatus(t);

    const grace = this.settings?.get('kill_grace_ms') ?? DEFAULT_KILL_GRACE_MS;

    // Graceful: signal the WHOLE process tree, not just the PTY child. For `npm run dev`
    // the real server is a grandchild, and a non-interactive `$SHELL -l -c` wrapper does not
    // forward SIGTERM - so signalling only the pty child usually skips graceful shutdown
    // (IMPROVEMENT-PLAN 7.1).
    //
    // All checks below are identity-aware (compare against THIS run's Tracked instance, not a
    // by-id lookup): if a new run of the same task spawns mid-wait, "the old instance is gone
    // from the map" means this stop is complete - it must never burn grace against, SIGKILL,
    // or force-finalize the successor's healthy process.
    this.signalTree(t.pid, 'SIGTERM');
    await this.waitForExit(taskId, t, grace);
    if (this.isRunExited(taskId, t)) return;

    // Escalate: SIGKILL the tree, then wait a bounded window for the exit event to actually
    // arrive before giving up - so 'exiting' is never a permanent dead-end.
    this.signalTree(t.pid, 'SIGKILL');
    await this.waitForExit(taskId, t, 2000);
    if (this.isRunExited(taskId, t)) return;

    // The OS never reported the exit - force the tracked entry to a terminal state so the UI
    // and orchestrator don't hang on a zombie 'exiting'.
    this.forceFinalize(taskId, t);
  }

  private signalTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      treeKill(pid, signal, () => {});
    } catch {
      // process may already be gone
    }
  }

  /** True when THIS run is finished - exited/crashed, or no longer the tracked entry. */
  private isRunExited(taskId: TaskId, run: Tracked): boolean {
    const cur = this.tracked.get(taskId);
    if (cur !== run) return true; // replaced or torn down - the old run is gone
    return cur.state === 'exited' || cur.state === 'crashed';
  }

  private async waitForExit(taskId: TaskId, run: Tracked, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        if (this.isRunExited(taskId, run) || Date.now() >= deadline) {
          clearInterval(tick);
          resolve();
        }
      }, 100);
    });
  }

  /** Last-resort: SIGKILL+grace elapsed and no exit event arrived. Synthesise the teardown. */
  private forceFinalize(taskId: TaskId, run: Tracked): void {
    if (this.tracked.get(taskId) !== run) return; // a successor run owns the slot now
    if (run.state === 'exited' || run.state === 'crashed') return;
    // Mirror the normal onExit teardown so nothing leaks from this synthetic path.
    this.flushLogEmit(run);
    run.state = 'exited';
    if (run.runId) {
      this.history.finish(run.runId, {
        exitCode: run.exitCode,
        exitSignal: run.exitSignal ?? 'SIGKILL',
        wasKilledByUser: true
      });
      run.runId = null;
    }
    run.readinessWatcher?.dispose();
    this.emitStatus(run);
    this.stats.untrack(taskId);
    this.ports.untrack(taskId);
    this.logs.markExited(taskId);
    this.tracked.delete(taskId);
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
