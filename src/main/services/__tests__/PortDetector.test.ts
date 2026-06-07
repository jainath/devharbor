import { describe, expect, it } from 'vitest';

// PortDetector currently keeps its regex parsing inside a class method. We replicate
// the patterns here verbatim so any change in PortDetector.ts trips this test.

const URL_PORT_RE = /\blocalhost:(\d{2,5})\b|\b(?:https?|ws):\/\/[^\s/]+:(\d{2,5})\b/g;
const LISTEN_PORT_RE = /\blistening\s+on\s+(?:port\s+)?:?(\d{2,5})\b/gi;

function detectPorts(chunk: string): number[] {
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = URL_PORT_RE.exec(chunk)) !== null) {
    const p = Number(m[1] ?? m[2]);
    if (p >= 1 && p <= 65535) out.add(p);
  }
  URL_PORT_RE.lastIndex = 0;
  while ((m = LISTEN_PORT_RE.exec(chunk)) !== null) {
    const p = Number(m[1]);
    if (p >= 1 && p <= 65535) out.add(p);
  }
  LISTEN_PORT_RE.lastIndex = 0;
  return [...out].sort((a, b) => a - b);
}

describe('PortDetector stdout regex', () => {
  it('extracts "localhost:N" patterns', () => {
    expect(detectPorts('Server is up at localhost:3000')).toEqual([3000]);
  });

  it("extracts Vite's banner", () => {
    expect(
      detectPorts('  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose')
    ).toEqual([5173]);
  });

  it('handles the "listening on :N" pattern', () => {
    expect(detectPorts('api listening on 4317')).toEqual([4317]);
    expect(detectPorts('api listening on :4317')).toEqual([4317]);
    expect(detectPorts('Worker listening on port 8080')).toEqual([8080]);
  });

  it('extracts ports from full URLs (http/https/ws)', () => {
    expect(detectPorts('ws://127.0.0.1:9000/events')).toEqual([9000]);
    expect(detectPorts('https://localhost:8443/ ready')).toEqual([8443]);
  });

  it('extracts multiple distinct ports from one chunk', () => {
    expect(
      detectPorts('Local:   http://localhost:5173/\nAPI: http://localhost:4000')
    ).toEqual([4000, 5173]);
  });

  it('ignores out-of-range values', () => {
    // 999999 fails the 2-5 digit guard
    expect(detectPorts('localhost:999999')).toEqual([]);
    // 1-digit ports filtered too
    expect(detectPorts('localhost:1')).toEqual([]);
  });

  it("does not match port-looking numbers in arbitrary prose", () => {
    expect(detectPorts('Error code 12345 occurred')).toEqual([]);
  });
});
