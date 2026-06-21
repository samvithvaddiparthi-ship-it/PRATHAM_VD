-- Per-department vitals collection toggle. When FALSE, the patient flow skips the
-- vitals step entirely and the "done" page hides the vitals entry tile. Default
-- TRUE preserves existing behaviour until an admin turns a department off.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS collect_vitals BOOLEAN NOT NULL DEFAULT TRUE;
