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
- [x] **A1 · Authenticate the python-backend.** Done — `services/python-backend/src/auth.py` verifies the login JWT (shared `JWT_SECRET`, HS256, stdlib — no pyjwt) via a `require_auth` dependency applied to all sensitive routers in `main.py`. Media-`<src>` GETs (`/api/audio/clip/{id}`, `/api/ocr/documents/image/{id}`) and `/api/transcribe/health` stay open by design. **Requires `JWT_SECRET` set in `.env` (dev too).** *Refinement left: per-role gating of doctor-only routers (currently any valid token).*
- [x] **A2 · HTTPS/TLS.** Done (config) — `docker-compose.prod.yml` + `deploy/Caddyfile` put Caddy (auto Let's Encrypt) in front of the gateway; only Caddy publishes 80/443. **Needs a real domain + DNS at deploy time.**
- [x] **A3 · `NODE_ENV=production`.** Done — set in `docker-compose.prod.yml` (activates the node JWT fail-closed guard).
- [x] **A4 · Rotate every secret.** Done (tooling + guard) — `scripts/gen-secrets.js` prints strong values; `DEMO_QR_SECRET` now fails closed in production (`prescription.js`); `.env.example` notes sharpened. **Operational step remains: generate + set them in the real deploy `.env`.**
- [x] **A5 · Stop exposing infra ports.** Done — base `docker-compose.yml` binds postgres/redis/minio/backends to `127.0.0.1`; prod compose publishes only Caddy 80/443.
- [x] **A6 · Remove demo/testing artifacts.** Done — removed the phone-cap testing banner; OTP returns **503** in prod when SMS isn't configured (no dev-code leak); startup **warns** if any active doctor still uses the default PIN `1234`. *Forcing a PIN reset (a `must_change_pin` column) is deferred — needs a migration; reset via `POST /api/doctor/change-pin` / HIS for now.*

### P1 — before pilot go-live
- [x] **A7 · Backups + tested restore.** Done — `scripts/backup.sh` (pg_dump + MinIO volume archive → `backups/<ts>/`, 14-day retention) + `scripts/restore.sh`; verified locally (DB + object archive produced). Cron / off-box copy / restore-drill steps in `deploy/OPERATIONS.md`. **Do a real restore drill before go-live.**
- [ ] **A8 · Real SMS / WhatsApp.** ⏸ **Parked pending mentor clarity.** Long lead: India **DLT registration** (SMS) + **WhatsApp Business API** approval — start once the direction is confirmed.
- [x] **A9 · Admin RBAC/audit** *(pilot scope: named-admin audit, no migration).* Done — HIS login now requires the admin's **name** (carried in the token); a global middleware in `index.js` stamps every successful admin **mutation** into `audit_log` (`admin_action`, who/what/status). Shared passcode is still the gate. *Full per-user accounts (a `admin_users` table + per-user auth) deferred as a fast-follow — needs a migration.*
- [ ] **A10 · Persist WhatsApp conversation state.** ⏸ Parked with A8 (WhatsApp).
- [x] **A11 · Smoke tests.** Done — `scripts/smoke.js` runs scan → OTP → register → triage (incl. the A1 auth assertions); all pass.
- [~] **A12 · Error monitoring + uptime.** Uptime done — `/healthz` liveness endpoint + monitor wiring in `deploy/OPERATIONS.md`. **Error tracking (Sentry) deferred** — needs a package + DSN.
- [x] **A13 · Gateway hardening.** Done — rate limits on OTP + upload endpoints, security headers, real-client-IP behind Caddy (`services/gateway/nginx.conf`).

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
- [x] **B6 · PHI never in logs** — Done — masked patient phone numbers in logs (`utils/phone.js maskPhone`, applied in `sms.js` + `followup-worker.js`), and stopped logging SMS/follow-up message bodies. Also tightened python-backend **CORS** to an env-configurable origin (`CORS_ALLOW_ORIGINS`). Python error logs carry only exception types, not patient data. *Residual: `/api/audio/clip/{id}` + `/api/ocr/documents/image/{id}` serve PHI by unguessable UUID without auth (media `<src>` can't send a header) — acceptable for pilot; harden with signed URLs later.*
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
