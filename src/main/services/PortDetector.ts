import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppId, TaskId } from '@shared/types';

const execFileP = promisify(execFile);
const POLL_MS = 2000;
// A log-hinted port that lsof never confirms within this many polls is dropped, so a
// transient "Port 3000 in use, trying 3001" line doesn't pin :3000 forever (IMPROVEMENT-PLAN 7.5).
const HINT_MAX_MISSES = 3;
const MAX_TREE_DEPTH = 6;

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
  /** Per-hint count of consecutive polls where lsof did NOT confirm the port. */
  hintMisses: Map<number, number>;
}

const URL_PORT_RE = /\blocalhost:(\d{2,5})\b|\b(?:https?|ws):\/\/[^\s/]+:(\d{2,5})\b/g;
const LISTEN_PORT_RE = /\blistening\s+on\s+(?:port\s+)?:?(\d{2,5})\b/gi;

/**
 * Detects which TCP ports each task is listening on. Two pronged:
 * - Stdout parsing for `localhost:<port>` and "listening on :<port>" patterns.
 * - `lsof` poll every 2s over the task's process tree.
 *
 * Emits 'ports' { taskId, appId, ports } when the set changes.
 */
export class PortDetector extends EventEmitter {
  private readonly tracked = new Map<TaskId, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  track(taskId: TaskId, appId: AppId, pid: number): void {
    this.tracked.set(taskId, {
      taskId,
      appId,
      pid,
      knownPorts: new Set(),
      hinted: new Set(),
      hintMisses: new Map()
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
    const tasks = [...this.tracked.values()];
    if (tasks.length === 0 || this.inFlight) return;
    this.inFlight = true;
    try {
      // ONE `ps` snapshot for the whole machine instead of one `pgrep -P` per process in
      // every task's tree, every tick (IMPROVEMENT-PLAN 9.2). With N tasks this turns
      // ~25-35 forks/sec into 2: one ps + one lsof.
      const childrenByPpid = await snapshotProcessTree();

      const descByTask = new Map<TaskId, Set<number>>();
      const allPids = new Set<number>();
      for (const t of tasks) {
        const desc = descendantsFromSnapshot(t.pid, childrenByPpid, MAX_TREE_DEPTH);
        descByTask.set(t.taskId, desc);
        for (const p of desc) allPids.add(p);
      }

      const lsofResult =
        allPids.size > 0
          ? await lsofPortsByPid([...allPids])
          : { byPid: new Map<number, Set<number>>(), failed: false };
      const portsByPid = lsofResult.byPid;

      for (const t of tasks) {
        const desc = descByTask.get(t.taskId) ?? new Set<number>();
        const observed = new Set<number>();
        for (const pid of desc) {
          const ps = portsByPid.get(pid);
          if (ps) for (const p of ps) observed.add(p);
        }

        // Prune stale hints: a hinted port lsof hasn't confirmed for HINT_MAX_MISSES polls is
        // dropped (kills the "Port 3000 in use, trying 3001" false positive). A tick where
        // lsof itself produced nothing (failed with no output) proves nothing about any hint - 
        // counting it as a miss would erase every hinted port within seconds, so skip pruning.
        for (const port of [...t.hinted]) {
          if (observed.has(port)) {
            t.hintMisses.delete(port);
          } else if (!lsofResult.failed) {
            const misses = (t.hintMisses.get(port) ?? 0) + 1;
            if (misses >= HINT_MAX_MISSES) {
              t.hinted.delete(port);
              t.hintMisses.delete(port);
            } else {
              t.hintMisses.set(port, misses);
            }
          }
        }

        // Same reasoning for lsof-confirmed ports: on a failed tick, keep the previous set
        // instead of blanking every task's chips because one pid in the union was stale.
        if (lsofResult.failed && observed.size === 0) continue;

        const merged = new Set<number>([...observed, ...t.hinted]);
        if (!setsEqual(t.knownPorts, merged)) {
          t.knownPorts = merged;
          this.emit('ports', {
            taskId: t.taskId,
            appId: t.appId,
            ports: [...merged].sort((a, b) => a - b)
          } satisfies PortsEvent);
        }
      }
    } catch {
      // ignore transient ps/lsof failure
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * One `ps` for the whole process table → map of ppid → child pids. Zombies are excluded:
 * a reaped-but-unwaited child would otherwise poison the batched lsof call below (lsof
 * exits non-zero when ANY pid in `-p` can't be opened).
 */
async function snapshotProcessTree(): Promise<Map<number, number[]>> {
  const byPpid = new Map<number, number[]>();
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,stat=']);
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (!m) continue;
      if (m[3]!.startsWith('Z')) continue; // zombie - skip
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const arr = byPpid.get(ppid);
      if (arr) arr.push(pid);
      else byPpid.set(ppid, [pid]);
    }
  } catch {
    // ps failed - return what we have (empty), callers treat as "no descendants".
  }
  return byPpid;
}

/** BFS the snapshot to collect a root pid and all its descendants (bounded depth). */
function descendantsFromSnapshot(
  rootPid: number,
  childrenByPpid: Map<number, number[]>,
  maxDepth: number
): Set<number> {
  const all = new Set<number>([rootPid]);
  let frontier = [rootPid];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of childrenByPpid.get(pid) ?? []) {
        if (all.has(child)) continue;
        all.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return all;
}

/**
 * One `lsof` for ALL tracked pids → map of pid → listening ports.
 *
 * lsof exits non-zero whenever ANY pid in `-p p1,p2,…` can't be located (it died between the
 * ps snapshot and this call) - even though it still prints valid records for the live pids.
 * promisified execFile rejects on non-zero exit but carries the stdout, so SALVAGE it: with
 * a union of many tasks' pids, discarding the output on every stale pid would blank port
 * chips for every task whenever one short-lived child is reaped mid-tick.
 * `failed` is true only when there was no output at all (proves nothing about any port).
 */
async function lsofPortsByPid(
  pids: number[]
): Promise<{ byPid: Map<number, Set<number>>; failed: boolean }> {
  const out = new Map<number, Set<number>>();
  const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-Fpn', '-p', pids.join(',')];
  let stdout: string;
  try {
    ({ stdout } = await execFileP('lsof', args));
  } catch (e) {
    const salvaged = (e as { stdout?: string }).stdout;
    if (!salvaged) {
      // No output at all - lsof genuinely failed (or nothing matched). Mark failed so the
      // caller keeps previous state instead of treating this as "no ports anywhere".
      return { byPid: out, failed: true };
    }
    stdout = salvaged;
  }
  // -Fpn output interleaves `p<pid>` (process) records with `n<name>` (file) records.
  let currentPid: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      currentPid = Number.isFinite(n) ? n : null;
    } else if (line.startsWith('n') && currentPid != null) {
      // "n*:3000", "n127.0.0.1:3000", "n[::1]:3000"
      const m = line.match(/:(\d{2,5})$/);
      if (m) {
        const p = Number(m[1]);
        if (p >= 1 && p <= 65535) {
          const set = out.get(currentPid) ?? new Set<number>();
          set.add(p);
          out.set(currentPid, set);
        }
      }
    }
  }
  return { byPid: out, failed: false };
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
