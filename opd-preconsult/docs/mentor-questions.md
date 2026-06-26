# Mentor Questions — OPD Pre-Consultation (Pratham)

Questions to settle with mentors before locking design decisions for a real
deployment (e.g. a government OPD in Hyderabad). Grouped by theme. Items we
already planned to ask are kept; a few related ones are added.

---

## 1. Scope & deployment
- **Multi-hospital?** Is this for a single hospital or should it be a reusable, multi-hospital template (per-hospital branding, departments, config)? *(affects the prescription template + tenancy design)*
- **Pilot site & departments:** Which hospital and which department(s) for the first pilot? We don't yet know which departments the OPD will have — does this vary per hospital?
- **Compute location:** Do they prefer **on-device** or **cloud** computing? If on-device, what hardware is available (CPU/GPU/RAM)? *(drives the on-shore OCR/LLM model choice)*

## 2. Patient intake & flow
- **OTP:** Do they want phone-number OTP verification? If yes, how should we implement it (which SMS gateway, who bears the cost)?
- **Department routing:** How does a patient know which department to go to? Will there be **separate kiosks per department** (cardiology, general, ortho…), each with its **own QR** that drops the patient into that department's queue — or a single entry point with triage-based routing?
- **Intake device:** Patient smartphones (QR / WhatsApp) vs **assisted kiosks/tablets** with staff — given an elderly, low-literacy, high-volume population?
- **Languages:** Which languages must we support (Telugu / Hindi / English for Hyderabad; others)?

## 3. Clinician workflow
- **Doctor device:** Will doctors access the dashboard on **computers** or **phones**?
- **Summary delivery:** Should the pre-consult summary appear on a **standalone screen** or be pushed **into the doctor's existing system**?

## 4. Questionnaire (DAG)
- **Question content:** Should the DAG questions be **generic placeholders for testing** now, or **real clinical questions** already — given we don't yet know the exact departments?
- **Clinical validation:** Who validates the **clinical relevance/importance** of each question (even after our own research)?
- **Triage / red-flags:** Who signs off the triage and emergency-escalation logic, and what is the intended **emergency pathway** when a red flag fires?

## 5. HIS dashboard features
- **"Protocol" tab:** What is this tab actually meant to do, and what changes do they want? *(we need clarity on its purpose before reworking it)*
- **"Analytics" tab:** What metrics does the hospital actually need to see?

## 6. Drug safety
- **Interaction database:** **DDInter 2.0** is large (~200K interaction pairs across ~1,900 drugs) and free for academic/non-commercial use, but a **hospital may need a license**. Acceptable? Alternative is our current DB **plus AI checking**, but calling an LLM for each pair not in the DB can get expensive — and our current DB is sparse. Which direction do they want?
- **Formulary scope:** What drug formulary coverage is expected?

## 7. Data, privacy & security (DPDP)
- **Residency:** On-shore vs cloud for patient PHI, and hosting model (on-prem at hospital vs Indian-region cloud)?
- **Auth model:** Per-user accounts + RBAC? SSO? *(we've added shared-passcode admin login + JWT roles as an interim step)*
- **Patient identity:** Do we match an existing hospital ID (UHID/MRN) or mint our own?
- **Compliance:** Required consent, data retention, deletion, and audit-trail policies?

## 8. Interoperability & regulation
- **HIS/HMIS integration:** Which existing system must we integrate with? Is **ABDM/ABHA** (national health ID) in scope?
- **Regulatory:** Is **ethics-committee / IRB** approval needed for the pilot? Any **CDSCO / medical-device (SaMD)** considerations, given triage influences clinical decisions?

## 9. Validation
- **Benchmarking:** Who provides **labeled data and acceptance thresholds** for validating OCR / Bhashini ASR / triage before clinical reliance?

---

*Decisions parked pending these answers: DPDP/hosting & on-shore model choice,
interoperability/ABDM, OTP, drug-DB licensing, multi-tenancy, DAG clinical
content, emergency-escalation policy, per-user admin accounts/SSO.*
