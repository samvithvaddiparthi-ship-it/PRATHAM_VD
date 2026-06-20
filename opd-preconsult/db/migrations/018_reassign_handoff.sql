-- Patient reassignment handoff metadata.
--
-- When a doctor reassigns a patient to a SPECIFIC doctor, we record who handed
-- them over and when, so the receiving doctor sees "Assigned to you by Dr. X"
-- (a card badge + toast + detail banner). Cleared on department-general moves
-- and unassign so a stale handoff notice never shows.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reassigned_by VARCHAR(256);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMPTZ;
