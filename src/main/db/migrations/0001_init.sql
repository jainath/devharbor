-- Phase 0 initial schema for app-manager.
-- See specs/02-data-model.md for the canonical reference.

CREATE TABLE IF NOT EXISTS apps (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  path                    TEXT NOT NULL UNIQUE,
  color                   TEXT NOT NULL,
  icon                    TEXT,
  node_version_pref       TEXT NOT NULL DEFAULT '{"kind":"auto"}',
  package_manager         TEXT,
  default_script          TEXT,
  custom_command          TEXT,
  working_dir             TEXT NOT NULL,
  auto_restart_on_change  INTEGER NOT NULL DEFAULT 0,
  watch_globs             TEXT NOT NULL DEFAULT '[]',
  port_hint               INTEGER,
  tags                    TEXT NOT NULL DEFAULT '[]',
  last_started_at         INTEGER,
  last_exit_code          INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_updated_at ON apps(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_apps_path ON apps(path);

CREATE TABLE IF NOT EXISTS env_vars (
  id          TEXT PRIMARY KEY,
  app_id      TEXT REFERENCES apps(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_env_vars_app ON env_vars(app_id);

CREATE TABLE IF NOT EXISTS run_history (
  id                  TEXT PRIMARY KEY,
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  script              TEXT,
  custom_command      TEXT,
  node_version        TEXT,
  package_manager     TEXT,
  exit_code           INTEGER,
  exit_signal         TEXT,
  was_killed_by_user  INTEGER NOT NULL DEFAULT 0,
  log_file            TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_history_app ON run_history(app_id, started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('log_ring_size',           '10000'),
  ('kill_grace_ms',           '5000'),
  ('auto_update',             '1'),
  ('theme',                   'system'),
  ('dashboard_refresh_ms',    '1000');
