-- Phase 2: run_history rows are written per-task (one run = one row per task that started).
-- task_id is nullable so legacy rows (none currently, but future-proof) stay valid.

ALTER TABLE run_history ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE run_history ADD COLUMN task_name TEXT;

CREATE INDEX IF NOT EXISTS idx_run_history_task ON run_history(task_id, started_at DESC);
