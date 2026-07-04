# Hospital Pilot Readiness Checklist

Status of getting the OPD Pre-Consultation system from **demo/POC** to a **supervised hospital pilot**.
This is a living document — tick items as they're done and add owners/dates.

> **Golden rule:** the moment a *real* patient's name/phone/prescription enters the system, you are
> handling PHI under India's **DPDP Act 2023** and touching clinical decisions. Nothing in "P0 —
> blockers" is optional before that point. 

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · **P0** must-have before real data · **P1** before pilot go-live · **P2** during/after pilot

---

## Track A — Software & Security

### P0 — blockers before ANY real patient data
- [ ] **A1 · Authenticate the python-backend.** `/api/ocr, /api/report, /api/triage, /api/scribe, /api/drugs, /api/audio, /api/transcribe` are currently unauthenticated (anyone reaching the gateway can submit/extract PHI). Add cross-service auth (shared service token or forward + verify the JWT in FastAPI).
- [ ] **A2 · HTTPS/TLS everywhere.** Gateway currently listens on plain `:80`. Terminate TLS (Caddy/nginx + Let's Encrypt, or a host/LB that provides HTTPS). No PHI over HTTP.
- [ ] **A3 · `NODE_ENV=production` in the real deploy.** `docker-compose.yml` sets `NODE_ENV: development`, which bypasses the JWT fail-closed guard. Use a hardened `docker-compose.prod.yml`.
- [ ] **A4 · Rotate every secret.** `.env.example` ships `changeme_*` defaults for `POSTGRES_PASSWORD`, `MINIO_SECRET_KEY`, `ADMIN_PASSCODE`, `JWT_SECRET`, and `DEMO_QR_SECRET` (the last HMAC-signs prescription QRs — weak = forgeable). Generate strong random values; never commit real `.env`.
- [ ] **A5 · Stop exposing infra ports.** Compose publishes postgres `5432`, redis `6379`, minio `9000/9001` to the host. Keep them on the internal network only in prod.
- [ ] **A6 · Remove demo/testing artifacts:** the 10-digit phone hard-cap in the register page; force a PIN reset for the seeded demo doctors (PIN `1234`); require a real SMS provider (no inline OTP dev-code) in prod.

### P1 — before pilot go-live
- [ ] **A7 · Backups + tested restore** for Postgres and MinIO (none today). Automated `pg_dump` + MinIO mirror; verify a restore.
- [ ] **A8 · Real SMS / WhatsApp.** Twilio is in sandbox. India needs **DLT registration** (SMS) and **WhatsApp Business API** approval — long lead time, start now.
- [ ] **A9 · Admin RBAC/audit.** Single shared `ADMIN_PASSCODE` = no "who did what." At least per-user admin accounts for the pilot.
- [ ] **A10 · Persist WhatsApp conversation state** (currently in-memory — a restart drops mid-flow patients).
- [ ] **A11 · Smoke tests** for the critical path (scan → register → triage → report) so a rebuild can't silently break intake. (No automated tests exist today.)
- [ ] **A12 · Error monitoring + uptime** (e.g. Sentry + a healthcheck monitor) so you know when it's down during the pilot.
- [ ] **A13 · Gateway hardening:** security headers + rate limiting on OTP and upload endpoints (none today).

### P2 — during/after pilot
- [ ] **A14 · Load/soak test** at realistic OPD volume.
- [ ] **A15 · High availability** (multi-instance workers, DB failover) — only if the pilot scales.

---

## Track B — Data Privacy (DPDP Act 2023)
- [ ] **B1 · Encryption at rest** for Postgres + MinIO volumes (unencrypted by default). Volume/disk encryption or column-level (pgcrypto) for the most sensitive fields; MinIO SSE.
- [ ] **B2 · Retention + deletion policy** implemented (DPDP requires deletion/erasure support — not built yet).
- [ ] **B3 · De-identification of any test/benchmark data** (DPDP data-minimization). See Presidio note below.
- [ ] **B4 · Consent language reviewed** by the hospital + counsel (capture + audit log already exist — good foundation).
- [ ] **B5 · Data Processing Agreement (DPA)** between your team and the hospital (who is data fiduciary vs processor).
- [ ] **B6 · PHI never in logs** — verify/enforce (grep + a redaction pass). Audio: scribe is zero-retention, but per-answer voice clips ARE stored (that's PHI).
- [ ] **B7 · Access log / audit trail** for who viewed which patient (extend `audit_log`; consider pgAudit).

---

## Track C — Clinical Governance
- [ ] **C1 · Keep the "Investigational — not for clinical use" banner** until each AI component is formally validated.
- [ ] **C2 · Doctor-in-the-loop rule** documented — AI outputs (OCR, triage, report, interactions) are decision-support only, never auto-applied.
- [ ] **C3 · RED-triage escalation path** defined: who receives the SSE nursing alert, and what they do.
- [ ] **C4 · AI validation before clinical reliance (SaMD):** OCR eval harness exists (`eval/ocr`). Benchmark **triage, report generation, Bhashini ASR/NMT** against labeled data with agreed acceptance thresholds; pin model + prompt versions.
- [ ] **C5 · AI observability** (Analytics Tier 3): log OCR/triage confidence + % routed to human review — doubles as SaMD traceability evidence.
- [ ] **C6 · Ethics committee / IRB approval** for the pilot.
- [ ] **C7 · FHIR conformance check** on the R4 output (e.g. HAPI validator) before any real HIS integration.

---

## Track D — Operations & the "Package"
- [ ] **D1 · Pick + harden a deployment artifact:** `docker-compose.prod.yml` (TLS, no exposed DB ports, `NODE_ENV=production`, real secrets) OR the single-container supervisord build.
- [ ] **D2 · Filled, secured `.env`** with rotated secrets + real `DEMO_HOSPITAL_ID`/name.
- [ ] **D3 · Printed QR poster** (`scripts/qr-poster.html`) pointed at the deployed HTTPS URL, placed in the OPD.
- [ ] **D4 · Network/hardware:** reliable OPD wifi, the server/host, optional help-desk kiosk tablet.
- [ ] **D5 · Runbook/SOP:** start/stop, update+rebuild (migration rule), backup/restore, and a **paper fallback** if the system is down.
- [ ] **D6 · Staff training** (1-pager each): help-desk/social workers, doctors, admin.
- [ ] **D7 · Support contact + feedback loop** (the doctor accurate/inaccurate rating is a start).
- [ ] **D8 · Real HIS integration** (currently a mock FHIR webhook) — scope with the hospital's IT.

---

## Suggested phasing
- **Phase 0 (now → ~2 wks):** Track A P0 + kick off long-lead items (WhatsApp/SMS approvals, IRB paperwork, DPA).
- **Phase 1 (pilot prep):** backups, monitoring, smoke tests, DPDP/consent + DPA sign-off, staff training, deploy to staging with real HTTPS.
- **Phase 2 (limited pilot):** one department, low volume, doctor-in-the-loop, banner up, daily monitoring, collect feedback + validation data.
