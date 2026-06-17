-- Doctor's correction note on a report.
--
-- When a doctor marks a report "Incorrect History", they can append a short,
-- timestamped correction. The original AI report (report_md) is never altered —
-- the correction is stored alongside it for audit and shown beneath it.
ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS doctor_correction TEXT;
ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;
