import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppId, TaskId } from '@shared/types';

const execFileP = promisify(execFile);
const POLL_MS = 2000;

export interface PortsEvent {
  taskId: TaskId;
  appId: AppId;
  ports: number[];
}

interface Tracked {
  taskId: TaskId;
  appId: AppId;
  pid: number;
  knownPorts: Set<number>;
  /** Ports inferred from stdout (e.g. "localhost:3000"); merged with lsof results. */
  hinted: Set<number>;
}

const URL_PORT_RE = /\blocalhost:(\d{2,5})\b|\b(?:https?|ws):\/\/[^\s/]+:(\d{2,5})\b/g;
const LISTEN_PORT_RE = /\blistening\s+on\s+(?:port\s+)?:?(\d{2,5})\b/gi;

/**
 * Detects which TCP ports each task is listening on. Two pronged:
 *  - Stdout parsing for `localhost:<port>` and "listening on :<port>" patterns.
 *  - `lsof` poll every 2s over the task's process tree.
 *
 * Emits 'ports' { taskId, appId, ports } when the set changes.
 */
export class PortDetector extends EventEmitter {
  private readonly tracked = new Map<TaskId, Tracked>();
  private timer: NodeJS.Timeout | null = null;

  track(taskId: TaskId, appId: AppId, pid: number): void {
    this.tracked.set(taskId, {
      taskId,
      appId,
      pid,
      knownPorts: new Set(),
      hinted: new Set()
    });
    this.start();
    // Immediate tick so quickly-listening processes (Vite, Astro) show their port
    // without waiting for the 2s interval.
    void this.tick();
  }

  untrack(taskId: TaskId): void {
    this.tracked.delete(taskId);
    if (this.tracked.size === 0) this.stop();
  }

  observeChunk(taskId: TaskId, chunk: string): void {
    const t = this.tracked.get(taskId);
    if (!t) return;
    const candidates = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = URL_PORT_RE.exec(chunk)) !== null) {
      const port = Number(m[1] ?? m[2]);
      if (port >= 1 && port <= 65535) candidates.add(port);
    }
    URL_PORT_RE.lastIndex = 0;
    while ((m = LISTEN_PORT_RE.exec(chunk)) !== null) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) candidates.add(port);
    }
    LISTEN_PORT_RE.lastIndex = 0;
    for (const p of candidates) t.hinted.add(p);
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    for (const t of this.tracked.values()) {
      try {
        const observed = await this.listListeningPortsFor(t);
        const merged = new Set<number>([...observed, ...t.hinted]);
        if (!setsEqual(t.knownPorts, merged)) {
          t.knownPorts = merged;
          this.emit('ports', {
            taskId: t.taskId,
            appId: t.appId,
            ports: [...merged].sort((a, b) => a - b)
          } satisfies PortsEvent);
        }
      } catch {
        // ignore transient lsof failure
      }
    }
  }

  private async listListeningPortsFor(t: Tracked): Promise<Set<number>> {
    // Walk the task's process group via `pgrep -P`. Depth 5 covers typical chains
    // (pty → npm → cross-spawn shell → tsx/nodemon → user binary).
    const pids = await collectDescendants(t.pid, 5);
    if (pids.size === 0) return new Set();
    const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-Fpn', '-p', [...pids].join(',')];
    try {
      const { stdout } = await execFileP('lsof', args);
      const out = new Set<number>();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith('n')) continue;
        // Possible formats: "n*:3000", "n127.0.0.1:3000", "n[::1]:3000"
        const m = line.match(/:(\d{2,5})$/);
        if (m) {
          const p = Number(m[1]);
          if (p >= 1 && p <= 65535) out.add(p);
        }
      }
      return out;
    } catch {
      // lsof exits non-zero when nothing matches the filter — treat as "no ports".
      return new Set();
    }
  }
}

async function collectDescendants(rootPid: number, maxDepth: number): Promise<Set<number>> {
  const all = new Set<number>([rootPid]);
  let frontier = [rootPid];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const pid of frontier) {
      try {
        const { stdout } = await execFileP('pgrep', ['-P', String(pid)]);
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const n = Number(trimmed);
          if (!Number.isFinite(n) || n <= 0) continue;
          if (all.has(n)) continue;
          all.add(n);
          next.push(n);
        }
      } catch {
        // pgrep exits 1 when no children; treat as none.
      }
    }
    frontier = next;
  }
  return all;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
