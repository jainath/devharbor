import { db } from '../db/index.js';

export type SettingsMap = {
  log_ring_size: number;
  kill_grace_ms: number;
  auto_update: boolean;
  theme: 'light' | 'dark' | 'system';
  dashboard_refresh_ms: number;
};

const DEFAULTS: SettingsMap = {
  log_ring_size: 10_000,
  kill_grace_ms: 5000,
  auto_update: true,
  theme: 'system',
  dashboard_refresh_ms: 1000
};

export class Settings {
  getAll(): SettingsMap {
    const rows = db()
      .prepare<unknown[], { key: string; value: string }>(`SELECT key, value FROM settings`)
      .all();
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      log_ring_size: parseNumber(map.get('log_ring_size'), DEFAULTS.log_ring_size),
      kill_grace_ms: parseNumber(map.get('kill_grace_ms'), DEFAULTS.kill_grace_ms),
      auto_update: parseBool(map.get('auto_update'), DEFAULTS.auto_update),
      theme: parseTheme(map.get('theme')),
      dashboard_refresh_ms: parseNumber(map.get('dashboard_refresh_ms'), DEFAULTS.dashboard_refresh_ms)
    };
  }

  get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
    return this.getAll()[key];
  }

  set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
    const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    db()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, raw);
  }

  setMany(patch: Partial<SettingsMap>): SettingsMap {
    const allowed = new Set<keyof SettingsMap>([
      'log_ring_size',
      'kill_grace_ms',
      'auto_update',
      'theme',
      'dashboard_refresh_ms'
    ]);
    const tx = db().transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.has(k as keyof SettingsMap)) {
          throw new Error(`Unknown setting key: ${k}`);
        }
        this.set(k as keyof SettingsMap, v as never);
      }
    });
    tx();
    return this.getAll();
  }
}

function parseNumber(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  return v === '1' || v === 'true';
}

function parseTheme(v: string | undefined): SettingsMap['theme'] {
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}
