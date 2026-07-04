-- The patient now chooses their department AFTER OTP + entering details (not at
-- scan), so a session is created without a department and it's set at
-- registration. Relax the NOT NULL — the department is still set before a queue
-- token is issued (enforced in routes/session.js /register).
--
-- DROP NOT NULL is a no-op if the column is already nullable, so this is safe to
-- re-run.
ALTER TABLE sessions ALTER COLUMN department DROP NOT NULL;
