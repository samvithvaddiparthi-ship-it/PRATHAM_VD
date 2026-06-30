-- Daily, per-department patient token numbers (e.g. CARD-007), assigned
-- server-side at REGISTRATION. The kiosk QR no longer carries a (random) queue
-- position — each department poster is a static identifier, and the real token
-- is issued here, the way a government OPD hands out a token at the counter.
--
-- queue_counters gives an atomic, race-safe sequence per (hospital, department,
-- day). It resets automatically every day because the row is keyed by
-- service_date, so numbering starts again at 1 each morning.

CREATE TABLE IF NOT EXISTS queue_counters (
  hospital_id  VARCHAR(64) NOT NULL,
  department   VARCHAR(32) NOT NULL,
  service_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  last_token   INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (hospital_id, department, service_date)
);

-- token_number = the raw daily counter; token_label = the human-facing "DEPT-NNN"
-- shown to the patient on the Done page and on the waiting-room board.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_number INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_label  VARCHAR(32);
