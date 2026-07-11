import { describe, expect, it } from 'vitest';
import { cleanLogText, redactSecrets, stripAnsi, tailLines } from '../hygiene';

describe('stripAnsi', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsi('\x1b[32mready\x1b[0m')).toBe('ready');
    expect(stripAnsi('a\x1b[2Kb')).toBe('ab');
  });

  it('removes OSC sequences (terminal hyperlinks/titles), BEL- or ST-terminated', () => {
    expect(stripAnsi('\x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('link');
    expect(stripAnsi('\x1b]0;title\x1b\\text')).toBe('text');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of a known secret value', () => {
    const out = redactSecrets('url=postgres://u:sup3rsecret@h/db sup3rsecret', ['sup3rsecret']);
    expect(out).toBe('url=postgres://u:[redacted]@h/db [redacted]');
  });

  it('skips values shorter than 4 chars to avoid shredding output', () => {
    expect(redactSecrets('a=1 b=1 c=1', ['1'])).toBe('a=1 b=1 c=1');
  });

  it('treats secret values literally, not as regex', () => {
    // As a regex, "a.bc" would also match "axbc" (dot = any char); literally it must not.
    expect(redactSecrets('a.bc.d and axbc', ['a.bc'])).toBe('[redacted].d and axbc');
  });

  it('no-ops when the secret does not appear', () => {
    expect(redactSecrets('nothing here', ['absent-value'])).toBe('nothing here');
  });
});

describe('cleanLogText', () => {
  it('strips ANSI then redacts (order matters for split secrets)', () => {
    const out = cleanLogText('\x1b[32mtoken=abcd1234\x1b[0m', ['abcd1234']);
    expect(out).toBe('token=[redacted]');
  });
});

describe('tailLines', () => {
  it('returns the last N newline-delimited lines', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
    expect(tailLines('only', 5)).toBe('only');
  });
});
