import { EventEmitter } from 'node:events';
import pidusage from 'pidusage';
import type { AppId, TaskId } from '@shared/types';

export interface StatsTick {
  taskId: TaskId;
  appId: AppId;
  cpu: number;     // percent
  memMB: number;
}

interface Tracked {
  taskId: TaskId;
  appId: AppId;
  pid: number;
}

/**
 * Polls pidusage for each tracked task and emits 'stats' events.
 * Interval is configurable; defaults to 1000ms.
 */
export class StatsMonitor extends EventEmitter {
  private readonly tracked = new Map<TaskId, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private inFlight = false;

  constructor(intervalMs = 1000) {
    super();
    this.intervalMs = intervalMs;
  }

  setInterval(ms: number): void {
    this.intervalMs = Math.max(200, ms);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  track(taskId: TaskId, appId: AppId, pid: number): void {
    this.tracked.set(taskId, { taskId, appId, pid });
    this.start();
  }

  untrack(taskId: TaskId): void {
    this.tracked.delete(taskId);
    if (this.tracked.size === 0) this.stop();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.tracked.size === 0 || this.inFlight) return;
    this.inFlight = true;
    try {
      const entries = [...this.tracked.values()];
      const pids = entries.map((e) => e.pid);

      // ONE `ps` for all tracked pids instead of one fork per task per tick (pidusage
      // comma-joins an array into a single ps call). With 10 running tasks this turns 10
      // fork+exec per second into 1 (IMPROVEMENT-PLAN 9.2).
      let byPid: Record<number, { cpu: number; memory: number }> = {};
      try {
        byPid = (await pidusage(pids)) as Record<number, { cpu: number; memory: number }>;
      } catch {
        // pidusage rejects the WHOLE batch if any pid vanished mid-tick - fall back to
        // per-pid so the survivors still report (the runner's onExit untracks the dead one).
        await Promise.all(
          entries.map(async (e) => {
            try {
              const s = await pidusage(e.pid);
              byPid[e.pid] = { cpu: s.cpu, memory: s.memory };
            } catch {
              // process gone - skip
            }
          })
        );
      }

      for (const e of entries) {
        const s = byPid[e.pid];
        if (!s) continue;
        this.emit('stats', {
          taskId: e.taskId,
          appId: e.appId,
          cpu: Math.max(0, s.cpu),
          memMB: Math.round(s.memory / (1024 * 1024))
        } satisfies StatsTick);
      }
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.stop();
    this.tracked.clear();
  }
}
