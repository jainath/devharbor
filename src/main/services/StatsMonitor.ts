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
    if (this.tracked.size === 0) return;
    const entries = [...this.tracked.values()];
    const results = await Promise.all(
      entries.map(async (t) => {
        try {
          const stats = await pidusage(t.pid);
          return { t, cpu: stats.cpu, memMB: Math.round(stats.memory / (1024 * 1024)) };
        } catch {
          // Process exited between ticks — drop silently; the runner's onExit will untrack.
          return null;
        }
      })
    );
    for (const r of results) {
      if (!r) continue;
      this.emit('stats', {
        taskId: r.t.taskId,
        appId: r.t.appId,
        cpu: Math.max(0, r.cpu),
        memMB: r.memMB
      } satisfies StatsTick);
    }
  }

  dispose(): void {
    this.stop();
    this.tracked.clear();
  }
}
