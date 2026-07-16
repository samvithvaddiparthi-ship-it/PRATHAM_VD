# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-powered OPD pre-consultation system for Indian hospitals. Patients complete intake (QR scan or WhatsApp) during their wait; doctors receive AI-enriched summaries. Currently a POC — not yet for clinical use.

## Related repos & the sync model (updated 2026-07-16 — READ THIS FIRST)

**This repo is CANONICAL. Everything is authored here.** The production repo
`../../pratham-opd-clean` = `github.com/Dhyan-rao-10/Pratham-OPD` (public, deploys to
opd-app.coherentix.com) is a **BUILD ARTIFACT generated from this one**.

### The rule that replaced the old ledger

- **NEVER author, edit, or hand-fix anything in `pratham-opd-clean`.** It is regenerated
  from here by `scripts/sync-clean.sh` and force-pushed. Any change made there directly
  will be silently destroyed on the next sync — and, worse, it recreates the drift that
  caused the July 2026 near-outage.
- **Why this replaced the old "port targeted changes + ledger" process:** both repos were
  being authored in, so neither was the source of truth. "Sync" became a manual merge
  needing judgment on every conflict, and things fell through. A derived artifact cannot
  drift. If you want to know whether clean is up to date: re-run the sync and check the
  diff is empty.
- The old `SYNC-LEDGER-pratham-to-clean.md` is **history now, not process.** Do not add
  rows to it. It documents how the two repos diverged and what it cost.

### What is excluded from the generated repo

Exclusions live in `.cleanignore` (gitignore syntax) at the repo root — that file is the
single source of truth, not this list. Broad strokes: `CLAUDE.md`, the `*-lab/`
prototypes, mentor/process docs, and the demo-seed migrations (see below).

**Never pattern-match on "claude"/"anthropic" to decide what ships.** The product
legitimately calls the Anthropic API (`llm_client.py`, `requirements.txt`, `render.yaml`).
Only `CLAUDE.md`-as-a-document is the tell. No shipped file may contain the string
`CLAUDE.md` — the sync asserts this and refuses to run otherwise. Fix such a reference at
source; do not scrub it in transit.

### Demo seed data — the one legitimate test/prod difference

`db/migrations/005_doctors.sql` and `006_departments.sql` are **excluded from the sync**
and are the *only* migrations that differ between the repos. Here they seed 3 demo doctors
(PIN 1234) + CARD/GEN so the app is testable; in production they seed a clean slate so a
new hospital does not deploy with demo logins. Both are already applied in every existing
DB (`schema_migrations` is keyed on filename), so they will never re-run and are
effectively frozen. **Do not "fix" this divergence by mirroring them** — that would ship
PIN-1234 doctors to every fresh hospital deployment.

Every other migration is byte-identical across both repos. Keep it that way.

### Outstanding production TODO

Kept OUTSIDE git at `Documents/Internship-2026/PRODUCTION-TODO-pratham-opd.md`. Parked:
DPDP retention worker, per-user admin accounts (currently one shared `ADMIN_PASSCODE`),
error tracking (Sentry vs self-hosted GlitchTip — needs a DSN), LICENSE/SECURITY.md
(asking mentor), Postgres TLS (only when DB moves off-box).
- **Bhashini STT** needs `BHASHINI_INFERENCE_API_KEY` (required) + `BHASHINI_UDYAT_KEY`; the working values are in this folder's `.env` (lines 53–54, from mentor Ebith — rotate before go-live). Now documented in `.env.example`. Health check: `GET /api/transcribe/health` → `{"bhashini": true}`.

## Production intent (apply this lens)

This is a POC **but it is intended for real deployment in Indian hospitals.** Make production-grade decisions by default; explicitly flag anything that is demo-only (e.g., the testing phone hard-cap). Hold work to these standards:

- **Clinical safety:** AI outputs (OCR extraction, triage, interaction advice, scribe) are decision-support only — never auto-applied to care without a human (doctor/pharmacist) in the loop. Keep the HIS review queue + confidence gating; low-confidence AI routes to human review. Keep the "not for clinical use" disclaimer until each AI component is formally validated.
- **Data privacy (India DPDP Act 2023):** patient data is sensitive PHI. Consent before collection (already in flow); minimize what's stored; **de-identify any data used for testing/benchmarking**; secure storage, access control, audit trail, and deletion support. **Encryption at rest (B1):** uploaded PHI in MinIO is encrypted (SSE-S3) when `MINIO_KMS_SECRET_KEY` is set — required in `docker-compose.prod.yml`, enabled best-effort in `storage.py`; Postgres relies on host disk/volume encryption (see `deploy/OPERATIONS.md`). **Access audit (B7):** viewing a patient's report (`GET /api/report/{id}`) logs a `patient_viewed` row to `audit_log` via `view_audit.py` (deduped ~5 min, non-blocking). **Deletion/retention (B2) still TODO.**
- **Validation:** AI components (OCR / Bhashini ASR / NMT) must be benchmarked against held-out labeled datasets with agreed acceptance thresholds before clinical reliance; re-run on every model/prompt change (regression). Pin model + prompt versions in any accuracy report for reproducibility.
- **Auth / access control:** node-backend JWT is hardened — `dev_secret` removed (fails closed in production without a strong `JWT_SECRET`; uses a random ephemeral key in dev). Tokens carry a `role` (`patient`/`doctor`/`admin`) enforced by `requireRole` (`middleware/auth.js`). Mutating admin/doctor-management/analytics/protocol/prescription endpoints are now role-gated, and the HIS dashboard sits behind an admin passcode login (`POST /api/admin/login`, env `ADMIN_PASSCODE`). **python-backend is now JWT-gated too** (pilot A1): `services/python-backend/src/auth.py` verifies the SAME login token (HS256, shared `JWT_SECRET`, stdlib — no pyjwt) via a `require_auth` FastAPI dependency applied to all sensitive routers in `main.py`. Media-`<src>` GETs stay open per-route (`/api/audio/clip/{id}`, `/api/ocr/documents/image/{id}`) plus `/api/transcribe/health`. `DEMO_QR_SECRET` now fails closed in production (prescription.js). **Required env:** `JWT_SECRET` (strong — now needed in dev too, since python can't verify node's ephemeral key), `ADMIN_PASSCODE` (≥6), `DEMO_QR_SECRET` (strong) — in `.env` (gitignored); run `node scripts/gen-secrets.js` to generate all. The HIS admin login now requires the admin's **name** (A9); a global middleware in `index.js` audits every successful admin mutation to `audit_log` (`admin_action`, who/what). **Still open (release blockers):** admin is still a single shared passcode (no per-user *accounts*/SSO — named-admin audit only); no per-hospital tenancy; per-user role-gating of doctor-only python routers is a refinement (currently any valid token).
- **Patient AI notice:** a one-time notice on the **consent page only** (`app/patient/consent/page.jsx`, strings `ai_notice_title` / `ai_notice_body` in en/hi/te). It states exactly what AI does here — speech-to-text, translation, reading uploaded documents, drafting the doctor's summary — and that **AI does not decide urgency and does not diagnose**. That last part is literally true and must stay true: see the triage note below. Deliberately not a persistent banner. (An unused `disclaimer` string remains in `lib/i18n.js` for a future clinician-facing surface; there is no `Disclaimer.jsx`.)
- **Triage is deterministic — keep it that way.** `sessions.triage_level` has exactly three writers, all rule-based and all monotonic (escalate-only, never downgrade): `routes/questionnaire.js` and `routes/whatsapp.js` (admin-authored `triage_flag` on a question node) and `routers/triage.py` (hardcoded symptom/vitals rules). **No LLM writes triage.** `routers/llm.py` parses a `TRIAGE_FLAG` out of model output, but only returns it — and `/api/llm/interview` is currently called by nothing. Before wiring that endpoint up, get a human decision: it would make an LLM an input to patient acuity, which changes the regulatory posture (SaMD) and invalidates the patient notice above. It also has a live bug — `llm.py` returns `{symptom, level}` while `app/patient/interview/page.jsx` compares `triage_flag === 'RED'`, so the emergency screen would never fire.
- **Reliability:** avoid in-memory-only critical state (e.g., WhatsApp conversation state), keep migrations idempotent, keep graceful degradation (LLM already falls back to rule-based).

---

## ⚠️ DOCTOR PIN STORAGE — the bug that nearly locked out production

**PINs are bcrypt, stored IN PLACE in `doctors.pin_hash`. There is no
`pin_hash_bcrypt` column. Never add one.**

All PIN work goes through `services/node-backend/src/utils/pinHash.js`
(`hashPin` / `verifyPin`). `verifyPin` returns `{ ok, needsRehash }` and transparently
accepts the legacy unsalted SHA-256 (detected by shape: 64 hex chars), flagging
`needsRehash` so the login handler upgrades it to bcrypt in place. Never call `bcrypt.*`
or `crypto.createHash` for a PIN directly from a route.

**What went wrong (2026-07-16):** an earlier design kept SHA-256 in `pin_hash` and put
bcrypt in a separate `pin_hash_bcrypt` column defaulted to `''`. Against production's real
data — where bcrypt already sat in `pin_hash` — that column read falsy, login fell to the
legacy branch, SHA-256-compared a bcrypt string, never matched, and **every doctor would
have been locked out and then rate-limited.**

**The part that matters for testing:** that bug was *invisible on a fresh local DB*. A
fresh DB seeds SHA-256 PINs, so the legacy branch matched and login worked perfectly.
Only a database whose `pin_hash` already holds bcrypt reproduces it. **"It worked locally"
was true and worthless.** Any change touching PIN storage, or any migration adding a
column that code branches on, must be tested against a DB seeded to look like production —
see `scripts/verify-clean.sh`.

**Corollary:** because bcrypt is salted, there is no fixed digest for the demo PIN. Both
demo-PIN guards (login in `routes/doctor.js`, startup force-expire in `index.js`) must use
`verifyPin('1234', ...)` or compare the plaintext just verified. A `WHERE pin_hash = $digest`
check silently matches nobody and fails open.

---

## ⚠️ DATABASE MIGRATION RULE — READ THIS BEFORE ANY DB CHANGE

This is the most common source of bugs when teammates sync. Follow this exactly every time.

### When YOU add a migration (adding a new feature that changes the DB):

1. Create a new file: `db/migrations/0NN_description.sql` (next number in sequence — currently at 029; the next new migration is 030)
2. Every statement MUST be idempotent:
   - Tables: `CREATE TABLE IF NOT EXISTS`
   - Columns: wrap in `DO $$ BEGIN ALTER TABLE ... ADD COLUMN ...; EXCEPTION WHEN duplicate_column THEN NULL; END $$`
   - Indexes: `CREATE INDEX IF NOT EXISTS`
   - Never use plain `ALTER TABLE ADD COLUMN` — it will crash on re-run
3. Rebuild and restart node-backend so migrate.js picks it up:
```bash
   docker compose build node-backend && docker compose up -d node-backend
   docker compose restart gateway
```
4. Commit the migration file together with the code that uses it — never separately

### When your TEAMMATE adds a migration (you pulled their changes):

After `git pull --rebase`, if you see any new files in `db/migrations/`:
```bash
docker compose build node-backend && docker compose up -d node-backend
docker compose restart gateway
```
**`docker compose restart node-backend` alone is NOT enough** — the old image doesn't have the new SQL file baked in. You must rebuild.

### How to verify the migration actually ran:
```bash
docker compose exec postgres psql -U opd_user -d opd_preconsult -c "\d table_name"
```
Check that the new table/column exists. If it doesn't, the migration didn't run — rebuild again.

### When Claude adds a migration:
- Claude must always create the migration file AND remind you to rebuild node-backend
- Claude must never modify existing migration files — add a new one instead
- Claude must always use idempotent SQL — never plain ALTER TABLE ADD COLUMN

---

## Common Commands

```bash
# Start all services (first run ~5 min for Tesseract image pulls)
cd opd-preconsult
cp .env.example .env   # fill in optional API keys
docker compose up --build

# IMPORTANT: code changes need a REBUILD, not a restart.
# frontend, node-backend and python-backend bake their source into the image at
# build time (no bind mounts in docker-compose.yml), so `docker compose restart`
# just reruns the OLD image. Any edit to source requires:
docker compose build python-backend && docker compose up -d python-backend
docker compose restart gateway   # after a backend rebuild — drops stale upstream IPs (avoids 502s)
# (substitute frontend / node-backend; you can build several at once:
#  docker compose build python-backend frontend && docker compose up -d python-backend frontend)

# `docker compose restart <svc>` only helps for config/env changes, NOT source edits.
# Verify a code change actually landed inside the container, e.g.:
#  docker compose exec -T python-backend python -c "from src.drug_data import normalize_drug_name; print(normalize_drug_name('Crocin'))"

# Run a specific migration manually (if needed)
docker compose exec -T postgres psql -U opd_user -d opd_preconsult < db/migrations/010_minio_image_key.sql

# Connect to the database
docker compose exec postgres psql -U opd_user -d opd_preconsult

# View logs
docker compose logs -f node-backend
docker compose logs -f python-backend

# Wipe everything including volumes (WARNING: deletes all data)
docker compose down -v
```

---

## Code Style Rules (NON-NEGOTIABLE)

### Frontend UI / accessibility
The UI targets **WCAG 2.1 AA** (reachable via GIGW 3.0 / IS 17802 / RPwD Act 2016 for
government-hospital deployment). `cd frontend && npm run check:contrast` asserts the
token palette and **must pass** — several tokens sit within 0.15 of their floor.
- All colour comes from CSS custom properties in `app/globals.css`. Never inline a new
  hex for a semantic colour. If you add one, add its pair to `scripts/check-contrast.mjs`.
  If the check fails, darken the colour — never relax the threshold.
- Amber is a light swatch: pair it with `--amber-on` (dark ink), **never white** (1.93:1).
  Amber text on a light surface is `--amber-text`; on a pale amber chip, `--amber-on-tint`.
  Same split for `--green` / `--green-on-tint`.
- Inline font sizes in `doctor/page.jsx` and `his/page.jsx` must be written
  `calc(Npx * var(--fs))`. A bare `fontSize: 13` silently ignores the text-size control.
  Never scale these pages with CSS `zoom` — the doctor shell is `height: 100vh; overflow: hidden`.
- Modals: use `useConfirm()` (confirmations) or `<Modal>` / `useDialogA11y` (content
  dialogs) from `components/ui/`. They provide `role="dialog"`, `aria-modal`, focus trap,
  Escape, and focus restore. Do not hand-roll a `position: fixed; inset: 0` overlay.
- Fonts come from `next/font/google` in `app/layout.jsx` (self-hosted at build time).
  Never reintroduce an `@import` from `fonts.googleapis.com` — it leaks patient IPs and
  breaks on a firewalled hospital LAN. Devanagari and Telugu need their own families;
  plain `Noto Sans` has no glyphs for either.
- The public queue board (`/queue`, `GET /api/queue/board`) is unauthenticated: token
  numbers only. **Never** add `triage_level` back to it — a token is de-anonymised the
  moment it is called, so per-token acuity discloses health status to the waiting room.
- **PWA: manifest only, no service worker.** `app/manifest.js` is inert metadata and is
  safe. Do **not** add a service worker (or `next-pwa`) without an explicit human
  decision: it would cache PHI to Cache Storage on shared devices (DPDP), let a doctor
  see a stale cached report or triage level, and keep clinicians on old JS after a
  deploy. If it ever happens: app shell + static assets only, never `/api/*`, with a
  cache key tied to the build id. `output: 'standalone'` does not bundle `public/` —
  both Dockerfiles copy it explicitly, or the icons 404.

### JavaScript (node-backend + frontend)
- No `console.log` in committed code — use the existing logger pattern in the codebase
- All Express route handlers must have try/catch — never let an unhandled promise rejection crash the server
- API responses follow this shape consistently:
  - Success: `res.json({ success: true, data: ... })`
  - Error: `res.status(4xx/5xx).json({ success: false, error: "message" })`
- Never return raw database error messages to the client — log them server-side, return a generic message
- Use `async/await` — no raw `.then()/.catch()` chains in new code
- Environment variables always read from `process.env` — never hardcode keys, URLs, or secrets

### Python (python-backend)
- All FastAPI endpoints must have explicit error handling — use `HTTPException` with appropriate status codes
- Never `print()` for logging — use Python's `logging` module
- Type hints on all function signatures
- LLM calls always go through `llm_client.py` — never call provider SDKs directly from routers
- Prompts always go in `prompts/` as `.txt` files — never inline long prompts in code

### Both
- PHI (patient names, phone numbers, diagnosis) must never appear in logs
- Never commit `.env` — only `.env.example` with placeholder values
- No hardcoded phone numbers, patient IDs, or doctor PINs in source — use env or seed scripts

---

## Error Handling Patterns

### Node.js routes
```javascript
// Standard pattern — use this everywhere
router.post('/endpoint', requireRole('doctor'), async (req, res) => {
  try {
    // logic here
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('endpoint failed:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
```

### Python FastAPI routes
```python
# Standard pattern — use this everywhere
@router.post("/endpoint")
async def endpoint(req: RequestModel):
    try:
        result = await some_service(req)
        return {"success": True, "data": result}
    except SomeSpecificError as e:
        logger.error(f"endpoint failed: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"endpoint unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
```

---

## Architecture

Three services behind an Nginx reverse proxy:

| Service | Port | Responsibility |
|---------|------|---------------|
| `frontend` | 3000 | Next.js 14 App Router (patient flow, doctor dashboard, HIS admin) |
| `node-backend` | 4001 | Express — sessions, auth, questionnaire DAG, prescriptions, WhatsApp webhook, SSE alerts, analytics |
| `python-backend` | 4002 | FastAPI — LLM reports, triage, OCR, drug interactions, ambient scribe |
| `postgres` | 5432 | PostgreSQL 16 — migrated automatically on node-backend startup |
| `redis` | 6379 | Pub/sub for SSE nursing alerts |
| `minio` | 9000 | S3-compatible object storage for uploaded documents |

Nginx routes: `/api/llm`, `/api/triage`, `/api/report`, `/api/ocr`, `/api/prescription/check-*`, `/api/scribe` → python-backend. All other `/api/*` → node-backend. Everything else → frontend.

---

## Key Code Locations
services/
├── node-backend/src/routes/    # One file per domain (session, doctor, admin, prescription, …)
│   └── workers/followup-worker.js  # setInterval background job for follow-up messages
└── python-backend/src/
├── routers/                # FastAPI routers mirroring node route structure
├── llm_client.py           # Gemini → Claude → rule-based fallback (reads env keys)
├── drug_interactions.py    # Static interaction matrix (~50 pairs)
└── prompts/                # system_report.txt, system_interview.txt, system_scribe.txt
db/migrations/                  # Sequential SQL files 001–027; run in order on startup (auto-applied by migrate.js)
frontend/src/app/
├── patient/                    # Multi-step intake flow (register, consent, documents, interview, vitals)
├── doctor/page.jsx             # Doctor dashboard — Queue / Consulting / Consulted; Report / Prescribe / Scribe tabs
├── his/page.jsx                # Admin — Patients, Analytics, Departments, Doctors, Questionnaires, Protocols, Drug Formulary
└── queue/page.jsx              # PUBLIC waiting-room "Now Serving" board — /queue?dept=CARD (token numbers only, no auth, no PHI)

---

## Patient Queue & Tokens (gov-OPD model)

Single hospital QR: one static poster whose QR is the **plain app URL** `https://<host>/?h=<hospital_id>` (`scripts/qr-poster.html` renders a printable poster; `scripts/generate-qr.js [baseUrl]` prints the URL). Flow: patient scans → **language** (`app/page.jsx`, creates the session with hospital_id only, NO department) → **phone → OTP → details** → **department picker + optional preferred doctor** (`app/patient/register/page.jsx`, `department` phase: icon+name buttons, search, per-department last-token, TTS) → `/register`. Entry is resolved by `parseEntry()` in `app/page.jsx`: `?h=<id>` (recommended), a bare domain QR (falls back to `NEXT_PUBLIC_HOSPITAL_ID` or `demo_hospital_01`), or legacy base64 `?qr=` — all backward compatible. **The department is chosen after details and set at `/register`** (session created department-less at scan; `sessions.department` made nullable in migration 026); the queue token is only issued once the department is present. Department icons come from `departments.icon` (migration 024, admin-set in HIS) with a code-based fallback. **The token is assigned server-side at registration** (`routes/session.js` `/register`), NOT from the QR — the QR's old random `queue_slot` is ignored. Tokens are daily-sequential per department (`DEPT-NNN`, e.g. `CARD-007`) via the `queue_counters` table (migration 022; atomic upsert, auto-resets each day by `service_date`); assigned once per session (idempotent on re-register/Back-nav). Shown on the Done page and the public board.

Public board: `GET /api/queue/board?department=CARD` (`routes/queue.js`, no auth, token numbers only) → `now_serving` (visits a doctor has opened: `assigned_doctor_id`+`consulted_at`, `dispatched_at` NULL) and `waiting` (state COMPLETE, not yet picked up), waiting ordered urgent-first (RED→AMBER→GREEN) then arrival. Display page `/queue?dept=CARD` polls it. **Open mentor decision:** strict FCFS vs triage-priority call order (board ORDER BY is the only change point).

---

## LLM Provider Logic

In `python-backend/src/llm_client.py`:
- **Text** (`complete`): Gemini → Groq → OpenAI → Anthropic → rule-based fallback (by which keys are set)
- **Vision/OCR** (`complete_with_image`): local on-shore model (env `LOCAL_VISION_BASE_URL`/`LOCAL_VISION_MODEL`, e.g. Ollama-served Qwen2.5-VL — DPDP-clean, off by default) → Gemini → Groq (Llama-4) → OpenAI GPT-4o → Anthropic → Tesseract regex fallback

All LLM features degrade gracefully without keys. OCR prompt + brand→generic normalization live in `routers/ocr.py`. Accuracy harness: `eval/ocr/` (gitignored data; `run_eval.py` cloud, `run_eval_local.py` local).

---

## What Claude Must NEVER Do

- Never modify an existing migration file — always create a new numbered one
- Never use `console.log` — use the existing logger
- Never return raw DB errors or stack traces to API clients
- Never hardcode secrets, API keys, phone numbers, or patient data
- Never make a DB schema change without creating a migration file AND reminding the developer to rebuild node-backend
- Never add a new npm or pip package without explicitly flagging it (teammate needs to rebuild their image too)
- Never call LLM provider SDKs directly from FastAPI routers — always go through `llm_client.py`
- Never store or log PHI in plaintext outside the secured DB

---

## Local Access

| URL | What |
|-----|------|
| `http://localhost/?h=demo_hospital_01` | Patient intake (single hospital QR; print via `scripts/qr-poster.html` or `node scripts/generate-qr.js`) |
| `http://localhost:3000/doctor` | Doctor dashboard (PIN: `1234` for all demo doctors) |
| `http://localhost:3000/his` | HIS admin |
| `http://localhost:9001` | MinIO console (`minioadmin` / `changeme_in_production`) |

Demo doctors: Dr. Priya Sharma (9876500001, CARD), Dr. Anil Reddy (9876500002, CARD), Dr. Kavitha Menon (9876500003, GEN).

---

## Deployment

**Local (dev)**: Docker Compose (`docker-compose.yml`, multi-container, `NODE_ENV=development`). Infra/backend host ports are bound to `127.0.0.1` (reachable for local tools, not the network — pilot A5).
**Self-hosted prod**: `docker-compose.prod.yml` (standalone) — **Caddy** terminates TLS (auto Let's Encrypt, `deploy/Caddyfile`) in front of the internal nginx gateway; only Caddy publishes host ports (80/443), nothing else; `NODE_ENV=production`. Run: `DOMAIN=opd.hospital.in docker compose -f docker-compose.prod.yml up -d --build` (needs a filled `.env` + DNS for `$DOMAIN`). Keep it in sync with the base compose when services change.
**Railway / Render**: Single-container via supervisord — nginx + node-backend + python-backend + Next.js standalone all in one image. Entry point: `deploy/start.sh`. Key files: `Dockerfile`, `railway.toml`, `render.yaml`, `deploy/nginx.conf`, `deploy/supervisord.conf`.

Railway watch patterns (triggers rebuild): `services/**`, `frontend/**`, `db/**`, `deploy/**`, `Dockerfile`. Changes to other files (e.g., README) do not trigger auto-deploy.