# OPD Pre-Consultation AI Agent

AI-powered OPD system for Indian hospitals. Collects patient history, documents, and vitals DURING the wait, delivers structured reports to doctors, enables prescription writing with drug interaction checks, ambient consultation recording, automated follow-ups, and analytics.

> Original base repository: [github.com/crtx-sg/pratham](https://github.com/crtx-sg/pratham). This is the actively-developed continuation. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the detailed engineering notes, and [deploy/OPERATIONS.md](deploy/OPERATIONS.md) for the runbook.

## Why

Indian OPDs see 2,000–15,000 patients/day. Doctors get under 1 minute per patient. Patients wait 2–6 hours. This system turns waiting time into data collection and gives doctors an AI-enriched pre-consultation summary before the patient walks in.

## Features

### Patient Intake & Triage
- **QR-code kiosk entry** — scan at registration desk, begins pre-consultation flow
- **WhatsApp intake** — Twilio webhook enables full questionnaire flow over WhatsApp (dept selection, registration, symptom interview)
- **Multi-lingual** — English, Hindi, Telugu with Web Speech API voice input
- **DPDP consent** — audit-logged data protection consent capture
- **Branching questionnaires** — DAG-based, department-specific, admin-editable
- **Rule-based triage** — RED/AMBER/GREEN with critical vitals detection (BP >180, SpO2 <90, chest pain + radiation)
- **Nursing station alerts** — Server-Sent Events (SSE) push RED triage alerts to connected browsers in real-time via Redis pub/sub
- **ICD-10 coding** — 22 common OPD symptoms auto-mapped to ICD-10 codes in FHIR output

### Document Processing
- **OCR pipeline** — Tesseract with English/Hindi/Telugu models
- **Medication extraction** — 60+ common Indian drugs with dose/frequency parsing
- **Lab value extraction** — PT/INR, HbA1c, FBS, creatinine, hemoglobin, WBC, platelet
- **Abnormal value flagging** — reference ranges applied, `is_abnormal` flag returned for each lab value
- **Document classification** — prescription, lab report, discharge summary, diagnostic report

### AI Reports
- **LLM-powered reports** — Google Gemini (preferred) or Anthropic Claude, with rule-based fallback
- **SOAP-style summary** — merges questionnaire answers + OCR data + vitals
- **FHIR R4 bundles** — Patient, Observation, Condition (ICD-10 coded), MedicationStatement resources
- **Doctor feedback** — accurate/inaccurate rating on generated reports

### Ambient AI Scribe
- **Consultation recording** — MediaRecorder API in doctor dashboard, start/stop button
- **Transcription** — OpenAI Whisper API (POC), zero-retention (audio never persisted to disk)
- **SOAP extraction** — LLM processes transcript into structured Subjective/Objective/Assessment/Plan notes
- **Editable transcript** — doctor can correct before SOAP extraction
- **Stored per session** — SOAP notes linked to session reports

### Prescription & Pharmacy
- **Prescription writing** — drug autocomplete (60+ drugs), dose, frequency, duration, instructions
- **Drug interaction checking** — static matrix of ~50 critical drug-drug interactions for Indian market drugs
- **Allergy cross-referencing** — checks prescribed drugs against patient allergies (sulfa, penicillin, NSAIDs, drug classes)
- **Block/warn system** — hard blocks for contraindicated combinations, warnings for monitoring-required pairs
- **QR digital prescription** — HMAC-signed JSON encoded as QR payload for pharmacy scanning
- **QR verification endpoint** — pharmacy scans QR, verifies signature, retrieves structured prescription

### Clinical Protocols (No-Code Guardrails)
- **Protocol management** — CRUD API + HIS dashboard UI for clinical protocols per department
- **Trigger conditions** — activate protocols based on questionnaire answers (e.g., chest pain → cardiac protocol)
- **Required vitals/tests** — protocols specify what data must be collected (e.g., Cardiology → BP + Lipid Profile)
- **Auto-prompt** — vitals page shows protocol-required fields prominently
- **Pre-visit messages** — multi-lingual patient advisory messages per protocol

### Doctor Workflow
- **PIN login** — 4-6 digit numeric PIN, SHA-256 hashed
- **Triage-prioritized queue** — RED patients first, auto-assign on click
- **Report/Prescribe/Scribe tabs** — three workflows in one dashboard
- **Session reassignment** — unassign, reassign to other doctors in department
- **Consultation history** — view completed sessions with feedback

### Automated Follow-ups
- **Protocol-triggered scheduling** — on session completion, matching protocols schedule follow-up messages
- **Background worker** — 5-minute interval, sends due follow-ups via Twilio WhatsApp/SMS
- **Response handling** — patient replies "better" → case closed, "worse" → flagged for follow-up visit
- **Dry-run mode** — logs messages when Twilio is not configured

### Analytics Dashboard
- **Configurable period** — 6h, 12h, 24h, 48h, 7d views
- **Summary cards** — total sessions, completed, avg total time, triage distribution
- **Department breakdown** — sessions per department with completion rate
- **Doctor breakdown** — sessions per doctor, completed count, RED alert count
- **Session state distribution** — INIT through COMPLETE pipeline visibility
- **Follow-up stats** — pending, sent, responded, closed

### HIS Admin Dashboard
- **Session management** — list, filter by department/doctor/state, reassign
- **Doctor management** — create, deactivate, list by department
- **Department management** — create/delete with referential integrity checks
- **Questionnaire builder** — form-based editor with branching rules, triage flags, multi-lingual text
- **Protocol manager** — create/edit clinical guardrails with trigger conditions and required data
- **Analytics tab** — OPD performance metrics

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 (App Router), React 18, mobile-first (`qrcode`, `react-markdown`) |
| Node backend | Express, PostgreSQL (pg), `jsonwebtoken` (JWT auth + roles), ioredis, Twilio |
| Python backend | FastAPI, Gemini/Groq/Claude/OpenAI SDKs, Tesseract OCR, Bhashini ASR/NMT/TTS, JWT-gated (stdlib) |
| Indic language | Bhashini (`indic-transliteration`) for speech-to-text, translation, and read-aloud (hi/te); `av` for audio |
| Database | PostgreSQL 16 (26 migrations, auto-applied on node-backend startup) |
| Cache | Redis 7 (pub/sub for SSE alerts) |
| Object storage | MinIO (S3-compatible; SSE-S3 encryption-at-rest for PHI) |
| Gateway | Nginx reverse proxy (dev) / Caddy TLS in front of it (self-hosted prod) |
| Messaging | Twilio — WhatsApp sandbox + SMS (used for phone-OTP verification; dry-run without keys) |
| Orchestration | Docker Compose (dev) / `docker-compose.prod.yml` (self-hosted) / single-container (Railway) |
| Languages | English, Hindi, Telugu |

## Architecture

```
                           ┌──────────┐
                    ┌──────│ Browser  │──────┐
                    │      └──────────┘      │
                    │                        │
               ┌────▼─────┐          ┌───────▼───────┐
               │ Gateway   │          │ Twilio        │
               │ :80       │          │ WhatsApp/SMS  │
               └────┬──────┘          └───────┬───────┘
                    │                         │
   ┌────────────────┼──────────────────┐      │
   ▼                ▼                  ▼      ▼
┌──────────┐ ┌─────────────┐    ┌─────────────────┐
│ Frontend │ │ Node Backend │    │ Python Backend   │
│ :3000    │ │ :4001        │    │ :4002            │
└──────────┘ │ session/q    │    │ llm/triage       │
             │ doctor/HIS   │    │ report/OCR       │
             │ protocol     │    │ scribe           │
             │ prescription │    │ drug interactions │
             │ whatsapp     │    └────────┬─────────┘
             │ alerts (SSE) │             │
             │ followup     │             │
             │ analytics    │             │
             └──────┬───────┘             │
                    │                     │
                    ▼                     ▼
             ┌─────────────────────────────────┐
             │ PostgreSQL · Redis · MinIO      │
             └─────────────────────────────────┘
```

## Project Structure

```
opd-preconsult/
├── docker-compose.yml
├── Dockerfile
├── render.yaml
├── railway.toml
├── .env.example
├── db/migrations/
│   ├── 001_sessions.sql          # Core session tables
│   ├── 002_questionnaires.sql    # Questionnaire DAG
│   ├── 003_protocols.sql         # Clinical protocols
│   ├── 004_audit.sql             # Audit logging
│   ├── 005_doctors.sql           # Doctor management
│   ├── 006_departments.sql       # Department master
│   ├── 007_prescriptions.sql     # Prescriptions + allergies
│   ├── 008_followups.sql         # Scheduled follow-ups
│   └── 009_scribe.sql            # Ambient scribe columns
├── services/
│   ├── gateway/nginx.conf
│   ├── node-backend/src/
│   │   ├── routes/
│   │   │   ├── session.js        # Patient session lifecycle
│   │   │   ├── questionnaire.js  # DAG traversal + answers
│   │   │   ├── vitals.js         # Vital signs capture
│   │   │   ├── doctor.js         # Doctor auth + queue
│   │   │   ├── admin.js          # Department + question CRUD
│   │   │   ├── protocol.js       # Protocol CRUD + evaluate
│   │   │   ├── prescription.js   # Rx CRUD + QR + allergies
│   │   │   ├── whatsapp.js       # Twilio WhatsApp webhook
│   │   │   ├── alerts.js         # SSE nursing station alerts
│   │   │   ├── followup.js       # Follow-up scheduling
│   │   │   ├── analytics.js      # OPD analytics queries
│   │   │   └── mock-his.js       # Mock FHIR receiver
│   │   └── workers/
│   │       └── followup-worker.js  # Background follow-up sender
│   └── python-backend/src/
│       ├── routers/
│       │   ├── llm.py            # LLM interview assistant
│       │   ├── triage.py         # Triage evaluation + Redis alerts
│       │   ├── report.py         # Report generation + FHIR + ICD-10
│       │   ├── ocr.py            # OCR + abnormal lab flagging
│       │   ├── prescription.py   # Drug interaction checking
│       │   └── scribe.py         # Ambient scribe (Whisper + SOAP)
│       ├── drug_interactions.py  # Static drug interaction matrix
│       ├── llm_client.py         # Gemini/Claude unified client
│       └── prompts/
│           ├── system_report.txt   # Report generation prompt
│           ├── system_interview.txt  # Interview assistant prompt
│           └── system_scribe.txt   # SOAP extraction prompt
├── frontend/src/app/
│   ├── page.jsx                  # QR scanner home
│   ├── patient/                  # Patient flow (register, consent, documents, interview, vitals, done)
│   ├── doctor/page.jsx           # Doctor dashboard (Report, Prescribe, Scribe tabs)
│   └── his/page.jsx              # HIS admin (Sessions, Doctors, Questions, Departments, Protocols, Analytics)
├── deploy/                       # Railway deployment scripts
└── scripts/generate-qr.js       # QR payload generator
```

## Prerequisites

- Docker and Docker Compose
- **Network access at image-build time.** The frontend loads Noto Sans, Noto Sans
  Devanagari and Noto Sans Telugu through `next/font/google`, which downloads them
  during `next build` and emits self-hosted `.woff2` files. Nothing is fetched from
  Google at runtime — this is what keeps patient IPs off a third party and lets the
  app work on a firewalled hospital LAN. A fully air-gapped *build* would need
  `next/font/local` with the fonts vendored into the repo.
- Node.js (only to run the helper scripts locally, e.g. `scripts/gen-secrets.js`)
- **Required secrets** (see [Environment & Secrets](#environment--secrets) below) — the app auth is now on by default, so these must be set even for local dev:
  - `JWT_SECRET` — signs/verifies login tokens; **shared by node-backend AND python-backend**
  - `ADMIN_PASSCODE` — HIS admin dashboard login (≥6 chars)
  - `QR_SIGNING_SECRET` — HMAC-signs prescription QR slips
  - Generate all of them at once with `node scripts/gen-secrets.js`
- **Twilio — REQUIRED in production, optional in dev.** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_SMS_FROM` deliver the patient's login OTP.
  - In dev (`NODE_ENV=development`), OTP runs in dry-run: the code is returned on-screen, so no Twilio account is needed.
  - **In production, `POST /api/otp/request` returns `503 "SMS delivery is not configured."` when Twilio is unset** (`routes/otp.js`) — patients cannot log in at all. This is a hard gate, not a degradation: budget for a Twilio account before any pilot.
- **(Optional) AI API keys** — every AI feature degrades gracefully without them:
  - `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` — LLM reports & OCR (rule-based/Tesseract fallback works without)
  - `OPENAI_API_KEY` — Whisper transcription in ambient scribe

## Setup

### Local Docker Compose

Run these from the directory that contains `docker-compose.yml`.

```bash
# 1. Copy env template
cp .env.example .env

# 2. Generate the REQUIRED secrets (JWT_SECRET, ADMIN_PASSCODE, QR_SIGNING_SECRET,
#    OTP_SECRET, POSTGRES_PASSWORD, MINIO_*). This PRINTS them to your terminal —
#    it does NOT write .env. Paste each line over the matching key in .env,
#    replacing the placeholder (do not just append — duplicate keys are ambiguous).
node scripts/gen-secrets.js

# 3. (Optional) add AI/messaging keys in .env — all optional, system degrades gracefully:
# GEMINI_API_KEY=AIzaSy...        # LLM reports & OCR (preferred, free tier)
# GROQ_API_KEY=gsk_...            # free fallback LLM
# ANTHROPIC_API_KEY=sk-ant-...    # LLM reports (fallback)
# OPENAI_API_KEY=sk-...           # Whisper transcription (ambient scribe)
# TWILIO_ACCOUNT_SID=AC... / TWILIO_AUTH_TOKEN=... / TWILIO_SMS_FROM=+91...  # real SMS OTP

# 4. Build and start all services
docker compose up --build
```

First-run takes ~5 minutes (image pulls, Tesseract OCR models). Subsequent starts are fast.

All DB migrations (currently **29**, in `db/migrations/`) run automatically on node-backend startup — no manual step.

**Whether the install comes up with demo doctors depends on `db/migrations/005_doctors.sql` and `006_departments.sql`** — the only two migrations that differ between a testing checkout and a clean/production one. A testing checkout seeds 3 demo doctors (PIN `1234`) + the CARD/GEN departments; a clean install seeds neither, so a new hospital never deploys with demo logins. Check which one you have:

```bash
docker compose exec postgres psql -U opd_user -d opd_preconsult -c "select name, phone, department from doctors;"
```

If that returns **0 rows**, this is a clean install: log in to HIS admin (`/his`) with your `ADMIN_PASSCODE`, create a department, then create your first doctor. There is no default doctor login to fall back on. Departments are empty by design on a clean install (migration 027 removes the starter department so the patient-facing picker isn't polluted); creating one in HIS automatically seeds its base intake questions.

> **Note on secrets:** if you skip step 2, node-backend falls back to a *random ephemeral* JWT key in dev — which python-backend cannot verify, so OCR/triage/report/scribe will return `401`. Set a real `JWT_SECRET` (both backends read the same `.env`). In production, node-backend and python-backend **refuse to start** without strong `JWT_SECRET` / `QR_SIGNING_SECRET`.

### Updating After Code Changes

> **Important:** the images **bake the source at build time** (no bind mounts), so `docker compose restart` re-runs the OLD code. **Any source change needs a rebuild**, not a restart.

```bash
# After changing frontend / node-backend / python-backend source (rebuild, not restart):
docker compose build <service> && docker compose up -d <service>
docker compose restart gateway     # after a backend rebuild — drops stale upstream IPs (avoids 502s)
# (you can build several at once, e.g. `docker compose build node-backend frontend`)

# After a TEAMMATE's pull that adds a DB migration (files in db/migrations/):
# you MUST rebuild node-backend — migrate.js auto-applies pending migrations on startup:
docker compose build node-backend && docker compose up -d node-backend
docker compose restart gateway

# Verify a migration ran:
docker compose exec postgres psql -U opd_user -d opd_preconsult -c "\d <table_name>"

# After editing .env — `restart` does NOT pick up .env changes. A container's environment
# is fixed when it is CREATED, and `restart` reuses the existing container. Use `up -d`,
# which recreates whatever changed. Name no service so EVERY service reading .env is
# updated (node-backend, python-backend and postgres all read it — updating only one
# leaves the others authenticating with stale credentials):
docker compose up -d
docker compose restart gateway

# `docker compose restart <svc>` picks up neither source edits NOR .env changes. It is
# only useful for dropping gateway upstream IPs, or forcing a process to restart.
```

> **Note:** `frontend/.dockerignore` keeps a host `node_modules` / `.next` out of the
> build context. Without it, running `npm install` on a Windows or macOS machine
> leaves platform-specific native binaries (`@next/swc-win32-x64-msvc`) that
> `COPY . .` would paste over the Linux ones installed inside the image, and
> `next build` fails in the container. Don't remove it.

## Troubleshooting

> On a self-hosted production stack, add `-f docker-compose.prod.yml` to every `docker compose` command below (e.g. `docker compose -f docker-compose.prod.yml logs node-backend`), and set `DOMAIN` — keeping `DOMAIN=...` in `.env` saves passing it on every command.

### `password authentication failed for user "opd_user"` (every API call 500s)

**Cause: `POSTGRES_PASSWORD` only ever applies on the FIRST start of a database volume.** Postgres reads it while initialising an empty data directory and stores the password inside the DB. On every later start the variable is *ignored*. So if a `pg-data` volume already exists and you then change `POSTGRES_PASSWORD` in `.env` — or run `gen-secrets.js` and paste in fresh secrets — the app's new password no longer matches the one stored in the DB, and node-backend logs:

```
error: password authentication failed for user "opd_user"   (severity: FATAL, code: 28P01)
```

Nothing in the logs points at the volume, and `docker compose up` reports every container healthy — the node-backend healthcheck only checks that the HTTP port answers, not that the DB works.

**Fix — reset the stored password to match `.env`. Non-destructive: no data is lost, and no volume is recreated.**

```bash
# `psql` over the container's local socket does not need the password, so this works
# even while the app cannot authenticate. Use the CURRENT value from .env verbatim.
echo "ALTER USER opd_user WITH PASSWORD '<POSTGRES_PASSWORD from .env>';" \
  | docker compose exec -T postgres psql -U opd_user -d opd_preconsult
# -> ALTER ROLE

# Use `up -d`, NOT `restart`. A container's environment is fixed when it is CREATED:
# `docker compose restart` reuses the existing container and therefore keeps the OLD
# .env values, so it silently does nothing here. `up -d` recreates any container whose
# config changed. Naming no service updates every service that reads .env — miss one
# (e.g. python-backend) and that service alone keeps failing while the rest look fine.
docker compose up -d
docker compose restart gateway   # drop stale upstream IPs from any recreated backend
```

Then confirm it actually recovered (health alone won't tell you):

```bash
# Time-bound the check. `restart` REUSES the container, so its old pre-fix errors stay in
# the log forever — a plain `logs --tail=N | grep` re-reports them and looks like the fix
# failed. --since only shows lines written after the restart:
docker compose logs node-backend --since 60s | grep -i "password authentication failed"   # expect NO output

# And exercise a real DB read end-to-end (a healthcheck pass does not prove the DB works):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/session/scan \
  -H 'Content-Type: application/json' \
  -d "{\"qr_payload\":\"$(printf '{"hospital_id":"demo_hospital_01"}' | base64 -w0)\"}"   # expect 200
```

**Do NOT reach for `docker compose down -v` on a server.** It deletes the `pg-data`, `minio-data` and `caddy-data` volumes — i.e. all patient data, all uploaded documents, and Caddy's TLS certificates/account key (forcing re-issuance and burning [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)). `down -v` is only appropriate on a throwaway local install you intend to reset.

### Browser warns `NET::ERR_CERT_AUTHORITY_INVALID` on `https://localhost`

Expected when running `docker-compose.prod.yml` with `DOMAIN=localhost`: Caddy cannot get a public certificate for `localhost`, so it issues one from its own local CA that your browser doesn't trust. Click **Advanced → Proceed**. With a real `DOMAIN` whose DNS points at the server, Caddy fetches a genuine Let's Encrypt certificate and the warning disappears.

### `502 Bad Gateway` right after rebuilding a backend

nginx cached the old container's IP. `docker compose restart gateway`.

### `scripts/smoke.js` fails against a production stack

It needs the dev-only OTP dry-run code, which production returns `503` for (see Twilio above). It only passes against a `NODE_ENV=development` stack.

## PWA (installable web app)

The frontend ships a web app manifest (`frontend/src/app/manifest.js`, served at
`/manifest.webmanifest`) plus icons in `frontend/public/icons/`. That makes the app
installable to a phone/tablet home screen or a kiosk, launching without browser
chrome (`display: standalone`), with the right icon and status-bar colour.

Most useful for the **doctor dashboard on a phone** and the **waiting-room board**
(`/queue` on a wall display). Patients scan a QR for a single visit, so they will
rarely install — but nothing breaks if they do: `start_url: "/"` drops the QR's
`?h=<hospital_id>` and `parseEntry()` falls back to `NEXT_PUBLIC_HOSPITAL_ID`.

Icons are committed. Regenerate only if the mark or brand colour changes:

```bash
cd frontend && npm run gen:icons
```

> ### ⚠️ There is deliberately NO service worker. Do not add one casually.
>
> A manifest is inert metadata — it cannot intercept requests or cache anything.
> A **service worker** can, and in this app that is a clinical-safety and DPDP
> problem, not a performance win:
>
> - **PHI on disk.** `/doctor`, `/his` and the patient pages return names, phone
>   numbers and diagnoses. A caching SW writes those into Cache Storage on the
>   device, surviving logout, on a possibly shared hospital phone.
> - **Stale clinical data.** Offline-first would show a doctor a cached report or
>   triage level that is no longer current. Decision-support UI must never
>   silently serve stale clinical state.
> - **Stale bundles.** This project's main operational gotcha is already "rebuild,
>   don't restart". A SW caching JS means clinicians keep running old code after a
>   deploy until it updates — the bug you cannot debug remotely.
>
> Note that without a service worker Chrome will **not** show an "Install app"
> prompt (it requires a SW with a fetch handler). iOS *Add to Home Screen* works
> regardless. If a real install prompt is required later, scope the SW to the app
> shell and static assets only, **never `/api/*`**, and add a versioned cache bust
> tied to the build id.

Note: `next.config.js` sets `output: 'standalone'`, which does **not** bundle
`public/`. Both `frontend/Dockerfile` and the root `Dockerfile` copy it explicitly.
Remove those lines and every icon 404s.

## Accessibility & Design Tokens

The UI targets **WCAG 2.1 Level AA**. That is not a nice-to-have here: for a
government-hospital deployment it is reachable through GIGW 3.0 and IS 17802,
which hang off the Rights of Persons with Disabilities Act 2016.

All colour lives in CSS custom properties in `frontend/src/app/globals.css`. Each
token is pinned to a contrast threshold against the surfaces it is actually drawn
on, and several sit within `0.15` of their floor — so an innocent-looking retint
can silently drop a triage badge or a destructive button below AA.

A checked-in script guards this:

```bash
cd frontend
npm run check:contrast     # asserts all 22 token pairs vs WCAG 2.1 AA; exits 1 on failure
npm run verify             # check:contrast, then next build
```

If it fails, darken the foreground or lighten the surface — **do not relax the
threshold in the script.** When you add a semantic colour, add its pair to
`frontend/scripts/check-contrast.mjs`.

Conventions worth knowing before touching the UI:

- **Text scales, pages don't zoom.** Every inline `fontSize` in `doctor/page.jsx`
  and `his/page.jsx` is written `calc(Npx * var(--fs))`. `A11yProvider` drives
  `--fs` (patient flow: `A / A+ / A++`; dashboards: `100–150%`). A new hardcoded
  `fontSize: 13` will silently ignore the text-size control. Page zoom is not an
  option — the doctor shell is `height: 100vh; overflow: hidden` and would clip.
- **Amber is a light swatch.** It pairs with `--amber-on` (dark ink), never white.
  For amber *text* on a light surface use `--amber-text`; on a pale amber chip use
  `--amber-on-tint`. Same idea for `--green` / `--green-on-tint`.
- **Modals go through `components/ui/`.** Use `useConfirm()` for confirmations and
  `<Modal>` (or the `useDialogA11y` hook) for content dialogs. Both supply
  `role="dialog"`, `aria-modal`, a focus trap, Escape, and focus restore. Do not
  hand-roll another `position: fixed; inset: 0` overlay.
- **Never render triage on the public queue board.** `/api/queue/board` is
  unauthenticated and deliberately does not return `triage_level` — see the comment
  in `services/node-backend/src/routes/queue.js`.

## Access URLs

| Service | URL |
|---------|-----|
| Patient app (single hospital QR) | `http://localhost:3000/?h=demo_hospital_01` |
| Doctor app | `http://localhost:3000/doctor` |
| HIS admin | `http://localhost:3000/his` |
| Public "Now Serving" board | `http://localhost:3000/queue?dept=CARD` (no auth, token numbers only) |
| Mock HIS FHIR | `http://localhost/his/dashboard` |
| MinIO console | `http://localhost:9001` (`minioadmin` / your `MINIO_SECRET_KEY`) |

## Demo Credentials

### Doctor Login (`/doctor`)

> **These exist only where `005_doctors.sql` seeded them (see [Setup](#local-docker-compose)). A clean/production install has NO doctors — create the first one in HIS admin.** In production, any active doctor still on PIN `1234` is force-deactivated at startup (`index.js`), so these credentials cannot work there by design.

PIN for all demo doctors: `1234`

| Doctor | Phone | Department |
|--------|-------|-----------|
| Dr. Priya Sharma | 9876500001 | CARD |
| Dr. Anil Reddy | 9876500002 | CARD |
| Dr. Kavitha Menon | 9876500003 | GEN |

### Creating the first doctor (clean install)
Log in at `/his` (admin name + `ADMIN_PASSCODE`), create a department, then add a doctor — or via the API:

```bash
# 1. Admin login -> token   (note the field is admin_name, not name)
curl -s -X POST http://localhost/api/admin/login -H 'Content-Type: application/json' \
  -d '{"admin_name":"Your Name","passcode":"<ADMIN_PASSCODE>"}'

# 2. Create a department (also seeds its base intake questions)
curl -s -X POST http://localhost/api/admin/departments -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" -d '{"code":"CARD","name":"Cardiology"}'

# 3. Create a doctor  (POST /api/doctor — admin-gated; there is no /api/doctor/create)
curl -s -X POST http://localhost/api/doctor -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Dr. Priya Sharma","phone":"9876500001","department":"CARD","pin":"4821"}'
```

### HIS Admin Login (`/his`)
Enter the **admin's name** + the **`ADMIN_PASSCODE`** you set in `.env` (the name is recorded in the audit log; the passcode is a shared credential — per-user admin accounts/SSO is a later decision).

### Patient App — single hospital QR
The kiosk QR is now just the plain app URL `…/?h=<hospital_id>` (no base64). The patient scans it with their phone camera → picks a language → phone + OTP → details → **department picker** (department is chosen in the app, not encoded in the QR).

```bash
# Print the URL / render a printable poster
node scripts/generate-qr.js               # prints the plain URL for demo_hospital_01
# scripts/qr-poster.html                   # open in a browser for a printable poster
```

Quick link: `http://localhost:3000/?h=demo_hospital_01`
(Legacy base64 `?qr=<payload>` and department-scoped QRs still work for backward compatibility.)

The **queue token** is assigned server-side at registration — daily-sequential per department (`CARD-007`, resets at IST midnight, idempotent on refresh), never encoded in the QR. For the hospital-facing roll-out (what to print, board screens, assisted-desk model, token behaviour), see **`deploy/OPERATIONS.md` → "Patient check-in — the QR poster & tokens"**.

## Environment & Secrets

All config lives in `.env` (gitignored; template in `.env.example`). Run `node scripts/gen-secrets.js` to generate every secret below at once.

### Required (auth is on by default)

| Var | What it does | Notes |
|-----|--------------|-------|
| `JWT_SECRET` | Signs & verifies all login tokens (patient / doctor / admin roles). | **Shared by node-backend AND python-backend** (python verifies the same token). Must be strong even in dev. In prod, node **refuses to start** without it. |
| `ADMIN_PASSCODE` | HIS admin dashboard login (`POST /api/admin/login`). | Shared credential, **≥6 chars**. |
| `QR_SIGNING_SECRET` | HMAC-signs prescription QR slips (tamper-proof). | Node **refuses to start in prod** with the weak default (otherwise prescriptions are forgeable). |

### Optional / environment-specific

| Var | What it does |
|-----|--------------|
| `MINIO_KMS_SECRET_KEY` | Encryption-at-rest (B1) for uploaded PHI (documents/audio) via SSE-S3. **Required in production**, blank = off in dev. Format `<name>:<base64 of 32 bytes>` (gen-secrets makes it). **Back it up — losing it makes encrypted objects unreadable.** |
| `OTP_SECRET` | Binds OTP hashes; defaults to `JWT_SECRET` if unset. |
| `OTP_MAX_PER_HOUR` / `OTP_RESEND_SECONDS` | OTP rate limits (per phone). Loosen in dev (e.g. `1000` / `0`); strict defaults (5/hour, 60s) in prod. |
| `CORS_ALLOW_ORIGINS` | Locks python-backend to your domain in prod (comma-separated). `*` for local dev. |
| `NEXT_PUBLIC_HOSPITAL_ID` | Frontend build-time default hospital id when a bare domain QR is scanned (else `demo_hospital_01`). |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | LLM/OCR/transcription providers (all optional; graceful fallback). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` / `TWILIO_WHATSAPP_FROM` | Real SMS OTP + WhatsApp/SMS follow-ups. Without them, OTP runs in **dry-run** (code shown on-screen). |
| `POSTGRES_*` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Datastore credentials — **change before any real deployment**. |

## Authentication & Access Control

- **JWT roles.** Every login token carries a role — `patient` (from QR scan), `doctor` (PIN login), or `admin` (passcode login). Enforced by `requireRole` (`node-backend/src/middleware/auth.js`). `dev_secret` fallback removed — fails closed in prod, random ephemeral key in dev.
- **python-backend is JWT-gated too.** Its sensitive routers (`/api/ocr`, `/api/triage`, `/api/report`, `/api/scribe`, `/api/transcribe`) verify the **same** login token (`python-backend/src/auth.py`, HS256, shared `JWT_SECRET`). Media `<src>` GETs (`/api/audio/clip/{id}`, `/api/ocr/documents/image/{id}`) and `/api/transcribe/health` stay open per-route.
- **HIS admin login** requires the admin's **name** + `ADMIN_PASSCODE`; every successful admin mutation is written to `audit_log` (who/what).
- **Phone OTP.** Patient entry gates on an SMS OTP (Twilio, dry-run on-screen code without keys) — 6-digit, hashed, expiring, attempt-capped, rate-limited.
- **Prescription QR** is HMAC-signed with `QR_SIGNING_SECRET` and verified at `/api/prescription/verify-qr`.
- **Encryption & audit (DPDP).** Uploaded PHI encrypted at rest in MinIO (SSE-S3) when `MINIO_KMS_SECRET_KEY` is set; viewing a patient report logs a `patient_viewed` audit row. Postgres relies on host/volume disk encryption in prod.
- **Still open (release blockers):** single shared admin passcode (no per-user SSO), no per-hospital tenancy, patient-data retention/deletion (B2) TODO.

## Testing Each Feature

### 1. Patient Intake (single QR + OTP)
1. Open `http://localhost:3000/?h=demo_hospital_01`
2. Pick a language → enter phone → **enter the OTP** (shown on-screen in dev/dry-run) → enter details → **pick a department** (+ optional preferred doctor) → Consent → Upload documents → Answer questionnaire → Enter vitals
3. Verify: a per-department token (e.g. `CARD-007`) is issued, triage badge appears, report is generated, session shows in the doctor queue and on the public board (`/queue?dept=CARD`)

### 2. WhatsApp Intake
1. Configure Twilio sandbox: set webhook URL to `https://<your-domain>/api/whatsapp/webhook`
2. Send "Hi" to the Twilio sandbox WhatsApp number
3. Verify: bot asks for department, name, age, gender, then runs through questionnaire
4. Check HIS dashboard — session should appear with `input_mode: whatsapp` answers

### 3. Triage & Nursing Alerts
1. Open `http://localhost:3000/his` — sessions tab is the default
2. In another tab, complete a patient flow answering "Yes" to chest pain + radiation
3. Verify: session shows RED triage badge, SSE alert fires to connected HIS browsers
4. To test SSE directly: `curl -N http://localhost/api/alerts/stream`

### 4. Document OCR + Abnormal Highlighting
1. Upload a lab report image during patient flow
2. Verify response includes `is_abnormal: true/false` and `reference_range` for each extracted lab value
3. Example: HbA1c of 7.2 should return `is_abnormal: true, reference_range: "4.0-5.6"`

### 5. Clinical Protocols
1. Go to HIS → Protocols tab → select department → create a protocol:
   - ID: `proto_chest_pain`, Name: "Chest Pain Protocol"
   - Trigger condition: `q_chest_pain` = `yes`
   - Required vitals: `BP, SpO2, Heart Rate`
   - Required tests: `ECG, Troponin, Lipid Profile`
2. Start a patient session, answer "Yes" to chest pain
3. On the vitals page, verify the yellow "Protocol Required" banner appears

### 6. Prescription Writing
1. Login as doctor → select a completed patient → click "Prescribe" tab
2. Add drugs (autocomplete from 60+ drug list), set dose/frequency/duration
3. Click "Check Interactions" — verify warnings appear for known pairs (e.g., Warfarin + Aspirin)
4. Save → verify QR payload is generated
5. Test QR verification: `POST /api/prescription/verify-qr` with the payload

### 7. Drug Interaction Checking
```bash
# Single drug check
curl -X POST http://localhost/api/prescription/check-interactions \
  -H "Content-Type: application/json" \
  -d '{"drug_name":"warfarin","other_drugs":["aspirin","metoprolol"],"patient_allergies":["sulfa"]}'

# Bulk check
curl -X POST http://localhost/api/prescription/check-bulk \
  -H "Content-Type: application/json" \
  -d '{"drugs":["metoprolol","verapamil","warfarin"],"patient_allergies":[]}'
# Expected: BLOCK on metoprolol+verapamil (beta-blocker + non-DHP CCB)
```

### 8. Ambient Scribe
1. Login as doctor → select a patient → click "Scribe" tab
2. Click "Start Recording" → speak a simulated consultation → click "Stop Recording"
3. Verify transcript appears (requires `OPENAI_API_KEY`)
4. Click "Extract SOAP Notes" → verify structured SOAP output
5. Without API key: transcript shows placeholder message, fallback SOAP generated

### 9. Follow-ups
```bash
# Schedule a follow-up manually
curl -X POST http://localhost/api/followup \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<uuid>","patient_phone":"9876543210","message":"How are you feeling? Reply BETTER or WORSE.","send_at":"2026-04-20T10:00:00Z"}'

# Check worker logs
docker compose logs -f node-backend | grep followup-worker
```

### 10. Analytics
1. Go to HIS → Analytics tab
2. Select time period (6h / 12h / 24h / 48h / 7d)
3. Verify: summary cards, department table, doctor table, state distribution
4. API: `GET /api/analytics/summary?hours=24`

## API Reference

### Node Backend (`:4001`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/session/scan` | POST | QR scan → create session |
| `/api/session/register` | POST | Patient registration |
| `/api/session/consent` | POST | DPDP consent |
| `/api/q/next/:session_id` | GET | Next questionnaire question |
| `/api/q/answer` | POST | Submit answer |
| `/api/vitals/:session_id` | POST/GET | Submit/get vitals |
| `/api/doctor/login` | POST | PIN auth |
| `/api/doctor/queue` | GET | Doctor's patient queue |
| `/api/doctor/assign/:id` | POST | Self-assign session |
| `/api/protocol` | GET/POST | List/create protocols |
| `/api/protocol/evaluate/:id` | GET | Evaluate protocols for session |
| `/api/prescription` | POST | Create prescription + QR |
| `/api/prescription/session/:id` | GET | Get prescriptions for session |
| `/api/prescription/verify-qr` | POST | Verify QR prescription |
| `/api/prescription/allergies/:phone` | GET | Get patient allergies |
| `/api/prescription/allergies` | POST | Add allergy |
| `/api/whatsapp/webhook` | POST | Twilio WhatsApp webhook |
| `/api/alerts/stream` | GET | SSE stream for triage alerts |
| `/api/followup` | GET/POST | List/schedule follow-ups |
| `/api/followup/:id/respond` | POST | Record patient response |
| `/api/analytics/summary` | GET | OPD analytics |
| `/api/admin/departments` | GET/POST/DELETE | Department CRUD |
| `/api/admin/questions` | GET/POST/PUT/DELETE | Question CRUD |

### Python Backend (`:4002`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/llm/interview` | POST | LLM-powered follow-up questions |
| `/api/triage/evaluate` | POST | Triage evaluation + Redis alert |
| `/api/report/generate` | POST | Generate report + FHIR bundle |
| `/api/report/:session_id` | GET | Get stored report |
| `/api/ocr/process` | POST | OCR document + abnormal flagging |
| `/api/prescription/check-interactions` | POST | Single drug interaction check |
| `/api/prescription/check-bulk` | POST | Bulk interaction check |
| `/api/scribe/transcribe` | POST | Audio → text (Whisper) |
| `/api/scribe/extract-soap` | POST | Transcript → SOAP notes |
| `/api/scribe/soap/:session_id` | GET | Get stored SOAP notes |

## Production Extensibility

The system is designed as a POC with clear extension points for production:

### Indic language: Bhashini (DONE) — server-side ASR / NMT / TTS
- **Bhashini** (bhashini.gov.in) is integrated for patient intake: server-side **speech-to-text** (patient answers in Hindi/Telugu, transcript kept in the spoken language), **on-demand translation to English** (NMT), and **read-aloud (TTS)** for low-literacy/elderly patients — see `python-backend/src/bhashini/` and `routers/transcribe.py` / `routers/tts.py`.
- The ambient scribe still uses OpenAI Whisper for the doctor-consultation recording; SOAP extraction via LLM is unchanged. Swapping the scribe's ASR to Bhashini is the same drop-in pattern.

### Drug Interactions: Static → DrugBank/Indian Pharmacopoeia
- Current: static JSON matrix of ~50 critical interactions in `drug_interactions.py`
- Production: integrate with DrugBank API, Indian Pharmacopoeia Commission database, or CDSCO drug registry
- The `check_interactions()` / `check_allergies()` interface stays the same

### Prescription QR: Signed JSON → ABDM e-Prescription
- Current: HMAC-signed JSON payload for internal hospital use
- Production: implement ABDM (Ayushman Bharat Digital Mission) e-prescription format
- Replace QR generation in `prescription.js` with ABDM-compliant encoding

### Follow-up Worker: setInterval → Bull/BullMQ
- Current: simple `setInterval` loop in Node process
- Production: Bull job queue on Redis for reliability, retries, dead-letter queues
- Redis is already in the stack; upgrade is a drop-in replacement

### WhatsApp: Twilio Sandbox → Business API
- Current: Twilio sandbox for development
- Production: Twilio WhatsApp Business API (requires Meta Business verification)
- Or integrate with WhatsApp Cloud API directly

### ICD-10: Static Map → FHIR Terminology Server
- Current: 22 common conditions statically mapped in `report.py`
- Production: HAPI FHIR terminology server or WHO ICD API for comprehensive coding
- LLM fallback already handles free-text → ICD-10 mapping

### Authentication: hardened (DONE) → SSO/ABDM next
- Current: JWT with `patient`/`doctor`/`admin` roles enforced by `requireRole`; **admin passcode login on the HIS** with named-admin audit; doctor SHA-256 PIN; **python-backend endpoints JWT-gated** with the shared secret; prescription QR HMAC-signed; PHI encrypted at rest (MinIO SSE-S3) + report-view audit. Node/python fail closed in prod without strong secrets.
- Next for production: per-user admin accounts / hospital SSO, ABDM Health ID for patients, per-hospital tenancy, retention/deletion (DPDP B2).

### Analytics: Raw SQL → Materialized Views
- Current: on-demand aggregate queries (fine for <1000 sessions/day)
- Production: PostgreSQL materialized views refreshed periodically, or export to BI tool
- Redis caching of analytics results (5-min TTL) using the existing Redis instance

### Multi-tenancy
- Current: single hospital
- Production: add `hospital_id` scoping to all queries, tenant isolation at DB level

## Environment Variables

See `.env.example`. Key ones:

| Variable | Purpose | Required |
|----------|---------|----------|
| `DATABASE_URL` | Railway/Heroku-style DB URL | One of DATABASE_URL or POSTGRES_* |
| `POSTGRES_*` | Database connection params | One of DATABASE_URL or POSTGRES_* |
| `REDIS_URL` | Cache + pub/sub for alerts | Optional (SSE alerts need it) |
| `JWT_SECRET` | Auth token signing | Yes |
| `GEMINI_API_KEY` | Google Gemini LLM | Optional (preferred) |
| `ANTHROPIC_API_KEY` | Anthropic Claude LLM | Optional (fallback) |
| `OPENAI_API_KEY` | Whisper transcription | Optional (scribe feature) |
| `TWILIO_ACCOUNT_SID` | Twilio auth | Optional (WhatsApp/SMS) |
| `TWILIO_AUTH_TOKEN` | Twilio auth | Optional |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender number | Optional |
| `TWILIO_SMS_FROM` | SMS sender number | Optional |
| `QR_SIGNING_SECRET` | QR/prescription HMAC signing | Yes |
| `PORT` | Nginx listen port (Railway sets this) | Auto |

**LLM provider selection:** Gemini if `GEMINI_API_KEY` set → Claude if `ANTHROPIC_API_KEY` set → rule-based fallback.

**Graceful degradation:** Every external service is optional. Without API keys: reports use rule-based generation, scribe shows placeholder, WhatsApp is disabled, follow-ups run in dry-run mode logging to console.

## Common Commands

```bash
# View logs
docker compose logs -f node-backend
docker compose logs -f python-backend

# Restart after code change
docker compose restart node-backend python-backend

# Rebuild after dependency change
docker compose build node-backend python-backend && docker compose up -d

# Run specific migration
docker compose exec -T postgres psql -U opd_user -d opd_preconsult < db/migrations/009_scribe.sql

# Connect to database
docker compose exec postgres psql -U opd_user -d opd_preconsult

# Stop everything
docker compose down

# Stop + wipe data volumes
docker compose down -v
```

## Deployment (Railway.app)

Single-container build running nginx + node-backend + python-backend + frontend via supervisord.

### Architecture on Railway

```
Railway Container (single process: supervisord)
├── nginx :$PORT          ← Railway public port, reverse proxy
├── node-backend :4001    ← Express (session, doctor, prescription, followup, analytics)
├── python-backend :4002  ← FastAPI (LLM, triage, OCR, scribe, drug interactions)
└── frontend :3000        ← Next.js standalone
```

All services run in one container. Nginx handles routing. Migrations run automatically on startup via `deploy/start.sh`.

### Initial Setup

1. **Create project**: Push to GitHub → create Railway project from repo
2. **Service settings**:
   - Root Directory: `opd-preconsult`
   - Dockerfile Path: `Dockerfile`
   - Start Command: `/app/deploy/start.sh`
3. **Add PostgreSQL plugin**: Railway sidebar → + New → Database → PostgreSQL
4. **Add Redis plugin** (recommended): + New → Database → Redis
5. **Set environment variables** (Service → Variables → Raw Editor):
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   JWT_SECRET=<random-64-char-string>
   QR_SIGNING_SECRET=<random-string>
   GEMINI_API_KEY=AIzaSy...
   OPENAI_API_KEY=sk-...
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   DEMO_HOSPITAL_ID=demo_hospital_01
   DEMO_HOSPITAL_NAME=Demo City Hospital
   ```
6. **Health check** (Service → Settings → Deploy):
   - Path: `/healthz`
   - Timeout: 300s
7. **Deploy**: Railway auto-deploys on each git push to main

### Railway CLI Commands

```bash
# ── Install & Auth ──
npm i -g @railway/cli
railway login                           # Browser-based OAuth login
railway whoami                          # Verify logged in

# ── Project Linking ──
railway list                            # List all projects
railway link --project pratham-opd      # Link local dir to project
railway service pratham                 # Link to specific service
railway status                          # Show current project/env/service

# ── Deploying ──
railway up --service pratham --detach   # Deploy local dir (bypasses GitHub)
railway redeploy --service pratham      # Redeploy existing image

# ── Logs & Debugging ──
railway logs --service pratham           # Runtime logs (tail)
railway logs --service pratham --build   # Docker build logs
railway logs --service pratham --deployment  # Latest deployment startup logs

# ── Configuration ──
railway variables --service pratham      # List all env vars
railway domain                           # Show public domain URL

# ── Useful Filters ──
# Check migrations ran:
railway logs --service pratham --deployment 2>&1 | grep "migration"

# Verify new features started:
railway logs --service pratham --deployment 2>&1 | grep "followup-worker\|alerts"

# Check build time (8s = cached, 60s+ = full rebuild):
railway logs --service pratham --build 2>&1 | grep "Build time"
```

### Triggering a Redeploy

Railway auto-deploys on git push if connected to GitHub. To force a rebuild:

```bash
# Option 1: Push any change to trigger GitHub auto-deploy
git commit --allow-empty -m "trigger redeploy" && git push

# Option 2: Deploy from local directory (no git push needed)
# Run from the directory containing railway.toml:
railway up --service pratham --detach
```

### Troubleshooting (Railway-specific)

For Docker Compose issues (DB password, TLS warnings, 502s) see [Troubleshooting](#troubleshooting) above.

| Symptom | Cause | Fix |
|---------|-------|-----|
| Old code still running after push | Docker layer cache | Change a line in `Dockerfile` to bust cache, then push |
| `/healthz` returns Next.js HTML | Nginx not routing correctly | Check `deploy/nginx.conf` has `/healthz` location block |
| Only 5 migrations ran | Old Docker image served from cache | Full rebuild needed — modify Dockerfile or requirements.txt |
| `gemini-2.0-flash-exp` 404 error | Model deprecated | Set `GEMINI_MODEL=gemini-2.0-flash` in Railway variables |
| `followup-worker` not in logs | Old build without worker | Confirm `services/node-backend/src/workers/` exists in build |
| SSE alerts not working | `REDIS_URL` not set | Add Redis plugin, set `REDIS_URL=${{Redis.REDIS_URL}}` |
| Scribe returns placeholder | `OPENAI_API_KEY` not set | Add OpenAI API key to Railway variables |
| WhatsApp webhook not receiving | Webhook URL not configured in Twilio | Set webhook to `https://<domain>/api/whatsapp/webhook` in Twilio console |

### Key Files for Railway Deployment

```
opd-preconsult/
├── Dockerfile               # Multi-stage Docker build (shared: Railway + Render)
├── railway.toml             # Build config + health check + watch patterns
├── deploy/
│   ├── start.sh             # Entry point: migrations → nginx config → supervisord
│   ├── nginx.conf           # Reverse proxy (all routes, SSE, scribe upload limits)
│   └── supervisord.conf     # Process manager template (overwritten by start.sh)
└── start.sh                 # Root shim → delegates to deploy/start.sh
```

### Watch Patterns

`railway.toml` defines which file changes trigger a rebuild:
```toml
watchPatterns = ["services/**", "frontend/**", "db/**", "deploy/**", "Dockerfile"]
```

If you change only files outside these patterns (e.g., `README.md`), Railway won't auto-deploy.

### Verifying a Deployment

After deploy, verify all features are live:

```bash
DOMAIN=https://pratham-production.up.railway.app

# Health check
curl -s $DOMAIN/healthz
# Expected: "ok"

# Node backend health
curl -s $DOMAIN/api/session | head -c 100
# Expected: JSON array (sessions list)

# Python backend health
curl -s $DOMAIN/api/triage/evaluate -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"00000000-0000-0000-0000-000000000000"}'
# Expected: 404 (session not found) — confirms Python backend routes work

# Analytics (new feature)
curl -s $DOMAIN/api/analytics/summary?hours=24
# Expected: JSON with total_sessions, by_department, etc.

# Protocol API (new feature)
curl -s $DOMAIN/api/protocol
# Expected: JSON array (empty or with protocols)

# Drug interaction check (new feature)
curl -s $DOMAIN/api/prescription/check-bulk -X POST \
  -H "Content-Type: application/json" \
  -d '{"drugs":["metoprolol","verapamil"],"patient_allergies":[]}'
# Expected: {"has_block": true, "warnings": [...]}
```

## Deployment (Render.com)

Same single-container image as Railway. `render.yaml` is a Render Blueprint that provisions the web service + managed Postgres + managed Key Value (Redis-compatible) in one shot.

### Architecture on Render

```
Render Web Service (Docker, single container: supervisord)
├── nginx :$PORT             ← Render public port, reverse proxy
├── node-backend :4001       ← Express
├── python-backend :4002     ← FastAPI
└── frontend :3000           ← Next.js standalone
        ↓
Render Postgres (managed)    ← DATABASE_URL auto-wired
Render Key Value (managed)   ← REDIS_URL auto-wired
```

### One-Click Blueprint Setup

1. Push this repo to GitHub.
2. Render Dashboard → **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, provisions web + Postgres + Key Value.
4. Open the new web service → **Environment** → fill in the `sync: false` secrets:
   - `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) — LLM reports
   - `OPENAI_API_KEY` — Whisper transcription
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM` — WhatsApp/SMS
   - `MINIO_*` — optional, only if wiring an external S3-compatible bucket (AWS S3 / Cloudflare R2 / Backblaze B2). Render does not host MinIO.
5. Service redeploys automatically after each env edit.

`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `QR_SIGNING_SECRET` are populated automatically — do not touch them.

### Manual Setup (without Blueprint)

If you prefer not to use `render.yaml`:

1. Create a **Postgres** instance (Free, version 16, db name `opd_preconsult`, user `opd_user`).
2. Create a **Key Value** instance (Free).
3. Create a **Web Service** → Build from this repo:
   - Runtime: **Docker**
   - Dockerfile Path: `Dockerfile`
   - Health Check Path: `/healthz`
4. Add env vars per the Blueprint list above. For `DATABASE_URL` and `REDIS_URL` use Render's "Add from database/service" picker.

### Render CLI Commands

```bash
# ── Install & Auth ──
npm i -g render-cli                       # Or use the official binary
render login

# ── Linking ──
render workspaces                         # List workspaces
render services                           # List services in current workspace

# ── Deploying ──
# Render auto-deploys on git push to the branch you connected.
# Force a redeploy from CLI:
render deploys create --service-id srv-xxxxx

# ── Logs ──
render logs --service opd-preconsult --tail
render logs --service opd-preconsult --type build   # build logs

# ── Filters (via grep) ──
render logs --service opd-preconsult --tail | grep "migration"
render logs --service opd-preconsult --tail | grep "followup-worker"
```

If `render-cli` is not installed, every command above is also available in the Render dashboard.

### Free-Tier Caveats

| Caveat | Impact | Mitigation |
|--------|--------|------------|
| Web service spins down after 15 min idle | First request after idle takes ~30-60s | Upgrade to Starter ($7/mo) or keep warm with an external pinger |
| Free Postgres expires 90 days after creation | DB will be deleted | Render emails ahead; back up via `pg_dump`, recreate, restore |
| Free Key Value capped at 25 MB | OK for SSE pub/sub; not for caching large reports | Upgrade to a paid Key Value plan if needed |
| No persistent disk on free web | Local file writes vanish on restart | Use external S3 for document storage (see `MINIO_*` env vars) |
| Build timeout 15 min | First build ~6-8 min (Tesseract OCR) is fine | Subsequent builds use Docker layer cache |

### Triggering a Redeploy

Render auto-deploys on git push. To force a rebuild without code change:

```bash
git commit --allow-empty -m "trigger render redeploy" && git push
# Or via dashboard: Service → Manual Deploy → Deploy latest commit
```

### Verifying a Render Deployment

After deploy, the service URL is `https://opd-preconsult-<random>.onrender.com`:

```bash
DOMAIN=https://opd-preconsult-XXXX.onrender.com

# Health check
curl -s $DOMAIN/healthz                  # Expected: "ok"

# Node backend
curl -s $DOMAIN/api/analytics/summary?hours=24

# Python backend
curl -s $DOMAIN/api/prescription/check-bulk -X POST \
  -H "Content-Type: application/json" \
  -d '{"drugs":["metoprolol","verapamil"],"patient_allergies":[]}'
# Expected: {"has_block": true, "warnings": [...]}
```

### Render Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Build fails at `apt-get install` | Render Free build node ran out of memory | Retry; consider upgrading build instance |
| `/healthz` 502 for first ~60s after deploy | Migrations + service startup | Render's healthcheck timeout is forgiving; wait it out |
| `DATABASE_URL` missing in env | Blueprint wasn't used / picker not connected | Reattach the database in the Environment tab |
| Build skipped on push | Branch not connected, or `autoDeployTrigger` disabled | Check Service → Settings → Auto-Deploy |
| `gemini-2.0-flash-exp` 404 | Model deprecated | Set `GEMINI_MODEL=gemini-2.0-flash` |
| SSE alerts not firing | `REDIS_URL` not wired | Verify Key Value service is `available` in dashboard |
| Document uploads fail | No object storage configured | Wire `MINIO_*` to an external S3-compatible bucket |

### Key Files for Render Deployment

```
<repo-root>/
├── render.yaml              # Blueprint at REPO ROOT (Render auto-detects only here)
└── opd-preconsult/          # rootDir for the web service
    ├── Dockerfile           # Shared with Railway
    └── deploy/
        ├── start.sh         # Migrations → nginx config → supervisord (no changes needed)
        ├── nginx.conf       # Reverse proxy (uses $PORT, set by Render)
        └── supervisord.conf # Template (overwritten by start.sh)
```

> **Monorepo note:** because this app lives at `opd-preconsult/` inside the
> `crtx-sg/pratham` repo, `render.yaml` *must* sit at the repo root and use
> `rootDir: opd-preconsult` to scope the build context. If you set the
> service up manually instead of via Blueprint, set **Root Directory** =
> `opd-preconsult` in the service settings — otherwise Render's builder
> won't find the Dockerfile.

## Out of Scope

- Live ABHA/ABDM API calls (mocked)
- Real hospital LIS/pharmacy inventory integration
- Locally-hosted LLM (uses API)
- IoT Bluetooth vitals devices (manual entry)
- Offline PWA / Service Worker sync
- Full 22-language support (3 languages implemented)
- NABH reporting
- Production DPDP consent ledger
- Multi-tenant isolation
- Speaker diarization in scribe
- Real-time streaming transcription

## License

POC — not for production use without clinical validation.
