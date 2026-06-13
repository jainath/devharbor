-- Per-app auto-start (IMPROVEMENT-PLAN 14.6). When set, the orchestrator starts the app on
-- DevHarbor launch - pairs with the "Launch DevHarbor at login" setting so a dev's stack is
-- already up when they sit down.
ALTER TABLE apps ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0;
