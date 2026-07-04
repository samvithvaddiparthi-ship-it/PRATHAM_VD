-- Optional preferred doctor, chosen by the patient at registration (typically a
-- doctor they've seen before). Honored MANUALLY first: surfaced as a badge on the
-- doctor queue, NOT auto-routing — call order stays the open FCFS-vs-triage
-- decision, and auto-routing would collide with it.
--
-- preferred_doctor_id references the doctor; ON DELETE SET NULL so removing a
-- doctor never blocks or corrupts old sessions. preferred_doctor_name is a
-- denormalized snapshot so the badge still reads sensibly even if the doctor row
-- later changes. Both optional (NULL = no preference / first available).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS preferred_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS preferred_doctor_name VARCHAR(256);
