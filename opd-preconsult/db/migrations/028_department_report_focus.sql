-- 028: Per-department "report focus" — admin-editable, specialty-specific emphasis
-- appended to the report LLM prompt at generation time. Structure (the four section
-- headings + the verbatim Python-rendered sections) stays fixed; this only steers
-- prioritisation and wording within the interpretive sections. NULL/blank = use the
-- base prompt unchanged.

DO $$ BEGIN
  ALTER TABLE departments ADD COLUMN report_focus TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Seed sensible defaults for the demo departments, but ONLY where an admin has not
-- already set one (idempotent, never clobbers an edit on re-run).
UPDATE departments
   SET report_focus = 'Emphasise cardiovascular assessment. Characterise any chest pain (exertional vs at rest, radiation, associated dyspnea, diaphoresis, palpitations), note exertional tolerance, and highlight cardiac risk factors (hypertension, diabetes, smoking, dyslipidaemia, family history). When prior documents contain cardiac diagnoses, ECG/echo findings, or lipid/glucose investigations, surface them prominently in Past Medical History.'
 WHERE code = 'CARD' AND (report_focus IS NULL OR btrim(report_focus) = '');

UPDATE departments
   SET report_focus = 'Provide a broad general-medicine summary. Lead with the primary presenting complaint and its timeline, note systemic/constitutional symptoms (fever, weight change, fatigue, appetite), and give chronic-disease context. When prior documents include diagnoses or investigations, incorporate the clinically relevant ones into Past Medical History.'
 WHERE code = 'GEN' AND (report_focus IS NULL OR btrim(report_focus) = '');
