import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureTlsMaterial } from '../tls';

describe('ensureTlsMaterial (uses the system openssl)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devharbor-tls-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a key + self-signed cert on first use', () => {
    const m = ensureTlsMaterial(dir);
    expect(m.key).toContain('PRIVATE KEY');
    expect(m.cert).toContain('BEGIN CERTIFICATE');
    expect(m.certPath).toBe(join(dir, 'mcp-cert.pem'));
    // Key is user-only (0600) - same posture as an ssh key.
    const mode = statSync(join(dir, 'mcp-key.pem')).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  it('the certificate carries loopback SANs', () => {
    ensureTlsMaterial(dir);
    const text = execFileSync('openssl', ['x509', '-in', join(dir, 'mcp-cert.pem'), '-noout', '-text']).toString();
    expect(text).toContain('DNS:localhost');
    expect(text).toContain('127.0.0.1');
  }, 30_000);

  it('reuses existing material instead of regenerating', () => {
    const first = ensureTlsMaterial(dir);
    const second = ensureTlsMaterial(dir);
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });
});
