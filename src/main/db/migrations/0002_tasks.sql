-- Phase 1.5: multi-task model.
-- See specs/02-data-model.md (tasks section) for the canonical reference.

CREATE TABLE IF NOT EXISTS tasks (
  id                            TEXT PRIMARY KEY,
  app_id                        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name                          TEXT NOT NULL,
  position                      INTEGER NOT NULL,
  command_kind                  TEXT NOT NULL CHECK (command_kind IN ('script','custom')),
  script                        TEXT,
  custom_command                TEXT,
  working_dir_override          TEXT,
  package_manager_override      TEXT,
  node_version_pref_override    TEXT,
  depends_on                    TEXT NOT NULL DEFAULT '[]',
  readiness                     TEXT NOT NULL DEFAULT '{"kind":"none"}',
  one_shot                      INTEGER NOT NULL DEFAULT 0,
  enabled                       INTEGER NOT NULL DEFAULT 1,
  env_overrides                 TEXT NOT NULL DEFAULT '{}',
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_app ON tasks(app_id, position);
