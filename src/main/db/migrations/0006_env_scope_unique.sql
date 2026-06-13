-- Fix layered env saves (IMPROVEMENT-PLAN 5.6).
--
-- 0001 created env_vars with a table-level UNIQUE(app_id, key). 0004 added task_id for
-- three-scope layering (global / app / task), but the old constraint:
--   * makes a TASK-scoped override of an app-scoped key impossible to save - the whole
--     point of layering - rolling back the entire save transaction; and
--   * is INERT for global scope (app_id IS NULL bypasses UNIQUE), so it constrains exactly
--     where it shouldn't and not where it should.
--
-- SQLite can't drop a table-level constraint, so rebuild the table without it and replace
-- it with three PARTIAL unique indexes - correct per-scope uniqueness. Nothing references
-- env_vars, so the drop/rename is safe inside the migration transaction.

CREATE TABLE env_vars_new (
  id          TEXT PRIMARY KEY,
  app_id      TEXT REFERENCES apps(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT INTO env_vars_new (id, app_id, task_id, key, value, enabled, is_secret, note, created_at, updated_at)
  SELECT id, app_id, task_id, key, value, enabled, is_secret, note, created_at, updated_at FROM env_vars;

DROP TABLE env_vars;
ALTER TABLE env_vars_new RENAME TO env_vars;

CREATE INDEX IF NOT EXISTS idx_env_vars_app ON env_vars(app_id);
CREATE INDEX IF NOT EXISTS idx_env_vars_task ON env_vars(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_env_vars_app_scope ON env_vars(app_id, task_id);

-- De-dupe any rows that would violate the new unique indexes (keep the most recently
-- updated per scope+key), since the old schema permitted duplicate global keys.
DELETE FROM env_vars WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY IFNULL(app_id, '∅'), IFNULL(task_id, '∅'), key
      ORDER BY updated_at DESC, id DESC
    ) AS rn FROM env_vars
  ) WHERE rn = 1
);

CREATE UNIQUE INDEX uq_env_global ON env_vars(key)          WHERE app_id IS NULL AND task_id IS NULL;
CREATE UNIQUE INDEX uq_env_app    ON env_vars(app_id, key)  WHERE app_id IS NOT NULL AND task_id IS NULL;
CREATE UNIQUE INDEX uq_env_task   ON env_vars(task_id, key) WHERE task_id IS NOT NULL;
