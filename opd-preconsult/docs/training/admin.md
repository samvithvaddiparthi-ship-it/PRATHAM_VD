# Admin / HIS Operator — Quick Guide (1 page)

**Your job:** keep the master data correct (departments, doctors) and watch the day run.
You handle **real patient data (PHI)** — treat every screen as confidential.

---

## Log in
Open the **HIS dashboard** → enter the **admin passcode** and **your name**
(your name is recorded against every change you make — this is on purpose).

## Tabs you use daily
- **Patients** — all sessions today: state (In Queue / Consulted), department, triage,
  assigned doctor. Search, and **reassign** a patient to another doctor/department.
- **Analytics** — live counts: patients today, per-department load, triage mix, wait times.
- **Departments** — add/edit departments, set the **icon** patients see, toggle whether a
  department **collects vitals**.
- **Doctors** — add real doctors, set/reset PINs, **deactivate** doctors who've left.
- **Questionnaires / Protocols / Drug Formulary** — the clinical content. **Change only
  with a doctor/clinical lead's sign-off.**

## Go-live setup checklist (one time)
1. Create the **real departments** with correct names + icons.
2. Add the **real doctors**; give each a **unique PIN** and tell them to change it.
3. **Deactivate the demo doctors** (Priya Sharma, Anil Reddy, Kavitha Menon) — they must
   not exist on a live system.
4. Confirm the **OPD poster QR** points at the live address and is placed where patients see it.
5. Do a **test patient run** end-to-end before opening to the public.

## Daily rhythm
- **Morning:** check all services show **healthy**; confirm yesterday's **backup ran**.
- **During OPD:** watch Analytics for a department piling up; reassign to balance load.
- **Any RED patient stuck in queue:** flag the department's staff.
- **Evening:** quick look at doctor **Accurate/Inaccurate** ratings; note recurring problems.

## Privacy & security (non-negotiable)
✅ Log in with **your own name**; log out on shared machines.
✅ Only give system access to staff who need it for care.
✅ Report a suspected data leak or lost device to the shift lead **immediately**.
❌ Never export, photograph, screenshot, or message patient details outside the system.
❌ Never share the admin passcode or a doctor's PIN.
❌ Never edit clinical content (questions/protocols/formulary) without clinical sign-off.

## If something breaks
- A **service is unhealthy / dashboard won't load** → tell IT/support, switch the floor to
  the **paper fallback** (downtime SOP), keep the queue moving on paper.
- **Don't** attempt database or server fixes yourself — call the support contact.

---
*Support contact + escalation numbers are on the operations runbook (deploy/OPERATIONS.md).*
