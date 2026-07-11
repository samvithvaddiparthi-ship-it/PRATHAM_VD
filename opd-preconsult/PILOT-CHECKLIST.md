# Hospital Pilot Readiness Checklist

Status of getting the OPD Pre-Consultation system from **demo/POC** to a **supervised hospital pilot**.
This is a living document — update the markers as things land.

> **Golden rule:** the moment a *real* patient's name/phone/prescription enters the system, you are
> handling PHI under India's **DPDP Act 2023** and touching clinical decisions. Nothing in "P0 —
> blockers" is optional before that point.

**Legend:** ✅ done · 🟡 partial / in progress · ⏸️ parked (waiting on a decision) · ⬜ not started · ⚠️ needs attention
**Priority:** **P0** must-have before real data · **P1** before pilot go-live · **P2** during/after pilot

---

## 📊 Progress at a glance
| Track | ✅ | 🟡 | ⏸️ | ⬜ / ⚠️ | Notes |
|-------|----|----|----|--------|-------|
| **A — Software & Security** | 10 | 1 | 2 | 2 | **P0 complete**, most of P1 done |
| **B — Data Privacy** | 3 | 0 | 0 | 4 | B1 encryption + B6 logs + B7 view-audit done; B2/B3 code-able, B4/B5 legal |
| **C — Clinical Governance** | 0 | 1 | 0 | 6 (incl. ⚠️1) | C3 alert mechanism fixed; rest process/IRB; C1 banner conflict |
| **D — Operations / Package** | 2 | 3 | 0 | 3 | runbook + paper-fallback SOP + staff training done |

**Overall: 15 done · 5 in progress · 2 parked · rest not started.** Security posture (Track A) is in good shape; encryption at rest, PHI-in-logs and access audit (Track B) now done; remaining blockers are the legal privacy docs, clinical governance (mostly process), and deployment ops.

### 🔧 Fixes verified during the patient-flow run-through (2026-07-07)
- **Triage no longer silently downgrades** — the holistic evaluator (`triage.py`) is now **monotonic**: it may escalate but never lowers a level already raised by an interview safety tripwire (e.g. chest pain → RED). Fixes a *"patient told SEVERE, then handed a GREEN token"* mismatch **and** ensures the RED nursing-station alert actually fires (that publish only ran when the evaluator's own level was RED). Downgrade is now human-only. *(see C3)*
- **Clinical-protocol matching restored** — `GET /api/protocol/evaluate` was returning **500** (queried a non-existent column `answer_value`; corrected to `answer_raw`), so protocol triggers never ran. Now returns 200 and evaluates the department's protocols.

---

## Track A — Software & Security

### P0 — blockers before ANY real patient data  — ✅ **6/6 complete**
- ✅ **A1 · Authenticate the python-backend.** `services/python-backend/src/auth.py` verifies the login JWT (shared `JWT_SECRET`, HS256, stdlib — no pyjwt) via a `require_auth` dependency on all sensitive routers. Media-`<src>` GETs (`/api/audio/clip/{id}`, `/api/ocr/documents/image/{id}`) + `/api/transcribe/health` stay open by design. **Requires `JWT_SECRET` set in `.env` (dev too).** *Refinement left: per-role gating of doctor-only routers.*
- ✅ **A2 · HTTPS/TLS.** `docker-compose.prod.yml` + `deploy/Caddyfile` put Caddy (auto Let's Encrypt) in front of the gateway; only Caddy publishes 80/443. **Needs a real domain + DNS at deploy time.**
- ✅ **A3 · `NODE_ENV=production`.** Set in `docker-compose.prod.yml` (activates the node JWT fail-closed guard).
- ✅ **A4 · Rotate every secret.** `scripts/gen-secrets.js` prints strong values; `DEMO_QR_SECRET` fails closed in production (`prescription.js`); `.env.example` sharpened. **Operational step remains: generate + set them in the real deploy `.env`.**
- ✅ **A5 · Stop exposing infra ports.** Base `docker-compose.yml` binds postgres/redis/minio/backends to `127.0.0.1`; prod compose publishes only Caddy 80/443.
- ✅ **A6 · Remove demo/testing artifacts.** Removed the phone-cap testing banner; OTP returns **503** in prod when SMS isn't configured; startup **warns** if any active doctor still uses PIN `1234`. *Forcing a PIN reset (a `must_change_pin` column) deferred — needs a migration.*

### P1 — before pilot go-live  — ✅ **4 done · 🟡 1 · ⏸️ 2**
- ✅ **A7 · Backups + tested restore.** `scripts/backup.sh` (pg_dump + MinIO archive → `backups/<ts>/`) + `scripts/restore.sh`; verified locally. Cron / off-box / restore-drill in `deploy/OPERATIONS.md`. **Do a real restore drill before go-live.**
- ⏸️ **A8 · Real SMS / WhatsApp.** **Parked pending mentor clarity.** Long lead: India **DLT** (SMS) + **WhatsApp Business API** — start once direction is confirmed.
- ✅ **A9 · Admin audit** *(pilot scope: named-admin audit, no migration).* HIS login requires the admin's **name**; a global middleware stamps every successful admin mutation into `audit_log`. *Full per-user accounts deferred (needs a migration).*
- ⏸️ **A10 · Persist WhatsApp conversation state.** Parked with A8.
- ✅ **A11 · Smoke tests.** `scripts/smoke.js` runs scan → OTP → register → triage (+ A1 auth assertions); all pass.
- 🟡 **A12 · Error monitoring + uptime.** Uptime **done** (`/healthz` + monitor wiring in `deploy/OPERATIONS.md`). **Error tracking (Sentry) deferred** — needs a package + DSN.
- ✅ **A13 · Gateway hardening.** Rate limits on OTP + upload endpoints, security headers, real-client-IP behind Caddy (`services/gateway/nginx.conf`).

### P2 — during/after pilot
- ⬜ **A14 · Load/soak test** at realistic OPD volume.
- ⬜ **A15 · High availability** (multi-instance workers, DB failover) — only if the pilot scales.

---

## Track B — Data Privacy (DPDP Act 2023)  — ✅ **3/7**
- ✅ **B1 · Encryption at rest.** **MinIO (uploaded PHI):** `MINIO_KMS_SECRET_KEY` (required in `docker-compose.prod.yml`, generated by `gen-secrets.js`) enables the bucket's default **SSE-S3**; `storage.py` turns it on best-effort when the key is present, so every new document/audio object is encrypted on disk (verified: upload → `X-Amz-Server-Side-Encryption: AES256`, transparent read-back). Dev (no key) is unaffected. **Postgres:** host **disk/volume encryption** (LUKS / encrypted cloud volume) — documented in `deploy/OPERATIONS.md` (in-app column encryption intentionally avoided for the pilot). ⚠️ **Back up the KMS key** — losing it makes encrypted objects unreadable.
- ⬜ **B2 · Retention + deletion policy** (DPDP erasure support — not built; needs a migration). *(code-able)*
- ⬜ **B3 · De-identification of test/benchmark data** (Presidio + Indian PII recognizers). *(code-able)*
- ⬜ **B4 · Consent language reviewed** by the hospital + counsel. *(legal)*
- ⬜ **B5 · Data Processing Agreement (DPA).** *(legal)*
- ✅ **B6 · PHI never in logs.** Masked patient phones in logs (`utils/phone.js maskPhone` in `sms.js` + `followup-worker.js`); stopped logging message bodies; env-configurable **CORS** on python-backend. Python error logs carry only exception types. *Residual: `/api/audio/clip/{id}` + `/api/ocr/documents/image/{id}` serve PHI by unguessable UUID without auth (media `<src>` can't send a header) — acceptable for pilot; signed URLs later.*
- ✅ **B7 · Access/audit trail** for who *viewed* which patient. `GET /api/report/{id}` (the doctor/HIS "open a patient's summary" event) now stamps a `patient_viewed` row into `audit_log` (`view_audit.py`) with the clinician's name + role — joining the existing login/consultation-action trail. **Low-noise + non-blocking:** an in-memory ~5-min dedup collapses repeat fetches (verified: 4 fetches → 1 row) and the write is best-effort (never delays/breaks the response). No migration, no new dependency. Query recipe in `deploy/OPERATIONS.md`.

---

## Track C — Clinical Governance  — ⚠️ **mostly process / IRB**
- ⚠️ **C1 · "Investigational — not for clinical use" banner.** **CONFLICT** — the banner was **removed by decision**, but this item says keep it until each AI component is validated. Reconcile the regulatory posture (re-add a lighter notice, or accept the risk explicitly) before real patients.
- ⬜ **C2 · Doctor-in-the-loop rule** documented — AI outputs are decision-support only, never auto-applied.
- 🟡 **C3 · RED-triage escalation path.** **Mechanism fixed (2026-07-07):** triage is now monotonic and the RED SSE nursing alert fires reliably even when only a per-question tripwire raised the flag (`triage.py`). **Process still to define:** who at the nursing station receives the alert and exactly what they do on it.
- ⬜ **C4 · AI validation (SaMD)** — benchmark triage / report / Bhashini ASR against labeled data + thresholds; pin model+prompt versions. *(OCR harness exists in `eval/ocr`.)*
- ⬜ **C5 · AI observability** (Analytics Tier 3): log OCR/triage confidence + % routed to human review. *(code-able)*
- ⬜ **C6 · Ethics committee / IRB approval.** *(process, long lead)*
- ⬜ **C7 · FHIR conformance check** on the R4 output (HAPI validator). *(code-able)*

---

## Track D — Operations & the "Package"  — ✅ **2 done · 🟡 3**
- 🟡 **D1 · Deployment artifact** — `docker-compose.prod.yml` built (TLS, no exposed DB ports, `NODE_ENV=production`); needs real secrets + domain at deploy.
- ⬜ **D2 · Filled, secured `.env`** with rotated secrets + real `DEMO_HOSPITAL_ID`/name.
- 🟡 **D3 · QR poster** — generator ready (`scripts/qr-poster.html`); print + point at the deployed HTTPS URL + place in the OPD.
- ⬜ **D4 · Network/hardware:** reliable OPD wifi, the server/host, optional help-desk kiosk tablet.
- ✅ **D5 · Runbook/SOP** — `deploy/OPERATIONS.md` covers deploy/update/backup/restore/monitoring **plus a full paper-fallback / downtime SOP** (when to switch, paper tokens, restart steps, coming back online) and the encryption/audit ops. *(Site-specific numbers filled at deploy.)*
- ✅ **D6 · Staff training** — three print-ready one-pagers in `docs/training/` (help-desk/social workers, doctors, admin) + an index/README with the go-live checklist and the "fills the wait, doesn't replace the doctor / it's private / paper fallback exists" core messages.
- 🟡 **D7 · Support contact + feedback loop** — feedback loop wired (doctor accurate/inaccurate rating + daily-review process, in OPERATIONS.md + training docs); **support-contact card is a fill-in-the-blank template** — add the real on-site + escalation numbers before go-live.
- ⬜ **D8 · Real HIS integration** (currently a mock FHIR webhook) — scope with hospital IT.

---

## Suggested phasing
- **Phase 0 (done / in progress):** Track A P0 ✅ + kick off long-lead items (WhatsApp/SMS approvals, IRB, DPA).
- **Phase 1 (pilot prep):** backups ✅, monitoring 🟡, smoke tests ✅, DPDP/consent + DPA sign-off, staff training, deploy to staging with real HTTPS.
- **Phase 2 (limited pilot):** one department, low volume, doctor-in-the-loop, daily monitoring, collect feedback + validation data.
