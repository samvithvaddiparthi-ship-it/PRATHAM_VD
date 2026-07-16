-- Remove the starter 'OPD' department (and its seeded questions) that
-- 006_departments.sql inserts so the app "runs out of the box".
--
-- A hospital should start with an empty Departments list and add its own in
-- HIS → Departments; creating one there seeds that department's base intake
-- questions automatically (routes/admin.js -> baseNodesForDept). A placeholder
-- department is worse than none: it shows up in the patient-facing department
-- picker and issues real queue tokens.
--
-- 006 is NOT edited — a database that already ran it keeps the row, so the
-- removal has to happen here. On a fresh install 006 inserts and this migration
-- immediately deletes; net effect, no departments. Migrations run before
-- seedQuestionnaires() (index.js), so nothing is re-seeded afterwards.
--
-- Guarded: if any patient session already chose OPD, keep everything. Deleting a
-- department whose questionnaire nodes an in-progress interview is walking would
-- strand that patient, and the queue board would lose its heading. In that case
-- deactivate it in HIS instead.
DO $$
DECLARE
  used INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM departments WHERE code = 'OPD') THEN
    RETURN;   -- already gone; migration is idempotent
  END IF;

  SELECT COUNT(*) INTO used FROM sessions WHERE department = 'OPD';

  IF used > 0 THEN
    RAISE NOTICE 'Keeping starter OPD department: % session(s) reference it. Deactivate it in HIS instead.', used;
  ELSE
    DELETE FROM questionnaire_nodes WHERE department = 'OPD';
    DELETE FROM departments WHERE code = 'OPD';
    RAISE NOTICE 'Removed starter OPD department and its seeded questions.';
  END IF;
END $$;
