-- Global application settings (key/value). Hospital-wide feature flags and config
-- that admins toggle from the HIS dashboard, not per-department. Currently holds
-- `ocr_enabled` — whether patient-uploaded documents are run through the paid
-- AI/OCR extraction. Turning it OFF lets a hospital avoid vision-LLM API costs.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

-- Seed the OCR flag as ON (current behaviour) if it isn't already present.
INSERT INTO app_settings (key, value)
VALUES ('ocr_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
