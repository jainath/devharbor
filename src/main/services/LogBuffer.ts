import type { TaskId } from '@shared/types';

interface Buffer {
  chunks: string[];
  bytes: number;
  lastTouch: number;
  exited: boolean;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per task
const DEFAULT_MAX_LINES = 10_000;          // hard upper bound on chunk count
const MAX_SINGLE_CHUNK_BYTES = 10 * 1024;  // truncate any single chunk this long
const GLOBAL_MAX_BYTES = 100 * 1024 * 1024; // 100 MB across ALL tasks
const EXITED_TTL_MS = 10 * 60 * 1000;       // free an exited task's buffer ~10 min after exit

/**
 * Main-side authoritative ring buffer for each task's log stream.
 *
 * - Bounded per-task by both bytes and chunk count.
 * - Bounded GLOBALLY by a total byte budget with LRU eviction of EXITED-task buffers first,
 *   so a long session that ran dozens of tasks can't pin hundreds of MB in main forever
 *   (IMPROVEMENT-PLAN 9.4). An exited task's buffer is also freed ~10 min after exit.
 * - Single chunks larger than `MAX_SINGLE_CHUNK_BYTES` are truncated with a marker.
 * - Survives task exits (the renderer can still scroll back) until evicted/timed-out.
 * - Cleared explicitly via `clear()` or when the app is removed.
 * - Bounds live-updatable via `setLimits()` so Settings changes take effect immediately.
 */
export class LogBuffer {
  private readonly buffers = new Map<TaskId, Buffer>();
  private readonly expiry = new Map<TaskId, NodeJS.Timeout>();
  private totalBytes = 0;
  private maxBytes: number;
  private maxLines: number;

  constructor(maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }

  /** Update the per-task caps. Existing buffers are trimmed down on next append. */
  setLimits(args: { maxLines?: number; maxBytes?: number }): void {
    if (args.maxBytes != null) this.maxBytes = Math.max(1024, args.maxBytes);
    if (args.maxLines != null) this.maxLines = Math.max(10, args.maxLines);
  }

  append(taskId: TaskId, rawChunk: string): void {
    // Truncate any single chunk that's improbably large to keep one runaway producer
    // (a base64-encoded asset accidentally logged, say) from blowing the ring.
    const chunk =
      rawChunk.length > MAX_SINGLE_CHUNK_BYTES
        ? rawChunk.slice(0, MAX_SINGLE_CHUNK_BYTES) + ` …[line truncated, ${rawChunk.length - MAX_SINGLE_CHUNK_BYTES}B]\n`
        : rawChunk;

    let buf = this.buffers.get(taskId);
    if (!buf) {
      buf = { chunks: [], bytes: 0, lastTouch: Date.now(), exited: false };
      this.buffers.set(taskId, buf);
    }
    // Fresh output means the task is alive again (e.g. a restart) - un-mark it as exited.
    if (buf.exited) {
      buf.exited = false;
      const t = this.expiry.get(taskId);
      if (t) {
        clearTimeout(t);
        this.expiry.delete(taskId);
      }
    }
    buf.chunks.push(chunk);
    buf.bytes += chunk.length;
    this.totalBytes += chunk.length;
    buf.lastTouch = Date.now();

    while (buf.chunks.length > this.maxLines || buf.bytes > this.maxBytes) {
      const dropped = buf.chunks.shift();
      if (!dropped) break;
      buf.bytes -= dropped.length;
      this.totalBytes -= dropped.length;
    }

    if (this.totalBytes > GLOBAL_MAX_BYTES) this.enforceGlobalCap(taskId);
  }

  read(taskId: TaskId): string {
    const buf = this.buffers.get(taskId);
    if (!buf) return '';
    buf.lastTouch = Date.now();
    return buf.chunks.join('');
  }

  tail(taskId: TaskId, maxLines = 200): string {
    const buf = this.buffers.get(taskId);
    if (!buf) return '';
    buf.lastTouch = Date.now();
    const joined = buf.chunks.join('');
    const lines = joined.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  }

  /** Mark a task as exited: its buffer becomes preferentially evictable and self-frees later. */
  markExited(taskId: TaskId): void {
    const buf = this.buffers.get(taskId);
    if (!buf) return;
    buf.exited = true;
    const existing = this.expiry.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.clear(taskId), EXITED_TTL_MS);
    // Don't keep the process alive just to expire a log buffer.
    timer.unref?.();
    this.expiry.set(taskId, timer);
  }

  clear(taskId: TaskId): void {
    const buf = this.buffers.get(taskId);
    if (buf) this.totalBytes -= buf.bytes;
    this.buffers.delete(taskId);
    const t = this.expiry.get(taskId);
    if (t) {
      clearTimeout(t);
      this.expiry.delete(taskId);
    }
  }

  /** Evict whole buffers until under the global budget - exited tasks first, then LRU. */
  private enforceGlobalCap(protectedId: TaskId): void {
    while (this.totalBytes > GLOBAL_MAX_BYTES) {
      let victim: TaskId | null = null;
      let victimTouch = Infinity;
      let victimExited = false;
      for (const [id, buf] of this.buffers) {
        if (id === protectedId) continue; // never evict the task we're actively writing
        // Prefer exited buffers; among same exited-ness, evict the least recently touched.
        const better =
          victim === null ||
          (buf.exited && !victimExited) ||
          (buf.exited === victimExited && buf.lastTouch < victimTouch);
        if (better) {
          victim = id;
          victimExited = buf.exited;
          victimTouch = buf.lastTouch;
        }
      }
      if (victim === null) break; // only the protected buffer remains
      this.clear(victim);
    }
  }
}
