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
