-- "Save & Generate QR" dispatch marker — the true end-point of a consultation.
--
-- Multiple doctors share a department queue. A doctor OPENS (locks) a patient by
-- getting assigned_doctor_id; the patient only leaves the queue and enters the
-- Consulted list when the doctor clicks "Save & Generate QR", which stamps
-- dispatched_at. So:
--   * queue   = recent, not-yet-dispatched visits (locked ones show in-progress)
--   * consulted = assigned-to-me AND dispatched_at IS NOT NULL
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- Backfill: existing already-consulted (assigned) visits predate this flow, so
-- treat them as dispatched — keeps the current Consulted history intact instead
-- of making it vanish the moment the new "dispatched" rule goes live.
UPDATE sessions
   SET dispatched_at = COALESCE(consulted_at, updated_at)
 WHERE assigned_doctor_id IS NOT NULL
   AND dispatched_at IS NULL;
