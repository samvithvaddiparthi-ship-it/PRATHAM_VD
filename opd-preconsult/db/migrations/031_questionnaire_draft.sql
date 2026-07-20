-- Draft → Publish for questionnaire authoring (HIS Questionnaires tab).
--
-- Problem: today every edit in the HIS editor writes straight to
-- questionnaire_nodes, which the patient intake engine reads live — so a
-- half-finished edit is seen by the next real patient. This adds a staging copy
-- the clinician edits freely and then PUBLISHES in one step.
--
-- Model (product decision 2026-07-20 — no versioning/rollback, whole-department
-- publish, anyone who can edit can publish):
--   * questionnaire_nodes        = the PUBLISHED questionnaire. The patient engine
--                                  (questionnaire.js / whatsapp.js) keeps reading
--                                  ONLY this table — untouched, zero patient risk.
--   * questionnaire_nodes_draft  = the working copy. The HIS editor reads/writes
--                                  here for any department with an open draft.
--   * questionnaire_drafts       = one row per department that has unpublished
--                                  edits. Its presence is the "dirty" signal and
--                                  drives the "unpublished changes" badge.
--
-- Flow: first edit of a department copies its published rows into the draft table
-- and inserts a marker (copy-on-write). Publish replaces the department's rows in
-- questionnaire_nodes with the draft and clears the draft + marker. Discard just
-- clears the draft + marker.
--
-- ⚠️ questionnaire_nodes_draft MUST stay column-for-column identical to
-- questionnaire_nodes. Any future migration that alters questionnaire_nodes must
-- alter this table identically — Publish/materialize use `INSERT ... SELECT *`,
-- which fails loudly (not silently) on a column mismatch. Created here with LIKE so
-- it inherits the current shape (columns, defaults, PK, indexes).
CREATE TABLE IF NOT EXISTS questionnaire_nodes_draft (LIKE questionnaire_nodes INCLUDING ALL);

-- One row per department with an open (unpublished) draft. Presence = dirty.
CREATE TABLE IF NOT EXISTS questionnaire_drafts (
  department  VARCHAR(32) PRIMARY KEY,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
