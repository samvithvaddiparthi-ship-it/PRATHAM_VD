# Architecture & developer guide

Technical reference for developers working on the codebase. For running/deploying the system, see
the [README](../README.md) and [`deploy/OPERATIONS.md`](../deploy/OPERATIONS.md).

## Services
Three application services behind an Nginx gateway, plus three infrastructure containers:

| Service | Port | Responsibility |
|---|---|---|
| `frontend` | 3000 | Next.js 14 App Router — patient flow, doctor dashboard, admin console |
| `node-backend` | 4001 | Express — sessions, auth, questionnaire DAG, queue/tokens, prescriptions, analytics, SSE alerts |
| `python-backend` | 4002 | FastAPI — AI report generation, triage, OCR, drug interactions, ambient scribe |
| `postgres` | 5432 | PostgreSQL 16 — migrated automatically on `node-backend` startup |
| `redis` | 6379 | Pub/sub for real-time nursing (RED-triage) alerts |
| `minio` | 9000/9001 | S3-compatible object storage for uploaded documents & audio |

**Gateway routing:** `/api/llm`, `/api/triage`, `/api/report`, `/api/ocr`, `/api/prescription/check-*`,
`/api/scribe`, `/api/audio`, `/api/transcribe`, `/api/tts`, `/api/drugs` → `python-backend`; all other
`/api/*` → `node-backend`; everything else → `frontend`.

## Database migrations — read before any schema change
Migrations are plain SQL files in `db/migrations/`, numbered sequentially and applied in order on
`node-backend` startup (`src/migrate.js`).

- **Add a new file** `db/migrations/0NN_description.sql` — never edit an already-applied migration.
- **Every statement must be idempotent** (safe to re-run):
  - Tables: `CREATE TABLE IF NOT EXISTS`
  - Columns: wrap in `DO $$ BEGIN ALTER TABLE ... ADD COLUMN ...; EXCEPTION WHEN duplicate_column THEN NULL; END $$`
  - Indexes: `CREATE INDEX IF NOT EXISTS`
- **A migration change means rebuilding `node-backend`** (the SQL is baked into the image), not just
  restarting it:
  ```bash
  docker compose build node-backend && docker compose up -d node-backend
  docker compose restart gateway
  ```
- Verify it ran: `docker compose exec postgres psql -U opd_user -d opd_preconsult -c "\d <table>"`

## Rebuilding after code changes
`frontend`, `node-backend`, and `python-backend` bake their source into the image at build time, so a
plain `docker compose restart` reruns the **old** code. After editing source:
```bash
docker compose build <service> && docker compose up -d <service>
docker compose restart gateway    # drops stale upstream IPs, avoids 502s
```

## Code conventions
**JavaScript (node-backend + frontend)**
- Every Express handler wrapped in try/catch; never let a rejection crash the server.
- Responses: success `res.json({ success: true, data })`; error `res.status(4xx/5xx).json({ success: false, error })`.
- Never return raw DB errors to clients — log server-side, return a generic message.
- Read all config from `process.env`; never hardcode secrets/URLs.

**Python (python-backend)**
- Explicit error handling with `HTTPException` + appropriate status codes.
- Type hints on function signatures.
- All LLM calls go through `llm_client.py` — never call provider SDKs directly from routers.
- Prompts live in `prompts/*.txt`, not inline.

**Both**
- **PHI (names, phone numbers, diagnoses) must never appear in logs.** Phone numbers are masked via
  `utils/phone.js maskPhone`.
- Never commit `.env` — only `.env.example` with placeholders.

## Queue & tokens
A single hospital QR encodes the plain check-in URL `https://<host>/?h=<HOSPITAL_ID>`. The patient
picks a department on-screen after scanning; the token is issued **server-side at registration**, not
from the QR. Tokens are daily, per-department, sequential (`<DEPT>-NNN`, e.g. `OPD-007`) via the
`queue_counters` table (atomic upsert, auto-resets each service day). The public board
(`GET /api/queue/board?department=<CODE>`) orders waiting patients urgent-first (RED → AMBER → GREEN),
then by arrival.

## Triage
Two layers, both **monotonic** (they can raise urgency, never silently lower it):
1. **Per-question safety tripwires** (`node-backend`, from the questionnaire nodes) — a single answer
   can flag RED and show the patient an "approach the counter" screen.
2. **Holistic evaluator** (`python-backend/routers/triage.py`) — combines answers + vitals into an
   overall RED/AMBER/GREEN and publishes a RED nursing alert to Redis. It never downgrades a level a
   tripwire already raised; only a human (doctor) can lower it.

## AI / LLM providers
`python-backend/src/llm_client.py` selects a provider by which API keys are set, with graceful
fallback:
- **Text**: Gemini → Groq → OpenAI → Anthropic → rule-based fallback.
- **Vision/OCR**: on-prem local model (optional, for data residency) → Gemini → Groq → OpenAI →
  Anthropic → Tesseract fallback.

All AI features degrade gracefully with no keys set.

## Auth & access control
- `node-backend` issues a JWT at login/scan (HS256, shared `JWT_SECRET`) carrying a `role`
  (`patient`/`doctor`/`admin`). Mutating admin/doctor/analytics endpoints are role-gated.
- `python-backend` verifies the **same** token (`src/auth.py`, stdlib HMAC — no extra dependency) on
  all sensitive routers. Media served to `<audio>`/`<img>` tags stays open by opaque id (can't send a
  header).
- The admin console requires the `ADMIN_PASSCODE` plus the admin's name; every admin mutation is
  written to `audit_log`. Viewing a patient's report also writes a `patient_viewed` audit row.
- In production, `node-backend` refuses to start with a weak/placeholder `JWT_SECRET` or
  `QR_SIGNING_SECRET`.

## Data at rest
Uploaded documents/audio in MinIO are encrypted (SSE-S3) when `MINIO_KMS_SECRET_KEY` is set (required
by `docker-compose.prod.yml`). Postgres relies on host disk/volume encryption — see the operations
runbook.
