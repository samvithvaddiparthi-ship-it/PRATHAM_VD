-- Stable "first consulted" timestamp.
--
-- The doctor's "Consulted" list previously ordered by updated_at, which is
-- bumped every time a doctor re-opens a patient — so the list reshuffled on
-- every view. consulted_at is set ONCE, the first time a doctor opens/assigns a
-- patient, and never changes afterwards, giving the Consulted list a fixed order.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consulted_at TIMESTAMPTZ;

-- Backfill: give already-consulted (assigned) sessions a stable timestamp so
-- their order is locked in from now on.
UPDATE sessions
   SET consulted_at = updated_at
 WHERE assigned_doctor_id IS NOT NULL
   AND consulted_at IS NULL;
