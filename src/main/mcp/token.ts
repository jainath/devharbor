import { randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';
import { db } from '../db/index.js';

/**
 * Persistence for the MCP bearer token (see specs/07-mcp-server.md).
 *
 * The token is a control-plane credential: holding it lets a client register a path and run
 * its scripts, i.e. run commands as the user. So unlike EnvStore's silent plaintext fallback
 * for env secrets, when the OS keychain is unavailable we still persist (clients must survive
 * restarts) but flag `storedPlaintext` so Settings can warn.
 *
 * Comparison logic deliberately lives in gate.ts (pure, unit-testable). This module only
 * creates/loads/rotates and returns the plaintext.
 */

const ENC_PREFIX = 'enc1:';
const SETTINGS_KEY = 'mcp_token';

export class TokenStore {
  /** True when the last load/generate had to store the token unencrypted. */
  storedPlaintext = false;

  /** Generate + persist a fresh 32-byte hex token, replacing any existing one. */
  regenerate(): string {
    const token = randomBytes(32).toString('hex');
    this.persist(token);
    return token;
  }

  /**
   * Current plaintext token, generating and persisting one on first use. Returns null only
   * if generation itself fails (should not happen - randomBytes + a DB write).
   */
  getOrCreate(): string {
    const existing = this.load();
    if (existing != null) return existing;
    return this.regenerate();
  }

  /** Current plaintext token if one exists, else null. Does NOT create one. */
  load(): string | null {
    const row = db()
      .prepare<unknown[], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
      .get(SETTINGS_KEY);
    if (!row) return null;
    const raw = row.value;
    if (raw.startsWith(ENC_PREFIX)) {
      if (!safeStorage.isEncryptionAvailable()) {
        // Stored encrypted, but the keychain is now unavailable - we cannot recover it.
        return null;
      }
      try {
        return safeStorage.decryptString(Buffer.from(raw.slice(ENC_PREFIX.length), 'base64'));
      } catch {
        return null;
      }
    }
    // Stored as plaintext (keychain was unavailable when written).
    this.storedPlaintext = true;
    return raw;
  }

  private persist(token: string): void {
    let stored: string;
    if (safeStorage.isEncryptionAvailable()) {
      stored = ENC_PREFIX + safeStorage.encryptString(token).toString('base64');
      this.storedPlaintext = false;
    } else {
      stored = token;
      this.storedPlaintext = true;
    }
    db()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(SETTINGS_KEY, stored);
  }
}
