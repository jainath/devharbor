import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { bearerMatches, hostHeaderAllowed, originAllowed } from '../gate';

describe('hostHeaderAllowed', () => {
  it('accepts exact loopback hosts with or without a port', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:6872', 'localhost', 'localhost:6872', '[::1]', '[::1]:6872']) {
      expect(hostHeaderAllowed(h)).toBe(true);
    }
  });

  it('rejects rebinding-style and remote hosts', () => {
    for (const h of ['localhost.evil.com', '127.0.0.1.evil.com', 'evil.com', 'example.com:6872', '10.0.0.5']) {
      expect(hostHeaderAllowed(h)).toBe(false);
    }
  });

  it('fails closed on a missing Host header', () => {
    expect(hostHeaderAllowed(undefined)).toBe(false);
  });
});

describe('originAllowed', () => {
  it('allows a missing Origin (non-browser client)', () => {
    expect(originAllowed(undefined)).toBe(true);
  });

  it('allows loopback origins', () => {
    expect(originAllowed('http://127.0.0.1:6274')).toBe(true);
    expect(originAllowed('http://localhost:3000')).toBe(true);
  });

  it('rejects remote origins and the literal "null"', () => {
    expect(originAllowed('https://evil.com')).toBe(false);
    expect(originAllowed('null')).toBe(false);
    expect(originAllowed('not a url')).toBe(false);
  });
});

describe('bearerMatches', () => {
  const token = randomBytes(32).toString('hex');

  it('matches the correct bearer token', () => {
    expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
    expect(bearerMatches(`bearer ${token}`, token)).toBe(true);
  });

  it('rejects a wrong token WITHOUT throwing on length mismatch', () => {
    expect(bearerMatches('Bearer short', token)).toBe(false);
    expect(bearerMatches(`Bearer ${randomBytes(32).toString('hex')}`, token)).toBe(false);
    expect(bearerMatches(`Bearer ${token}extra`, token)).toBe(false);
  });

  it('rejects malformed or missing headers', () => {
    expect(bearerMatches(undefined, token)).toBe(false);
    expect(bearerMatches('', token)).toBe(false);
    expect(bearerMatches(token, token)).toBe(false); // no "Bearer " prefix
    expect(bearerMatches('Basic abc', token)).toBe(false);
  });

  it('never matches against an empty expected token', () => {
    expect(bearerMatches('Bearer anything', '')).toBe(false);
  });
});
