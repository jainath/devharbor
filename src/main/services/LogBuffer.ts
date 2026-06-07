import type { TaskId } from '@shared/types';

interface Buffer {
  chunks: string[];
  bytes: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per task
const DEFAULT_MAX_LINES = 10_000;          // hard upper bound on chunk count
const MAX_SINGLE_CHUNK_BYTES = 10 * 1024;  // truncate any single chunk this long

/**
 * Main-side authoritative ring buffer for each task's log stream.
 *
 * - Bounded by both bytes and chunk count.
 * - Single chunks larger than `MAX_SINGLE_CHUNK_BYTES` are truncated with a marker.
 * - Survives task exits (the renderer can still scroll back).
 * - Cleared explicitly via `clear()` or when the app is removed.
 * - Bounds live-updatable via `setLimits()` so Settings changes take effect immediately.
 */
export class LogBuffer {
  private readonly buffers = new Map<TaskId, Buffer>();
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
      buf = { chunks: [], bytes: 0 };
      this.buffers.set(taskId, buf);
    }
    buf.chunks.push(chunk);
    buf.bytes += chunk.length;

    while (buf.chunks.length > this.maxLines || buf.bytes > this.maxBytes) {
      const dropped = buf.chunks.shift();
      if (!dropped) break;
      buf.bytes -= dropped.length;
    }
  }

  read(taskId: TaskId): string {
    const buf = this.buffers.get(taskId);
    if (!buf) return '';
    return buf.chunks.join('');
  }

  tail(taskId: TaskId, maxLines = 200): string {
    const buf = this.buffers.get(taskId);
    if (!buf) return '';
    const joined = buf.chunks.join('');
    const lines = joined.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  }

  clear(taskId: TaskId): void {
    this.buffers.delete(taskId);
  }
}
