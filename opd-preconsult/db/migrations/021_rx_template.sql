-- Hospital-configurable prescription template + doctor registration number.

-- Optional prescriber registration/license number, shown on the prescription
-- when the template's "doctor registration" toggle is on. Pulled LIVE from the
-- doctor record at prescription time, so edits flow through to new prescriptions.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS registration_no VARCHAR(64);

-- Single hospital-wide prescription template. Keyed by hospital_id (default
-- 'default') so it can be extended to multi-hospital later without a reshape.
-- `config` holds the branding, theme, and show/hide toggles as JSON.
CREATE TABLE IF NOT EXISTS rx_template (
  hospital_id  VARCHAR(64) PRIMARY KEY DEFAULT 'default',
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO rx_template (hospital_id, config)
VALUES ('default', '{}'::jsonb)
ON CONFLICT (hospital_id) DO NOTHING;
