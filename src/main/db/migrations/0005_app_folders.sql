-- Phase 8 (F21): folders in the sidebar.
--
-- One-level visual grouping. NULL means "(Ungrouped)". Tags remain orthogonal —
-- folder = hierarchy, tags = facets. See specs/03-features.md F21.

ALTER TABLE apps ADD COLUMN folder TEXT;

CREATE INDEX IF NOT EXISTS idx_apps_folder ON apps(folder) WHERE folder IS NOT NULL;
