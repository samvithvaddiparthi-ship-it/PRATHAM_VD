# Outstanding fixes — pratham-opd-clean

Each file in this directory is **one self-contained task**. You can complete any of
them without reading the others and without asking the user any questions. Every
design decision has already been made and is written down. If something still
seems ambiguous, pick the option the file marks as **Decision:** and proceed.

## Ground rules (apply to every task)

1. **Do not ask the user questions.** Every choice you need has been made below.
2. **Stay inside the "Files you may touch" list** in the task file. Do not
   refactor, reformat, or "tidy" anything else. Do not reorder imports.
3. **Do not touch these areas — they are the mentors' decision, not yours:**
   - patient consent flow (`/api/session/consent`, `consent_given`, `consent_at`)
   - `audit_log` semantics (what gets logged, retention)
   - data retention / deletion policy (`removed_at` soft deletes)
   - encryption-at-rest config (`MINIO_KMS_SECRET_KEY`, `storage._maybe_enable_encryption`)
   - clinical access policy (a `doctor` token may currently read **any**
     department's sessions — this is intentional, leave it)
4. **Shell commands are Windows PowerShell.** No `&&`. Use `;` or separate lines.
   Use `curl.exe` (not `curl`) or `Invoke-RestMethod`.
5. **One task = one commit.** Message: `fix(<area>): <task title>`.
6. **Verify before you claim done.** Each file has a "How to verify" section.
   If a verification step fails, fix it — do not report success.
7. If a code snippet in a task file does not match the file on disk (someone
   already changed it), **stop and report that**, do not guess.

## Environment facts you will need

- Two backends: `services/node-backend` (Express) and `services/python-backend` (FastAPI).
- Requests reach them through `services/gateway/nginx.conf`. If you add a route,
  check whether nginx already proxies its prefix.
- Migrations live in `db/migrations/NNN_name.sql`. They are applied automatically
  on node-backend startup by `services/node-backend/src/migrate.js`, in filename
  order, each inside a transaction, recorded in `schema_migrations`.
  **Every migration must be idempotent and safe to re-run** (`IF NOT EXISTS`, etc).
  The next free number is **027**.
- `JWT_SECRET` is shared by both backends. Node signs with `jsonwebtoken` (HS256);
  Python verifies by hand with `hmac` in `services/python-backend/src/auth.py`
  (stdlib only, by design — **do not add a JWT pip dependency**).
- Auth helpers already exist. Use them, do not write new ones:
  - Node: `middleware/auth.js` → `authMiddleware`, `requireRole(...roles)`
  - Node: `middleware/ownership.js` → `requireSessionAccess(param)`
  - Python: `src/auth.py` → `require_auth`, `require_role(...)`, `assert_session_access(session_id, claims)`

## Roles

| role | how it is obtained | trust level |
|---|---|---|
| `patient` | `POST /api/session/scan` — **public, anyone can mint one** | untrusted |
| `doctor` | `POST /api/doctor/login` (phone + PIN) | clinical staff |
| `admin` | `POST /api/admin/login` (shared `ADMIN_PASSCODE`) | clinical staff |

Because a `patient` token is obtainable by anyone, "has a valid token" is **not**
an authorization decision. Anything patient-specific must additionally check
role or session ownership.

## Baseline verification (run after any change)

```powershell
cd services\node-backend
npm install
Get-ChildItem -Recurse -Filter *.js src | ForEach-Object { node --check $_.FullName }

cd ..\python-backend
python -m compileall -q src
python -m pytest tests\ -q
```

Docker is the normal way to run the app:

```powershell
docker compose up -d --build
docker compose logs -f node-backend python-backend
```

## The tasks

| # | Task | Severity | Effort |
|---|---|---|---|
| [01](01-sql-injection-dynamic-columns.md) | SQL injection via request-body object keys | High | Small |
| [02](02-doctor-pin-hashing-and-rate-limit.md) | Doctor PIN: unsalted SHA-256, no login rate limit | High | Medium |
| [03](03-session-answers-unique-constraint.md) | `ON CONFLICT DO NOTHING` is dead — no unique constraint | High | Small |
| [04](04-media-endpoints-signed-urls.md) | Document images & audio clips served with no auth | High | Medium |
| [05](05-whatsapp-webhook-broken-and-unverified.md) | WhatsApp webhook never parses its body, and is unauthenticated | High | Medium |
| [06](06-followup-worker-phone-double-prefix.md) | Follow-up worker builds `whatsapp:+91+91...` | Medium | Small |
| [07](07-questionnaire-dag-cycle-hang.md) | A cycle in the question DAG hangs the interview forever | Medium | Small |
| [08](08-report-writes-clobber-all-rows.md) | Feedback/SOAP writes overwrite every report row for a session | Medium | Small |
| [09](09-otp-not-scoped-to-session.md) | OTP verify ignores `session_id` | Medium | Small |
| [10](10-python-db-connection-pooling.md) | `db.py` opens a new Postgres connection per query | Medium | Medium |
| [11](11-prescription-qr-verification.md) | QR verify: timing-unsafe compare, never consults the DB | Medium | Small |
| [12](12-postgres-tls-verification.md) | `rejectUnauthorized: false` on the production DB connection | Medium | Small |
| [13](13-sse-connection-leak.md) | SSE clients accumulate forever, write errors unhandled | Low | Small |
| [14](14-cors-lockdown.md) | Python CORS defaults to `*` | Low | Small |
| [15](15-queue-board-stale-now-serving.md) | Waiting-room board shows abandoned locks forever | Low | Small |

## Suggested order

Do **01, 02, 03** first — highest risk-reduction per line changed. **03** is a
one-line migration plus three call-site edits.

**04** and **05** are the largest. **05** also fixes a feature that has never
worked at all.
