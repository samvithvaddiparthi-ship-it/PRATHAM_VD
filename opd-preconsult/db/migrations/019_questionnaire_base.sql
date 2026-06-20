-- Base/common questions vs department-specific DAG questions.
-- is_base = TRUE marks the fixed intake questions (visit type, progress, chief
-- complaint, current medicines, drug allergies) that every department shares.
-- These run first as a simple linear sequence (their own go-back logic); the
-- department's DAG questions follow. Editable per department but seeded from one
-- common template so they stay consistent.
ALTER TABLE questionnaire_nodes ADD COLUMN IF NOT EXISTS is_base BOOLEAN DEFAULT FALSE;
