-- Soft-delete marker for sessions.
--
-- "Delete patient entry" in the doctor dashboard now does a SOFT remove instead
-- of a hard delete: the session is stamped with removed_at and disappears from
-- the active Queue and from the patient's previous-logins, but is NOT erased.
-- This keeps a complete, permanent history of consulted patients in the
-- Consulted tab even after they've been removed from the active dashboard.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
