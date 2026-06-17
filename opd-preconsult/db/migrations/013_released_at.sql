-- "Release back to queue" marker.
--
-- A doctor can release a consulted visit back into the active queue (e.g. it was
-- opened by mistake, or needs to be seen again). released_at records WHEN that
-- happened. The queue treats a recently-released visit as "filled now" again —
-- so it re-surfaces at the top with a NEW badge, just like a fresh patient fill —
-- and the release also clears assigned_doctor_id + consulted_at so it leaves the
-- doctor's Consulted list and counts as "waiting" again.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
