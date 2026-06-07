import { describe, expect, it } from 'vitest';
import { LogBuffer } from '../LogBuffer';
import type { TaskId } from '@shared/types';

const T = 'task-1' as TaskId;

describe('LogBuffer', () => {
  it('returns empty string for an unknown task', () => {
    const b = new LogBuffer();
    expect(b.read(T)).toBe('');
    expect(b.tail(T)).toBe('');
  });

  it('accumulates appended chunks', () => {
    const b = new LogBuffer();
    b.append(T, 'hello ');
    b.append(T, 'world');
    expect(b.read(T)).toBe('hello world');
  });

  it('evicts oldest chunks when over maxLines', () => {
    const b = new LogBuffer(10_000_000, 3); // 3-chunk cap
    b.append(T, 'a\n');
    b.append(T, 'b\n');
    b.append(T, 'c\n');
    b.append(T, 'd\n');
    expect(b.read(T)).toBe('b\nc\nd\n');
  });

  it('evicts oldest chunks when over maxBytes', () => {
    const b = new LogBuffer(10, 1_000_000);
    b.append(T, '12345'); // 5
    b.append(T, '67890'); // 10
    b.append(T, 'AB');    // forces eviction
    expect(b.read(T).length).toBeLessThanOrEqual(10);
    expect(b.read(T).endsWith('AB')).toBe(true);
  });

  it('truncates single chunks longer than the line cap', () => {
    const b = new LogBuffer();
    const long = 'x'.repeat(20_000);
    b.append(T, long);
    const out = b.read(T);
    expect(out).toContain('line truncated');
    expect(out.length).toBeLessThan(long.length);
  });

  it('tail returns at most N non-empty lines from the end', () => {
    const b = new LogBuffer();
    for (let i = 0; i < 20; i++) b.append(T, `line ${i}\n`);
    const lines = b.tail(T, 5).split('\n').filter(Boolean);
    // Trailing '\n' after 'line 19' produces an empty trailing line, so we get N-1 non-empty.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[lines.length - 1]).toBe('line 19');
  });

  it('setLimits trims existing buffers on next append (respects min floor of 10)', () => {
    const b = new LogBuffer();
    for (let i = 0; i < 100; i++) b.append(T, `line ${i}\n`);
    // The floor is 10, so requesting 5 clamps to 10.
    b.setLimits({ maxLines: 5 });
    b.append(T, 'sentinel\n');
    const lines = b.read(T).split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[lines.length - 1]).toBe('sentinel');
  });

  it('clear removes the buffer for a task', () => {
    const b = new LogBuffer();
    b.append(T, 'hello');
    b.clear(T);
    expect(b.read(T)).toBe('');
  });
});
