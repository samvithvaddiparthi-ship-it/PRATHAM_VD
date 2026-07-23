-- 033 — Free-form node positions for the visual questionnaire flow editor.
--
-- The HIS "Map" tab becomes an interactive canvas: an administrator drags each
-- question where they want it and draws the branch arrows directly. Those x/y
-- coordinates live here. They are purely editorial — the patient intake engine
-- (routes/questionnaire.js) still walks next_default / next_rules and never reads
-- position — so a null position just means "not placed yet" and the canvas
-- auto-lays it out until the admin moves it.
--
-- ⚠️ questionnaire_nodes_draft was created with (LIKE questionnaire_nodes
-- INCLUDING ALL) in migration 031, which is a one-time copy. New columns on the
-- live table do NOT propagate to the draft, so both are altered explicitly here
-- and MUST stay column-for-column identical (a Publish copies row-for-row).

DO $$ BEGIN
  ALTER TABLE questionnaire_nodes ADD COLUMN pos_x INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE questionnaire_nodes ADD COLUMN pos_y INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE questionnaire_nodes_draft ADD COLUMN pos_x INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE questionnaire_nodes_draft ADD COLUMN pos_y INTEGER;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
