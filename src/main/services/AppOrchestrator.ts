import { EventEmitter } from 'node:events';
import type {
  AppId,
  ProcessState,
  RunningProcess,
  RunningTask,
  Task,
  TaskId
} from '@shared/types';
import { AppRegistry } from './AppRegistry';
import { TaskRegistry } from './TaskRegistry';
import { TaskRunner, type TaskLogEvent, type TaskStatusEvent } from './TaskRunner';
import { topoLevels } from './topo';

/**
 * App-level lifecycle coordinator.
 *
 *   start(appId) → topo-sort enabled tasks, start each level in order, wait for
 *                  readiness before advancing.
 *   stop(appId)  → reverse-topo over currently-running tasks.
 *
 * App-level state is derived from the constituent task states (see specs/02-data-model.md).
 */
export class AppOrchestrator extends EventEmitter {
  // Sticky per-app outcome of the last run THIS session. Once every task is torn down,
  // there are no tracked tasks left to derive from, so without this the app would snap
  // back to 'idle' (reads as "never ran"). We keep it on 'exited' / 'crashed' until the
  // next start, so a stopped app stays visibly Stopped instead of flickering to Idle.
  private lastOutcome = new Map<AppId, 'exited' | 'crashed'>();

  // Per-app operation lock. start/stop/restart for one app are serialised so a file-change
  // restart can't overlap a user stop (or another restart) and double-spawn / interleave
  // (IMPROVEMENT-PLAN 7.4). Different apps still run concurrently.
  private readonly ops = new Map<AppId, Promise<unknown>>();

  // Cancellation hooks for in-flight starts. The lock serialises a queued stop BEHIND the
  // start - and doStartApp can sit awaiting readiness for up to readiness_timeout_ms per
  // level, which is exactly when users reach for Stop. stopApp/restartApp invoke this
  // synchronously (before enqueueing) so the blocked start bails out immediately.
  private readonly startCancels = new Map<AppId, () => void>();

  constructor(
    private readonly apps: AppRegistry,
    private readonly tasks: TaskRegistry,
    public readonly runner: TaskRunner
  ) {
    super();
    this.runner.on('status', (e: TaskStatusEvent) => this.onTaskStatus(e));
    this.runner.on('log', (e: TaskLogEvent) => this.emit('task:log', e));
  }

  /** Serialise an app-scoped operation behind any in-flight one for the same app. */
  private withLock<T>(appId: AppId, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(appId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive even if fn rejects (callers still see the real rejection).
    this.ops.set(
      appId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  /** Drop the sticky stopped/crashed badge for an app (called when it's removed). */
  clearOutcome(appId: AppId): void {
    this.lastOutcome.delete(appId);
    this.ops.delete(appId);
    this.startCancels.get(appId)?.();
    this.startCancels.delete(appId);
  }

  /** Snapshot of every running task across all apps. */
  listTasks(): RunningTask[] {
    return this.runner.list();
  }

  /**
   * App-level summaries. Includes every app with a running task PLUS any app that ran and
   * stopped this session (sticky `lastOutcome`) so a renderer reload (Cmd+R) re-hydrates the
   * Stopped/Crashed badge instead of snapping it back to Idle. Without the latter, the
   * `setRunningApps` snapshot - built only from running tasks - would erase the exited state.
   */
  listApps(): RunningProcess[] {
    const byApp = new Map<AppId, RunningTask[]>();
    for (const t of this.runner.list()) {
      const arr = byApp.get(t.appId) ?? [];
      arr.push(t);
      byApp.set(t.appId, arr);
    }
    const out = [...byApp.entries()].map(([appId, tasks]) => this.summariseApp(appId, tasks));
    for (const [appId, outcome] of this.lastOutcome) {
      if (byApp.has(appId)) continue; // already summarised from running tasks
      out.push(this.stoppedSummary(appId, outcome));
    }
    return out;
  }

  /**
   * Seed the sticky outcome for an app from persisted run history (called once on boot).
   * Lets a previously-run app show Stopped/Crashed after a relaunch instead of resetting to
   * Idle. Cleared on the next start. No-op for never-run apps (they stay Idle).
   */
  primeOutcome(appId: AppId, outcome: 'exited' | 'crashed'): void {
    this.lastOutcome.set(appId, outcome);
  }

  appState(appId: AppId): ProcessState {
    const all = this.tasks.list(appId).filter((t) => t.enabled);
    if (all.length === 0) return 'idle';
    const running = this.runner.list().filter((rt) => rt.appId === appId);
    const derived = deriveAppState(all, running);
    // No live tasks left, but it ran-and-stopped this session → keep the sticky outcome
    // (Stopped / Crashed) instead of reverting to a fresh-looking 'idle'.
    if (derived === 'idle' && this.lastOutcome.has(appId)) {
      return this.lastOutcome.get(appId)!;
    }
    return derived;
  }

  startApp(appId: AppId): Promise<void> {
    return this.withLock(appId, () => this.doStartApp(appId));
  }

  private async doStartApp(appId: AppId): Promise<void> {
    const allTasks = this.tasks.list(appId).filter((t) => t.enabled);
    if (allTasks.length === 0) {
      throw new Error('No enabled tasks for this app. Add one via Manage tasks.');
    }

    // Fresh run - drop any sticky "stopped/crashed" outcome from a previous run.
    this.lastOutcome.delete(appId);

    // Mark the app as recently used. Drives Dashboard recently-used sort and
    // History "last run" badges.
    try {
      this.apps.update(appId, { lastStartedAt: Date.now() });
    } catch {
      // best-effort; don't block start
    }

    const ids = allTasks.map((t) => t.id);
    const depsMap = new Map<TaskId, TaskId[]>();
    for (const t of allTasks) depsMap.set(t.id, t.dependsOn.filter((d) => ids.includes(d)));
    const levels = topoLevels<TaskId>(ids, depsMap);

    const byId = new Map<TaskId, Task>(allTasks.map((t) => [t.id, t]));

    // Stable within-level ordering: by position.
    for (const level of levels) {
      level.sort((a, b) => (byId.get(a)!.position ?? 0) - (byId.get(b)!.position ?? 0));
    }

    // Emit overall app status.
    this.emit('proc:status', {
      appId,
      state: 'starting' as ProcessState
    });

    let cancelled = false;

    // A queued stop/restart cancels this start synchronously, so we never sit on the lock
    // through a long readiness wait while the user's Stop click is stuck behind us.
    let stopRequested = false;
    const stopSignal = new Promise<void>((resolve) => {
      this.startCancels.set(appId, () => {
        stopRequested = true;
        resolve();
      });
    });

    try {
      for (const level of levels) {
        if (stopRequested) break;
        // Skip tasks already running (e.g. user manually started one).
        const toStart: Task[] = [];
        const awaitFor: Promise<boolean>[] = [];

        for (const id of level) {
          const t = byId.get(id)!;
          if (this.runner.isRunning(id)) {
            // Already running - still need to wait for readiness if not already ready.
            if (!this.runner.isReady(id)) {
              // We don't have a handle on the existing readiness promise here; skip waiting.
              // Practical effect: if the user manually started a task with a long readiness,
              // the orchestrator won't block on it. Acceptable for v1; document.
            }
            continue;
          }
          toStart.push(t);
        }

        // Start the level in parallel.
        const started = await Promise.all(toStart.map((t) => this.runner.start(t)));
        for (const s of started) awaitFor.push(s.awaitReady);

        // Wait for all to hit ready (or fail) - or for a stop to cancel the sequence. The
        // queued stop then tears down whatever already spawned.
        const results = await Promise.race([
          Promise.all(awaitFor),
          stopSignal.then(() => null)
        ]);
        if (results === null) break; // cancelled by a queued stop/restart
        if (results.some((ok) => !ok)) {
          cancelled = true;
          break;
        }
      }
    } catch (err) {
      // A task threw while spawning (folder moved, Node version missing, env build failed).
      // Always emit a terminal state so the renderer never hangs on 'starting'
      // (IMPROVEMENT-PLAN 5.4); the rejection still propagates so the caller can surface it.
      this.emit('proc:status', { appId, state: 'crashed' as ProcessState });
      throw err;
    } finally {
      this.startCancels.delete(appId);
    }

    if (stopRequested) {
      // The queued stop emits its own terminal status; just reflect the current state.
      this.emit('proc:status', { appId, state: this.appState(appId) });
      return;
    }

    this.emit('proc:status', {
      appId,
      state: cancelled ? ('crashed' as ProcessState) : this.appState(appId)
    });
  }

  stopApp(appId: AppId): Promise<void> {
    // Cancel any in-flight start FIRST (synchronously) so this stop isn't queued behind a
    // readiness wait that can hold the lock for up to readiness_timeout_ms per level.
    this.startCancels.get(appId)?.();
    return this.withLock(appId, () => this.doStopApp(appId));
  }

  private async doStopApp(appId: AppId): Promise<void> {
    const enabledTasks = this.tasks.list(appId).filter((t) => t.enabled);
    const ids = enabledTasks.map((t) => t.id);
    const depsMap = new Map<TaskId, TaskId[]>();
    for (const t of enabledTasks) depsMap.set(t.id, t.dependsOn.filter((d) => ids.includes(d)));

    let levels: TaskId[][];
    try {
      levels = topoLevels<TaskId>(ids, depsMap);
    } catch {
      // If the graph is somehow invalid, just stop every running task.
      const running = this.runner.list().filter((rt) => rt.appId === appId);
      await Promise.all(running.map((rt) => this.runner.stop(rt.taskId)));
      this.emit('proc:status', { appId, state: 'exited' as ProcessState });
      return;
    }

    this.emit('proc:status', { appId, state: 'exiting' as ProcessState });

    const runningIds = new Set(this.runner.list().filter((rt) => rt.appId === appId).map((rt) => rt.taskId));
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i]!.filter((id) => runningIds.has(id));
      await Promise.all(level.map((id) => this.runner.stop(id)));
    }

    this.emit('proc:status', { appId, state: 'exited' as ProcessState });
  }

  restartApp(appId: AppId): Promise<void> {
    // Cancel an in-flight start so the restart isn't queued behind its readiness waits.
    this.startCancels.get(appId)?.();
    // One lock acquisition for the whole stop→start so nothing interleaves between them.
    return this.withLock(appId, async () => {
      await this.doStopApp(appId);
      await new Promise((r) => setTimeout(r, 100));
      await this.doStartApp(appId);
    });
  }

  async startTask(taskId: TaskId): Promise<RunningTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const { snapshot } = await this.runner.start(task);
    return snapshot;
  }

  async stopTask(taskId: TaskId): Promise<void> {
    await this.runner.stop(taskId);
  }

  /** How many tasks are currently live (for the quit confirmation). Includes mid-spawn starts. */
  runningTaskCount(): number {
    const live = this.runner
      .list()
      .filter((t) => t.state === 'running' || t.state === 'starting' || t.state === 'exiting');
    const liveIds = new Set(live.map((t) => t.taskId));
    const pending = this.runner.pendingStartIds().filter((id) => !liveIds.has(id));
    return live.length + pending.length;
  }

  /**
   * Stop every running task, bounded by each task's kill-grace. Called on quit so dev
   * servers are torn down gracefully (SIGTERM → grace → SIGKILL tree) instead of being left
   * as orphans when the PTY master closes (IMPROVEMENT-PLAN 5.9). Mid-spawn starts are
   * included - runner.stop() awaits the pending spawn before killing it.
   */
  async stopAllRunning(): Promise<void> {
    const ids = new Set<TaskId>([
      ...this.runner.list().map((t) => t.taskId),
      ...this.runner.pendingStartIds()
    ]);
    await Promise.allSettled([...ids].map((id) => this.runner.stop(id)));
  }

  private onTaskStatus(e: TaskStatusEvent): void {
    this.emit('task:status', e);
    // Record a sticky app outcome when a task ends, so the app stays Stopped/Crashed
    // after teardown. 'crashed' wins over 'exited' if any task crashed this run.
    if (e.state === 'crashed') {
      this.lastOutcome.set(e.appId, 'crashed');
    } else if (e.state === 'exited' && this.lastOutcome.get(e.appId) !== 'crashed') {
      this.lastOutcome.set(e.appId, 'exited');
    }
    // Recompute app-level state and re-emit.
    this.emit('proc:status', {
      appId: e.appId,
      state: this.appState(e.appId)
    });
  }

  private summariseApp(appId: AppId, tasks: RunningTask[]): RunningProcess {
    const earliest = tasks.reduce<number>((min, t) => (t.startedAt < min ? t.startedAt : min), Date.now());
    const first = tasks[0]!;
    return {
      appId,
      pid: first.pid,
      state: this.appState(appId),
      startedAt: earliest,
      script: null,
      command: tasks.map((t) => t.command).join(' ∥ '),
      nodeVersion: first.nodeVersion,
      packageManager: first.packageManager,
      cpu: tasks.reduce((s, t) => s + t.cpu, 0),
      memMB: tasks.reduce((s, t) => s + t.memMB, 0),
      ports: tasks.flatMap((t) => t.ports),
      exitCode: null,
      exitSignal: null
    };
  }

  /** Minimal summary for an app that ran and stopped this session (no live tasks). */
  private stoppedSummary(appId: AppId, state: 'exited' | 'crashed'): RunningProcess {
    return {
      appId,
      pid: 0,
      state,
      startedAt: 0,
      script: null,
      command: '',
      nodeVersion: '',
      packageManager: 'npm',
      cpu: 0,
      memMB: 0,
      ports: [],
      exitCode: null,
      exitSignal: null
    };
  }
}

function deriveAppState(allTasks: Task[], running: RunningTask[]): ProcessState {
  const runningById = new Map(running.map((r) => [r.taskId, r]));

  let anyStarting = false;
  let anyCrashed = false;
  let anyExiting = false;
  let anyRunning = false;
  let anyNotReady = false;
  let anyExited = false;

  for (const t of allTasks) {
    const r = runningById.get(t.id);
    if (!r) {
      // Not tracked - either never started or already torn down.
      continue;
    }
    if (r.state === 'starting') anyStarting = true;
    if (r.state === 'exiting') anyExiting = true;
    if (r.state === 'crashed') anyCrashed = true;
    if (r.state === 'exited') anyExited = true;
    if (r.state === 'running') {
      anyRunning = true;
      if (!r.ready) anyNotReady = true;
    }
  }

  if (anyCrashed) return 'crashed';
  if (anyExiting) return 'exiting';
  if (anyStarting || anyNotReady) return 'starting';
  if (anyRunning) return 'running';
  // A task that's tracked-but-exited (the brief post-stop window before teardown) reads
  // as 'exited', not 'idle' - so the app doesn't flicker Idle → Exited → Idle on stop.
  if (anyExited) return 'exited';
  return 'idle';
}
