import { describe, expect, it } from 'vitest';
import { parseDotEnv, isSecretKey } from '../dotenv';

describe('parseDotEnv', () => {
  it('parses simple key=value pairs', () => {
    expect(parseDotEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseDotEnv('# c\n\nA=1\n   \nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('strips matching quotes', () => {
    expect(parseDotEnv(`A="x"\nB='y'`)).toEqual({ A: 'x', B: 'y' });
  });

  it('expands escapes in double-quoted values but NOT single-quoted (the divergence the shared util fixes)', () => {
    expect(parseDotEnv('A="a\\nb"')).toEqual({ A: 'a\nb' });
    expect(parseDotEnv("A='a\\nb'")).toEqual({ A: 'a\\nb' });
  });

  it('drops trailing " #" comments on unquoted values', () => {
    expect(parseDotEnv('A=val # note')).toEqual({ A: 'val' });
  });

  it('skips invalid keys', () => {
    expect(parseDotEnv('1BAD=x\nGOOD=y\nNO_EQUALS')).toEqual({ GOOD: 'y' });
  });

  it('strips a leading "export " prefix before key validation', () => {
    expect(parseDotEnv('export A=1\nexport B="two"')).toEqual({ A: '1', B: 'two' });
  });

  it('consumes subsequent lines for a multiline double-quoted value (PEM block)', () => {
    const pem = [
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'MIIBVAIBADANBgkqhkiG9w0BAQEF',
      'AASCAT4wggE6AgEAAkEA-----END PRIVATE KEY-----"',
      'NEXT=ok',
    ].join('\n');
    expect(parseDotEnv(pem)).toEqual({
      PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEF\nAASCAT4wggE6AgEAAkEA-----END PRIVATE KEY-----',
      NEXT: 'ok',
    });
  });

  it('strips a trailing comment after a closed double-quoted value', () => {
    expect(parseDotEnv('A="x" # comment')).toEqual({ A: 'x' });
  });

  it('an unterminated double quote degrades to a single-line value - later vars survive', () => {
    // Without the EOF fallback, E=" would swallow X and Y into E's "multiline value".
    expect(parseDotEnv('E="oops\nX=1\nY=2')).toEqual({ E: 'oops', X: '1', Y: '2' });
  });

  it('unterminated quote at EOF yields the line remainder, not the rest of the file', () => {
    expect(parseDotEnv('A="never closed')).toEqual({ A: 'never closed' });
  });
});

describe('isSecretKey', () => {
  it('flags secret-ish keys case-insensitively', () => {
    for (const k of ['API_SECRET', 'auth_token', 'DB_PASSWORD', 'PRIVATE_KEY', 'apiKey']) {
      expect(isSecretKey(k)).toBe(true);
    }
  });
  it('does not flag plain keys', () => {
    for (const k of ['NODE_ENV', 'PORT', 'DATABASE_URL']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});
