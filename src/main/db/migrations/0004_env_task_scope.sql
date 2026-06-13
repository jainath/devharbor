-- Phase 7: task-scoped env vars.
--
-- Add `task_id` to env_vars so the three-scope layering (global / app / task)
-- can be done with one table and one query per scope. NULL means "not scoped
-- to a specific task" - combined with `app_id` it gives:
--    app_id IS NULL AND task_id IS NULL  → global
--    app_id = ?      AND task_id IS NULL  → app
--    task_id = ?                          → task  (app_id denormalised for cascade)
--
-- Backfill from tasks.env_overrides JSON happens in EnvStore at first read of
-- a task's env (lazy, idempotent: marker stored in app-level setting once done).

ALTER TABLE env_vars ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_env_vars_task ON env_vars(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_env_vars_app_scope ON env_vars(app_id, task_id);
