# PHI Security Gap Analysis — OPD Pre-Consultation System

**Scope:** Protection of Protected Health Information (PHI) across the three services
(`node-backend`, `python-backend`, `frontend`), the datastores (PostgreSQL, MinIO,
Redis), and all outbound integrations (Gemini / Groq / OpenAI / Anthropic / OpenAI
Whisper / Bhashini / Twilio).
**Assessed against:** India DPDP Act 2023 (consent, data minimisation, security
safeguards §8(5), breach notification, erasure/§12 rights) and general medical-app
security practice.
**Method:** Every claim below was verified by reading source, not README/CLAUDE.md.
File paths and line numbers are cited throughout. This is a **read-only audit** — no
code was modified.
**Date:** 2026-07-10. **Reviewed commit:** `097cb0e` (branch `main`).

> **One-line verdict:** The app has a genuinely thoughtful auth/crypto *skeleton*
> (fail-closed JWT/QR secrets, hashed OTPs, SSE-S3 hook, named-admin audit), but it
> is undermined by three deployment-blocking classes of defect: **(A)** a large set
> of PHI-returning API routes that are completely unauthenticated, **(B)** patient
> PHI (document images, names, transcripts, phone numbers) leaving the country to US
> cloud LLMs with zero de-identification, and **(C)** no encryption of PHI columns in
> Postgres and no erasure/retention support. None of the mentor's key concern (item 3)
> is mitigated in code today.

---

## Executive summary

> **Remediation status (2026-07-10).** The **Status** column records the fix. Commit
> hashes on branch `security-remediation`: Batch 1 `c3bd96e` (§5a/§5b), Batch 2
> `e5bb296` (§8a/§8b/§8e), Batch 3 `89a182d` (§5c/§4a/§8c), Batch 4 `a1e106e`
> (§8d/§8f/§7a/§6a), Batch 5 `4549b23` (§6b). `OPEN — DEFERRED` = sequenced technical
> work (Vertex asia-south1 migration for the cloud-LLM flows; §1a column encryption;
> §7b internal TLS). `OPEN — LEGAL/PROCESS` = non-code items. See each section's
> "Remediation (2026-07-10)" note and the rewritten roadmap for detail.

| # | Gap | Severity | Effort | Status |
|---|-----|----------|--------|--------|
| 3a | **Full patient document images (name/phone/UHID printed on them) sent to US cloud vision LLMs for OCR with no masking; cloud is the DEFAULT path (local model off by default).** | **Critical** | L | OPEN — DEFERRED (Vertex asia-south1) |
| 5a | **Unauthenticated node routes leak full patient records** — `GET /api/doctor/all-sessions`, `/api/session/:id`, `/api/session/`, `/api/q/answers/:id`, `/api/vitals/:id`, `/api/prescription/session/:id`, `/api/followup`, `/api/protocol/evaluate/:id` return name/phone/symptoms/vitals to anyone. | **Critical** | M | FIXED (`c3bd96e`) |
| 5b | **Open media routes are ID-addressable** — `GET /api/ocr/documents/image/{doc_id}` and `/api/audio/clip/{clip_id}` serve raw PHI images/audio with no auth; UUIDs are the only protection. | **High** | M | FIXED (`c3bd96e`) |
| 3b | Report-generation LLM call sends patient **name + age + gender + all symptoms + vitals** to cloud text LLM (Gemini/Groq/OpenAI/Anthropic) with no pseudonymisation. | **High** | M | OPEN — DEFERRED (Vertex asia-south1) |
| 3c | Consultation audio sent to **OpenAI Whisper**; transcripts (may contain spoken names) sent to cloud LLM for SOAP + Bhashini Stage-2 correction. | **High** | M | OPEN — DEFERRED (Vertex asia-south1) |
| 1a | **No column/application-level encryption of PHI in Postgres.** Name, phone, age, symptoms, vitals, OCR text, transcripts, SOAP notes, follow-up bodies all plaintext; relies solely on host-disk encryption (which is not enforced anywhere). | **High** | M–L | OPEN — DEFERRED (column encryption) |
| 6b | **No erasure / retention support (DPDP §12 right to erasure).** "Delete patient" is a soft `removed_at` stamp; no hard-delete, no MinIO object deletion, no retention job. | **High** | M | FIXED (`4549b23`) |
| 8a | **Twilio WhatsApp webhook `POST /api/whatsapp/webhook` has no signature validation** — anyone can forge inbound messages, drive registration, and poison sessions. | **High** | S | FIXED (`e5bb296`) |
| 8b | **Doctor login PIN is brute-forceable** — 4-digit PIN, unsalted SHA-256, no rate limit / lockout; demo PIN `1234` seeded. Admin passcode login also unrated. | **High** | M | FIXED (`e5bb296`) |
| 7a | Datastore defaults are weak placeholders (`minioadmin` / `changeme_in_production`, Postgres `changeme_in_production`); dev MinIO runs `secure=False` and **unencrypted** (no KMS in dev). | **Medium** | S | FIXED (`a1e106e`) — prod boot-refusal + CORS; dev MinIO TLS/KMS still §2 |
| 4a | Several exception handlers `print()` raw exceptions; `report.generate` returns `{type}: {str(e)}` to the client (DB error text can leak). | **Medium** | S | FIXED (`89a182d`) |
| 6a | Audit trail covers only `patient_viewed` (report fetch) + `admin_action`; **document-image views, audio playback, prescription creation, QR generation, exports are not audited.** | **Medium** | M | FIXED (`a1e106e`) |
| 8c | **No rate limiting** on OCR/report/LLM endpoints (cost-abuse + data-exfil enumeration) or on the unauth media routes. | **Medium** | M | FIXED (`89a182d`) |
| 8d | Prescription QR is HMAC-signed but has **no replay/expiry/nonce binding** — a valid slip can be re-presented indefinitely; `verify-qr` is unauthenticated and trusts only the signature. | **Medium** | S | FIXED (`a1e106e`) |
| 5c | `require_auth` (python) and node inline checks verify a **valid token but not ownership** — any authenticated patient token can read any other patient's report/OCR/audio by ID. | **Medium** | M | FIXED (`89a182d`) |
| 8e | SSE alert stream `GET /api/alerts/stream` is unauthenticated and broadcasts RED-triage `patient_name` + department to any connected client. | **Medium** | S | FIXED (`e5bb296`) |
| 1b | OTP: codes correctly hashed, but `OTP_SECRET` falls back to `'dev_otp_secret'` when both it and `JWT_SECRET` are unset (dev only). `priorPeople()` returns family members' names/ages/genders on OTP verify. | **Low–Medium** | S | PARTIAL (`a1e106e`) — `priorPeople` masked (§8f); `OTP_SECRET` dev-fallback unchanged (dev-only) |
| 7b | Internal service-to-service traffic (Caddy→gateway→backends, backend→MinIO, backend→Postgres) is plaintext HTTP inside the Docker network; only the browser edge is TLS. | **Low** | M | OPEN — DEFERRED (internal TLS) |

Severity uses: **Critical** = direct unauthorised PHI disclosure or unlawful cross-border
transfer reachable today; **High** = serious weakness likely exploitable or a hard DPDP
requirement unmet; **Medium** = meaningful weakness needing a specific precondition;
**Low** = hardening / defence-in-depth. Effort: **S** ≤ half-day, **M** ~1–3 days,
**L** ~1–2 weeks.

---

## 1. PHI at rest — PostgreSQL

### (a) What the code does today

All patient data is stored in **plaintext columns**. Enumerated from
`db/migrations/001–027`:

| Table | PHI columns | Migration |
|-------|-------------|-----------|
| `sessions` | `patient_name`, `patient_phone`, `patient_age`, `patient_gender`, `patient_id`, `triage_level`, `preferred_doctor_name` | `001_sessions.sql:7–10`, `022`, `025` |
| `session_documents` | `ocr_raw` (full OCR text), `ocr_structured` (JSONB: meds, labs, diagnosis, doctor name, allergies), `storage_key`/`image_key` | `001:21–31`, `010` |
| `session_answers` | `answer_raw`, `answer_structured` (symptom free-text) | `001:33–41` |
| `session_vitals` | `bp_systolic/diastolic`, `weight_kg`, `spo2_pct`, `heart_rate`, `temperature_c` | `001:43–55` |
| `session_reports` | `report_md`, `report_json`, `fhir_bundle`, `scribe_transcript`, `scribe_soap`, `doctor_correction` | `001:57–68`, `009`, `016` |
| `patient_allergies` | `patient_phone`, `allergen`, `reaction_type`, `severity` | `007:1–12` |
| `prescriptions` | `patient_phone`, `qr_payload` (base64 of full patient identity + drugs), `notes` | `007:14–24` |
| `prescription_items` | `drug_name`, `dose`, `frequency`, `instructions` | `007:26–37` |
| `scheduled_followups` | `patient_phone`, `message` (clinical follow-up body), `patient_response` | `008:1–16` |
| `answer_audio` | `object_key`, `transcript` (voice answer text) | `014:10–21` |
| `doctors` | `phone`, `pin_hash` (SHA-256, unsalted — see §8b), `registration_no` | `005`, `021` |
| `audit_log` | `actor`, `payload`, `ip_address`, `session_id` | `004` |

There is **no `pgcrypto`, no column encryption, no application-level envelope
encryption** anywhere in the migrations or `db.py`. Phone is stored plaintext E.164
(`sessions.patient_phone`, `patient_allergies.patient_phone`, etc.). CLAUDE.md states
"Postgres relies on host disk/volume encryption" — **confirmed: that is the only
protection, and nothing in the repo enforces or verifies host-disk encryption** (it is
an operator responsibility referenced in `deploy/OPERATIONS.md`, outside the code).

**OTPs are handled well** (`023_phone_otp.sql:16–25`, `routes/otp.js:30–34`): only a
salted **HMAC-SHA256 of `phone:code`** is stored (`code_hash`), never the plaintext
code; rows expire (5 min) and are attempt-capped. This is the one PHI-adjacent field
that is correctly protected at rest.

### (b) The gap

DPDP §8(5) requires a Data Fiduciary to take "reasonable security safeguards to prevent
personal data breach." For sensitive health data, disk-only encryption means **any read
access to the DB (a leaked `POSTGRES_PASSWORD`, a `pg_dump`, a compromised backup in
`backups/`, a SQL-injection-adjacent path, or a curious operator) yields cleartext PHI
for every patient.** The plaintext `patient_phone` used as the join key across
`patient_allergies`, `prescriptions`, `scheduled_followups`, and `phone_otps` is a
durable, high-value identifier.

### (c) Severity: **High**

### (d) Recommended fix

- **Short term (M):** enable `pgcrypto` and application-level authenticated encryption
  (AES-256-GCM via an app-held KEK, not `pgcrypto`'s symmetric `pgp_sym_encrypt` with a
  DB-resident key) for the highest-value free-text/identifier columns: `patient_phone`,
  `patient_name`, `ocr_raw`, `scribe_transcript`, `report_md`, `scheduled_followups.message`.
  Store a keyed **HMAC blind index** of `patient_phone` for the equality joins so lookups
  keep working without decrypting.
- **Baseline (L):** require full-disk / volume encryption (LUKS or cloud-managed) and
  encrypted, access-controlled backups — and *document + verify* it, since today it is
  merely assumed.
- Ensure `backups/` (gitignored, good) is encrypted at rest and access-logged.

> **Remediation (2026-07-10): OPEN — DEFERRED.** Column/application-level encryption
> of Postgres PHI is intentionally sequenced for later — it is large, migration-heavy,
> and needs a KEK-management + blind-index design decision. Not attempted in this pass.
> Erasure (§6b, `4549b23`) now at least guarantees PHI can be *destroyed* on request,
> and the datastore-credential fail-closed guards (§7a, `a1e106e`) reduce the odds of an
> unauthorised DB read in production.

---

## 2. PHI at rest — object storage (MinIO)

### (a) What the code does today

`services/python-backend/src/storage.py`:

- Client is created with `secure=False` (`storage.py:33`) — **plaintext HTTP to MinIO**
  in every environment.
- Access/secret keys default to `minioadmin` / `changeme_in_production`
  (`storage.py:24–25`).
- `_maybe_enable_encryption()` (`storage.py:50–71`) sets bucket **default SSE-S3 only
  when `MINIO_KMS_SECRET_KEY` is set**. **When it is unset (the dev default, `.env.example:61`
  is blank), the function returns immediately at line 64–65 and objects are written
  unencrypted.** So dev document images and audio are stored in the clear.
- Production compose **forces** the KMS key: `docker-compose.prod.yml:85`
  (`MINIO_KMS_SECRET_KEY: ${MINIO_KMS_SECRET_KEY:?...}`) — good, prod fails to start
  without it, and `gen-secrets.js:20,30` mints a valid key.
- **Bucket is private by default** — there is no `set_bucket_policy` call making it
  public, and the browser never talks to MinIO directly; bytes are streamed back
  through the backend (`get_bytes()` + the media routes). Good.
- **Presigned URLs:** `get_url()` (`storage.py:107–122`) generates presigned GETs with a
  **24-hour default expiry**. Grep shows `get_url` is defined but the image/audio media
  routes actually use `get_bytes()` streaming instead, so the 24h presigned URL is
  latent rather than active — but if wired in, 24h is long for a PHI object URL.

### (b) The gap

1. **Dev stores PHI unencrypted** (no KMS). Any developer laptop / shared dev box holds
   cleartext prescription images and patient voice recordings.
2. **`secure=False` everywhere** — even in prod the backend→MinIO hop is plaintext
   (mitigated by it being inside the Docker network; see §7b).
3. SSE-S3 (server-managed key on the same host) protects against stolen disks but **not**
   against a compromised MinIO instance — the key lives with the data. It satisfies
   "encryption at rest" checkbox but is weaker than SSE-KMS/SSE-C with an external key.
4. If `get_url()` is ever used for a patient-facing link, 24h expiry is excessive.

### (c) Severity: **Medium**

### (d) Recommended fix (S–M)

- Set `MINIO_KMS_SECRET_KEY` in dev too (or accept documented risk and never put real
  PHI in dev). Enable TLS on MinIO (`secure=True`) for any non-loopback deployment.
- Prefer an external KMS (SSE-KMS) over SSE-S3 for real hospital data.
- If presigned URLs are adopted, drop expiry to ≤ 5–15 min and scope per-object.

> **Remediation (2026-07-10): PARTIAL / mostly deferred.** The signed media routes
> (§5b) already use short-lived HMAC URLs (15 min) instead of the latent 24h presigned
> path. Erasure now deletes the backing MinIO objects too (`4549b23`, node
> `utils/minioClient.js`). MinIO TLS (`secure=True`), external SSE-KMS, and enabling
> encryption in dev remain **OPEN — DEFERRED** (infra hardening; dev is a documented
> no-real-PHI environment).

---

## 3. PHI in transit to external cloud services — **MENTOR'S KEY CONCERN**

This is the most serious cluster. **Confirmed: no masking or de-identification is applied
anywhere before data leaves the deployment.** Every path below sends raw PHI.

### (i) Uploaded document images → cloud vision LLMs (OCR)

`routers/ocr.py:381–382` calls `extract_with_vision()` → `complete_with_image()`
(`llm_client.py:85–134`). The **raw uploaded image bytes** (`contents`) are base64-encoded
and sent to the first available provider in this order (`llm_client.py:99–134`):

1. Local on-shore model (`LOCAL_VISION_BASE_URL`) — the DPDP-clean route,
2. **Gemini** (`_gemini_vision_complete`),
3. **Groq Llama-4** (`_groq_vision_complete`),
4. **OpenAI GPT-4o** (`_openai_vision_complete`),
5. **Anthropic Claude** (`_anthropic_vision_complete`).

**The local model is OFF by default** (`LOCAL_VISION_BASE_URL` empty in `.env.example`),
so **the default OCR path is a US cloud provider.** `has_vision()` (`llm_client.py:27–34`)
returns true as soon as any cloud key is present.

> **Can a patient's name/phone/UHID printed on a prescription or lab report reach a cloud
> model? YES — directly and by default.** The whole image is transmitted. A typical Indian
> OPD prescription/lab report has the patient's name, age, phone, UHID/registration number,
> and doctor details printed on it. All of it is in the pixels sent to Gemini/Groq/OpenAI/
> Anthropic. There is no cropping, no region masking, no redaction. Under DPDP this is a
> cross-border transfer of sensitive health data to third-party processors with no BAA-
> equivalent, no consent specificity about *which foreign providers*, and no minimisation.

### (ii) Questionnaire answers + vitals → cloud text LLM (report generation)

`routers/report.py:132–147`: `session_json` is built with
`patient: { name, age, gender, department }` (lines 107–113), **all questionnaire answers**
(`qa`, line 115), **vitals** (line 119), triage level, and all document-derived meds/labs/
allergies, then `json.dumps(session_json)` is passed to `llm_complete()`
(`report.py:147`). The **patient's real name is in the prompt.** (Phone is not in the LLM
prompt — it is only in the locally-built FHIR bundle at `report.py:521` — a small point in
the code's favour, but name+age+gender+full symptom history is still identifiable PHI.)

### (iii) Consultation audio → OpenAI Whisper

`routers/scribe.py:43–53`: when Bhashini is unavailable, the ambient-scribe audio is sent
to **OpenAI Whisper** (`client.audio.transcriptions.create(model="whisper-1", ...)`). This
is the full doctor-patient consultation recording.

### (iv) Transcripts → cloud LLMs (SOAP extraction + Stage-2 correction)

- `routers/scribe.py:90`: the full consultation transcript is sent to the cloud text LLM
  for SOAP note extraction.
- `bhashini/medcorrect.py:429` (`llm_validate`): the patient's spoken transcript is sent to
  a cloud LLM for Stage-2 medical correction when `BHASHINI_STAGE2_LLM` is enabled
  (opt-in). Transcripts can contain the patient's spoken name.

### (v) Bhashini (ASR / NMT)

`bhashini/asr.py:27–28`: audio and text go to **`dhruva-api.bhashini.gov.in`** (Government
of India, MeitY). Better DPDP posture than US clouds (on-shore, government) but still an
**external egress of patient voice + transcript** — record it in the RoPA and consent.
Note `verify=_SSL` (asr.py:137,177,…) uses a custom SSL context with a documented fallback
to httpx defaults; confirm it never disables verification in production.

### (vi) Phone numbers → Twilio

`utils/sms.js:47` and `workers/followup-worker.js:52`: `patient_phone` (E.164) and the SMS/
WhatsApp **message body** (which may include clinical follow-up content) are sent to Twilio
(US processor). Logs mask the number (good — see §4) but the number itself necessarily
leaves to the SMS provider.

### (b) The gap

**No de-identification is applied on any of the six paths.** The mentor's belief ("the
answer is no") is **confirmed**. The local vision model (`LOCAL_VISION_BASE_URL`) is the
only DPDP-clean OCR route, and it is **off by default**, so a hospital that fills in a free
Gemini key — exactly what `.env.example:1–3` invites — silently ships every uploaded
prescription image abroad.

### (c) Severity: **Critical** (3a image OCR), **High** (3b report text, 3c audio/transcripts)

### (d) Recommended mitigations (concrete)

1. **Default to the local model; fail closed for cloud.** Make cloud vision opt-in behind
   an explicit `ALLOW_CLOUD_OCR=true` flag with a startup warning, and prefer local. Ship a
   documented Ollama/Qwen2.5-VL deployment as the recommended path.
2. **Pre-OCR PHI region masking (L):** before sending an image to *any* remote model, run a
   local pass (the existing Tesseract `image_to_data` at `ocr.py:371` already yields word
   bboxes) to detect and black-out the patient-identifier band (name/phone/UHID header) —
   or require the local model for images and only send text to cloud.
3. **Text-level redaction before LLM report calls (M):** strip/replace `patient_name` (and
   any phone/UHID that appears in free-text answers) with a pseudonymous token
   (`PATIENT_<uuid>`) in `session_json` before `llm_complete()` (`report.py:147`). The
   report already renders name/vitals **deterministically in Python** (`_render_*`), so the
   LLM does not need the real name to produce the interpretive sections — send it a
   pseudonym and re-insert the name locally.
4. **Pseudonymous IDs in prompts** generally — the scribe SOAP and medcorrect paths should
   receive tokenised transcripts where feasible.
5. **Provider zero-retention / BAA:** if cloud is used, enable OpenAI zero-data-retention /
   Anthropic no-training terms and record a DPA per provider; store the flag and surface it
   in the consent notice. Gemini free tier and Groq free tier generally do **not** offer
   these — flag them as unsuitable for real PHI.
6. Add all six egress paths to a **Record of Processing / data-flow map** and make the
   patient consent notice name the categories of recipient.

> **Remediation (2026-07-10): OPEN — DEFERRED (Vertex asia-south1).** Not touched in
> this pass by decision — the plan of record replaces the multi-cloud provider logic in
> `llm_client.py` with Vertex AI pinned to `asia-south1` (Mumbai) plus consent-notice
> updates, and that lands with the OCR feature-flag feature, not here. `llm_client.py`
> provider order is deliberately unchanged. The Record of Processing, provider DPA /
> zero-retention contracts, and consent wording remain **OPEN — LEGAL/PROCESS**.

---

## 4. PHI in logs and error paths

### (a) What the code does today

- **Phone numbers are masked** consistently: `maskPhone()` (`utils/phone.js:18–21`) keeps
  only the last 2 digits; used in `sms.js:38,44`, `followup-worker.js:57,60`. Good — the
  follow-up worker explicitly avoids logging the recipient number or body (only mask +
  length).
- The OTP dev code is only exposed when SMS is not configured (`otp.js:113–118`) and never
  in a configured/prod setup. Good.
- Node 500s go through `sendServerError()` (`utils/http.js:3–6`) which logs the real error
  server-side and returns a generic `"Internal server error"`. Good.
- Python's global handler (`main.py:36–41`) logs full detail server-side and returns a
  generic message. Good.

### (b) The gap

1. **`report.generate` leaks error internals to the client:** `report.py:33` returns
   `HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")` — a DB error
   string (which can contain query fragments / column values) reaches the API client. This
   violates CLAUDE.md's own "never return raw DB errors" rule.
2. **`scribe.transcribe` leaks Whisper error text:** `scribe.py:59`
   `detail=f"Transcription failed: {str(e)}"`.
3. **Many `print(...)` statements** in the python services log exception objects to stdout
   (`ocr.py:341,440`; `report.py:31,153`; `scribe.py:39,41,57,101,116`;
   `transcribe.py:46,76,89,108`; `storage.py` throughout; `view_audit.py:74`). These
   generally log `type(e).__name__: e` rather than PHI, but an exception raised while
   processing a transcript/answer *can* include the offending value in its message. CLAUDE.md
   mandates the `logging` module, not `print()`.
4. The WhatsApp handler logs `console.error('[whatsapp] Error:', err)` (`whatsapp.js:26`);
   an error carrying `req.body.Body` (patient message text) could surface.

### (c) Severity: **Medium**

### (d) Recommended fix (S)

- Change `report.py:33` and `scribe.py:59` to return a generic message; log detail
  server-side only.
- Replace `print()` with the `logging` module and scrub exception messages that may embed
  PHI; ensure no handler logs `answer_raw`, `Body`, transcripts, or names.

> **Remediation (2026-07-10): FIXED (`89a182d`).** `report.generate` and
> `scribe.transcribe` no longer return `{type}: {str(e)}` / provider error text — they
> log server-side (`logger.exception`) and return a generic 500. Every `print()` in
> `report.py`, `scribe.py`, `ocr.py`, `transcribe.py`, `storage.py`, `view_audit.py`,
> and `triage.py` was replaced with the `logging` module using `exc_info` instead of
> interpolating the exception, so no exception value is stringified into output.
> (`llm_client.py` was left untouched per the Vertex-migration scoping; a handful of
> `print()` in `bhashini/*`, `llm.py`, `tts.py` remain and are pre-existing, PHI-free
> provider-status logs — noted for a later sweep.)

---

## 5. Access control

### (a) What the code does today

- **JWT is hardened** (`middleware/auth.js`): weak/placeholder secrets rejected
  (`auth.js:7–14`), hard-fail in production (`auth.js:16–23`), ephemeral random key in dev.
  `requireRole()` (`auth.js:60–68`) enforces roles.
- **python-backend is JWT-gated** at the router level in `main.py:52–61` for
  `llm/triage/report/prescription/scribe/drugs/tts`, using a stdlib HS256 verifier
  (`auth.py`) that correctly **rejects `alg:none`/RS256 confusion** (`auth.py:52–53`) and
  uses `hmac.compare_digest` (`auth.py:60`). Good.
- The named-admin audit middleware (`index.js:18–29`) records admin mutations.

### (b) The gaps

**5a — Unauthenticated node routes that return full PHI (Critical).** The route inventory
(from `services/node-backend/src/routes/*.js`) shows these have **no `authMiddleware` and no
inline token check**, yet return patient data:

| Route | Returns | File:line |
|-------|---------|-----------|
| `GET /api/doctor/all-sessions` | **every session**: name, phone, age, gender, triage, state (LIMIT 200) | `doctor.js:549` (confirmed no auth in handler) |
| `GET /api/session/:id` | full session row (name/phone/age/gender) | `session.js:264` |
| `GET /api/session/` | up to 50 full session rows | `session.js:281` |
| `GET /api/q/answers/:session_id` | all symptom answers | `questionnaire.js:234` |
| `GET /api/vitals/:session_id` | vitals | `vitals.js:36` |
| `GET /api/prescription/session/:id` | prescriptions + items | `prescription.js:147` |
| `GET /api/prescription/allergies/:phone` | allergies by phone | `prescription.js:189` |
| `POST /api/prescription/allergies` | **write** allergy for any phone | `prescription.js:202` |
| `GET /api/followup` | follow-ups **joined to patient_name** + phone | `followup.js:8` |
| `POST /api/followup` | **schedule** a message to any phone | `followup.js:30` |
| `GET /api/protocol/evaluate/:session_id` | reads session, evaluates protocol | `protocol.js:111` |
| `POST /api/doctor/reassign/:session_id` | **reassigns** any session (no auth) | `doctor.js:433` |

Because Nginx routes all non-python `/api/*` to node-backend, these are reachable from the
public edge. Session/clip/doc IDs are UUIDv4 (not sequentially enumerable), but IDs leak
constantly — they appear in the doctor UI, the queue flow, prescription QR payloads, and
other responses — so "unguessable ID" is not access control. **`GET /api/doctor/all-sessions`
needs no ID at all: it dumps the whole patient list to any unauthenticated caller.** This
is the single most severe finding for a real deployment.

> Note: many `doctor.js` routes *do* check auth **inline** (e.g. `/queue` at `doctor.js:178`,
> `/consulted` at `516`, `/session/:id` DELETE at `596`) rather than via middleware, which is
> why a naive middleware grep understates coverage — but `all-sessions` and `reassign` have
> **no check at all**, verified by reading the handler bodies.

**5b — Open media routes (High).** By design (`main.py:44–50`), two python routes are left
unauthenticated because they are consumed as `<img src>` / `<audio src>`:

- `GET /api/ocr/documents/image/{doc_id}` (`ocr.py:478–489`) streams the **raw uploaded
  document image** given a doc UUID.
- `GET /api/audio/clip/{clip_id}` (`audio.py:80–88`) streams the **patient voice recording**
  given a clip UUID.

Anyone possessing (or leaking) a doc/clip UUID pulls the underlying PHI with no credential.
This is a deliberate trade-off documented in `audio.py:27–29`, but for PHI it is
under-protected: the id is a bearer capability with no expiry, no auth, no audit.

**5c — No ownership enforcement (Medium).** `require_auth` (`auth.py:73–79`) and the node
inline checks confirm a *valid* token but not that the caller **owns** the session. A patient
token issued for session A can call `GET /api/report/{B}`, `/api/audio/session/{B}`,
`/api/ocr/documents/{B}` for any other patient B. CLAUDE.md acknowledges "per-user role-
gating … is a refinement (currently any valid token)" — confirmed, and it is a horizontal
PHI-access (IDOR) gap, not just a refinement.

**5d — Queue board is PHI-free (verified good).** `GET /api/queue/board` (`queue.js:22–50`)
selects **only `token_label`** for now-serving and waiting — no name, no triage, no phone.
This matches the CLAUDE.md invariant. ✅

**5e — Shared admin passcode.** `POST /api/admin/login` (`admin.js:18`) is a single shared
passcode (`ADMIN_PASSCODE`) with constant-time compare and named-admin labelling, but no
per-user accounts and (see §8b) **no rate limiting**. CLAUDE.md flags this as a known release
blocker — confirmed.

### (c) Severity: **5a Critical, 5b High, 5c Medium, 5e Medium**

### (d) Recommended fix (M)

- Put `authMiddleware` (+ `requireRole('doctor','admin')`) on **all** node routes that read/
  write PHI. Standardise on middleware rather than inline checks so gaps are visible.
- Add an **ownership check**: for patient-role tokens, compare `session_data.session_id`
  against the requested id; for doctor/admin allow department/role scope.
- Replace the open media routes with **short-lived, signed, single-object URLs** (HMAC token
  with ≤5 min expiry embedded in the `src`), or require the JWT via a fetch+blob pattern; and
  audit each media fetch (§6).
- Move to per-user admin accounts / SSO before pilot.

> **Remediation (2026-07-10).**
> - **5a — FIXED (`c3bd96e`).** Every PHI-returning node route now carries
>   `authMiddleware` (+ `requireRole` where clinician-only), replacing the inline checks
>   so a missing gate is visible at the route definition. Two extra unlisted leaks found
>   by auditing all routes were closed too (`/his/dashboard`, `GET /api/doctor/`).
>   Patient-reachable routes are gated by token ownership, not role, so intake is intact.
> - **5b — FIXED (`c3bd96e`).** The two media routes no longer treat the object UUID as a
>   bearer capability: the authenticated list endpoints mint short-lived HMAC-signed URLs
>   (`?exp=&sig=`, 15 min, bound to id+kind), and the media routes verify expiry +
>   constant-time HMAC (`media_urls.py`). `<img>`/`<audio>` keep working via the signed url.
> - **5c — FIXED (`89a182d`).** The patient JWT is bound to its `session_id` at issuance;
>   new `requireSessionOwnership` (node) / `enforce_ownership` (python) let clinicians
>   reach any session but restrict a patient token to its own, applied to every
>   patient-reachable by-id PHI route in both backends.
> - **5e — OPEN — LEGAL/PROCESS.** Per-user admin accounts / SSO is unchanged (named-admin
>   audit only); admin passcode login did gain rate-limiting/lockout under §8b (`e5bb296`).

---

## 6. Audit trail & retention

### (a) What the code does today

- `audit_log` (`004_audit.sql`) captures: `patient_viewed` on report fetch
  (`view_audit.py:45–74`, deduped 5 min, non-blocking), `admin_login` (`admin.js:40`),
  `admin_action` on every successful admin mutation (`index.js:18–29`), and `doctor_login`
  (`doctor.js:39`).

### (b) The gaps

1. **Coverage holes.** No audit row is written for: document-image views
   (`ocr.py:478` — the open route), audio playback (`audio.py:80`), **prescription creation
   or QR generation** (`prescription.js:59`), report generation, SOAP save, follow-up
   scheduling, or any export. A clinician (or an unauthenticated caller via §5) can pull a
   patient's document image or prescription with no trace.
2. **`patient_viewed` only fires on `GET /api/report/{id}`** — the many other PHI reads in
   §5a bypass auditing entirely.
3. **Erasure / retention (DPDP §12 right to erasure) is unimplemented.** CLAUDE.md says
   "Deletion/retention (B2) still TODO" — confirmed. The only "delete" is
   `DELETE /api/doctor/session/:id` (`doctor.js:590`) which sets `removed_at = NOW()` — a
   **soft flag that retains all PHI indefinitely** and does **not** delete the MinIO objects
   (images/audio) or any related rows. There is no retention/TTL job, no hard-delete path, no
   patient-initiated erasure. Under DPDP a Data Principal can demand erasure and the system
   cannot honour it.

### (c) Severity: **Medium** (audit coverage), **High** (missing erasure — hard DPDP requirement)

### (d) Recommended fix (M)

- Emit audit rows on every PHI read/write (documents, audio, prescriptions, exports),
  ideally via a single middleware keyed off route + resolved patient id.
- Implement a **hard-erasure routine** that deletes DB rows across all PHI tables for a
  patient/session **and** the corresponding MinIO objects (`storage_key`/`image_key`/
  `object_key`), plus a configurable **retention job** that purges data past the retention
  window. Keep a tombstone in `audit_log` recording the erasure.

> **Remediation (2026-07-10).**
> - **6a — FIXED (`a1e106e`).** Audit coverage extended (PHI-free, ids only): prescription
>   creation and QR verification (node → `audit_log`), and document-image views + audio
>   playback (python, via a new `view_audit.record_event` reusing `record_view`'s dedup
>   window, so an `<img>`/`<audio>` re-fetched each render logs once per object per window).
> - **6b — FIXED (`4549b23`).** New `utils/erase.js` `eraseSession(id)` HARD-deletes every
>   PHI row for a session across all tables (documents, answers, vitals, reports, audio,
>   prescriptions+items, followups, protocol_sessions, phone_otps, sessions) + deletes the
>   backing MinIO objects (new node `utils/minioClient.js`) + writes a PHI-free tombstone.
>   Phone-keyed `patient_allergies` is removed only when it was the phone's last session.
>   Exposed as admin-only `DELETE /api/admin/erase/:session_id`, and driven by a retention
>   worker (`workers/retention-worker.js`, followup-worker pattern) that erases sessions
>   older than `RETENTION_DAYS` (env, default 0 = disabled).

---

## 7. Secrets & transport

### (a) What the code does today

- **`.env` is gitignored** (`.gitignore:2`) and **not tracked** (verified:
  `git ls-files .env` → not found). `.env.example` holds only placeholders. ✅
- `scripts/gen-secrets.js` mints strong values for JWT/ADMIN/QR/OTP/Postgres/MinIO/KMS. ✅
- **Fail-closed guards** in production: `JWT_SECRET` (`auth.js:16–23`), `DEMO_QR_SECRET`
  (`prescription.js:43–51`), admin passcode ≥6 (`admin.js:20–22`), python `_secret()` rejects
  weak keys with 503 (`auth.py:29–34`). ✅
- Prod compose requires strong `POSTGRES_PASSWORD`, `MINIO_*`, `MINIO_KMS_SECRET_KEY`, and
  `DOMAIN` (`docker-compose.prod.yml` `${VAR:?...}` guards). ✅
- **TLS:** Caddy terminates HTTPS with auto Let's Encrypt at the edge
  (`deploy/Caddyfile`), and only Caddy publishes 80/443 in prod. Dev binds all infra ports to
  `127.0.0.1` only (`docker-compose.yml:22,38,60–61,91,116,136`) — not network-exposed. ✅

### (b) The gaps

1. **Weak default credentials in code/dev (Medium).** `storage.py:24–25` defaults to
   `minioadmin` / `changeme_in_production`; `db.py:15` defaults Postgres password to
   `changeme_in_production`; `.env.example` ships these placeholders. If an operator deploys
   the **base** `docker-compose.yml` (not the `.prod` variant) to a real server, there are no
   `:?` guards on those and it will run on defaults. The prod compose mitigates this only if
   the operator uses it.
2. **Plaintext internal transport (Low).** Browser↔Caddy is TLS, but Caddy→gateway→backends,
   backend→MinIO (`secure=False`), and backend→Postgres are plaintext inside the Docker
   network. Acceptable for a single-host trust boundary, but a lateral-movement attacker on
   the host sees cleartext PHI in transit. Note also `node-backend/index.js:8` uses
   `app.use(cors())` with no origin restriction (python has `CORS_ALLOW_ORIGINS`, defaulting
   to `*`).
3. `OTP_SECRET` falls back to `JWT_SECRET`, then to the literal `'dev_otp_secret'`
   (`otp.js:28`) if both are unset — only reachable in a misconfigured dev, but it means OTP
   hashes could be computed with a known key. Low.

### (c) Severity: **Medium** (defaults), **Low** (internal TLS)

### (d) Recommended fix (S–M)

- Add `${VAR:?}` guards (or remove insecure defaults) so the **base** compose also refuses to
  boot on placeholder DB/MinIO creds; or clearly gate the base compose as dev-only.
- Lock `CORS_ALLOW_ORIGINS` and node CORS to the real origin in production.
- Consider mTLS or an encrypted overlay for service-to-service traffic if the host is shared.

> **Remediation (2026-07-10).**
> - **7a — FIXED (`a1e106e`).** Fail-closed on default datastore credentials in
>   production (mirrors the JWT_SECRET guard): node `models/db.js` refuses to boot on a
>   default/weak `POSTGRES_PASSWORD`; python `main.py` refuses to boot on default
>   `POSTGRES_PASSWORD` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`. CORS no longer defaults
>   to `*` in production — node and python allow only the configured `CORS_ALLOW_ORIGINS`
>   (none set ⇒ same-origin only). `NODE_ENV=production` is now propagated to
>   python-backend in both prod deploy modes so those guards engage. The `OTP_SECRET`
>   dev-fallback (§1b) is untouched (dev-only, low).
> - **7b — OPEN — DEFERRED.** Internal-transport TLS / mTLS for the Docker-network hops is
>   unchanged (single-host trust boundary; sequenced with infra hardening).

---

## 8. Additional findings

**8a — Twilio webhook has no signature validation (High).**
`POST /api/whatsapp/webhook` (`whatsapp.js:11`) trusts `req.body.From` / `req.body.Body`
with **no `X-Twilio-Signature` verification** (grep confirms no `validateRequest` anywhere).
Anyone can POST forged inbound messages to drive registration, create sessions, inject
`patient_name`/answers, and pump arbitrary data into the DB. Fix (S): verify the Twilio
signature using the auth token before processing.

**8b — Brute-forceable doctor PIN & admin passcode (High).**
Doctor login (`doctor.js:13`) checks a **4-digit PIN** hashed with **unsalted SHA-256**
(`hashPin`), with **no rate limiting and no lockout** — the entire 10,000-PIN space is
trivially brute-forced, and unsalted SHA-256 is reversible via rainbow tables. The demo PIN
`1234` is seeded for all doctors (`005_doctors.sql:29–31`); `index.js:148–160` only *warns*.
Admin login (`admin.js:18`) likewise has no rate limit. Fix (M): rate-limit + lockout on
login, migrate PINs to a slow salted KDF (bcrypt/scrypt/argon2), force PIN reset off the demo
value, and ideally raise PIN length or add a second factor.

**8c — No rate limiting on OCR/report/LLM endpoints (Medium).** No `express-rate-limit` or
equivalent anywhere (grep confirms). The cloud-LLM endpoints (`/api/ocr/process`,
`/api/report/generate`, `/api/scribe/*`) can be driven for cost-abuse, and the unauth media/
list routes (§5) can be scraped. Fix (M): add rate limiting at the gateway and per-route.

**8d — Prescription QR replay (Medium).** `signPayload` (`prescription.js:54–56`) HMACs the
payload, and `verify-qr` (`prescription.js:169–186`) checks the signature — but the payload
has **no expiry, no nonce, and no server-side single-use tracking**, and `verify-qr` is
itself unauthenticated. A valid slip can be re-presented indefinitely and verified by anyone.
The QR base64 also embeds full patient identity (name, age, gender, phone) — a PHI-bearing
artifact printed and handed out. Fix (S): include `issued_at` in the signed expiry check,
bind to a server-side `rx_id` status, and consider not embedding phone in the QR.

**8e — Unauthenticated SSE alert stream (Medium).** `GET /api/alerts/stream`
(`alerts.js:9–19`) has no auth; it relays Redis `triage_alerts` which (per `triage.py:126–133`)
include **`patient_name` and department** for RED cases. Any client that connects receives
real-time RED-patient names. Fix (S): require a doctor/nurse JWT on the stream and drop
`patient_name` from the broadcast (send session id; resolve name authenticated).

**8f — `priorPeople()` family disclosure on OTP verify (Low–Medium).** On successful OTP
(`otp.js:171`), the API returns `people` — the **names, ages, and genders of every prior
person** who used that phone number (`otp.js:39–55`). Since a phone often serves a whole
family, anyone who can receive one SMS to that number learns the demographics of everyone who
ever registered under it. Intended as a "who is this?" chooser, but it is a PHI disclosure
gated only by one OTP. Consider showing initials/partial names until identity is chosen.

**8g — SSRF surface (Low).** `HIS_WEBHOOK_URL` (`.env`) is operator-set and not user-
controlled, so classic SSRF is limited; but confirm no user-supplied URL ever reaches a
server-side fetch. No user-controlled fetch was found in this review.

> **Remediation (2026-07-10).**
> - **8a — FIXED (`e5bb296`).** The WhatsApp webhook validates `X-Twilio-Signature` via the
>   Twilio SDK (`validateRequest`) before trusting `From`/`Body`; forged/unsigned → 403.
>   Validation is skipped only when the Twilio creds are unset (dry-run, logged). Added
>   `express.urlencoded` + `trust proxy` for correct form-param + signed-URL reconstruction.
> - **8b — FIXED (`e5bb296`).** Redis-backed lockout on doctor-PIN and admin-passcode login
>   (5 fails / 15 min → 429, `utils/loginLimiter.js`); PIN hashes migrate SHA-256 → bcrypt
>   lazily (migration `028`, `pin_hash_bcrypt`), new/reset PINs are bcrypt-only; production
>   force-expires any doctor still on the demo PIN `1234` at startup and refuses to set it.
> - **8c — FIXED (`89a182d`).** Redis fixed-window rate limits (`ratelimit.py`) on
>   `/api/ocr/process`, `/api/report/generate`, `/api/scribe/*`, and the signed media
>   routes. The OTP request endpoint already had per-phone limiting (unchanged).
> - **8d — FIXED (`a1e106e`).** QR payload is versioned (v2), drops `patient_phone`, and
>   `verify-qr` enforces a configurable expiry against the signed `issued_at`
>   (`QR_EXPIRY_DAYS`, default 30) with a constant-time signature compare; backward
>   compatible with legacy slips.
> - **8e — FIXED (`e5bb296`).** `GET /api/alerts/stream` requires a doctor/admin JWT passed
>   as `?token=` (EventSource can't set headers); `patient_name` was removed from the Redis
>   alert payload (session_id + department + triage only).
> - **8f — FIXED (`a1e106e`).** OTP verify returns only masked initials + last-visit date
>   (no age/gender/full name); the full identity of the one selected person is revealed via
>   session-gated `POST /api/otp/reveal`.
> - **8g — no action needed** (no user-controlled server-side fetch; monitor if one is added).

---

## Prioritised remediation roadmap

> **Status (2026-07-10).** All in-code deployment-blocker and hardening items from the
> original roadmap have been implemented on branch `security-remediation` (Batches 1–5;
> see the executive-summary Status column and per-section remediation notes). The
> **DONE** list below records what shipped; the **REMAINING** list is now only the
> deferred technical work and the non-code (legal/process) items.

### DONE — implemented in this remediation pass

- **Authenticate every PHI route + signed media URLs (§5a, §5b)** — `c3bd96e`.
- **Ownership / IDOR enforcement (§5c)** — `89a182d`.
- **Twilio webhook signature validation (§8a)** — `e5bb296`.
- **Login brute-force: lockout + bcrypt migration + demo-PIN fail-closed (§8b)** — `e5bb296`.
- **SSE alert stream auth + drop patient_name (§8e)** — `e5bb296`.
- **Stop leaking error internals; `print()` → `logging` (§4a)** — `89a182d`.
- **Rate limiting on LLM/OCR/scribe + media routes (§8c)** — `89a182d`.
- **Prescription QR expiry + versioning + drop phone (§8d)** — `a1e106e`.
- **`priorPeople` demographic minimisation (§8f)** — `a1e106e`.
- **Fail-closed on default DB/MinIO creds + lock CORS (§7a)** — `a1e106e`.
- **Extended audit coverage — documents, audio, prescriptions, QR (§6a)** — `a1e106e`.
- **Erasure (hard-delete across DB + MinIO) + retention worker (§6b)** — `4549b23`.

### REMAINING — deferred technical work

1. **Cloud-LLM data flows (§3a/3b/3c): migrate to Vertex AI pinned to `asia-south1`
   (Mumbai) + consent-notice updates.** Lands with the OCR feature-flag feature, not this
   pass; `llm_client.py` provider logic deliberately unchanged. *(L)*
2. **Column/application-level encryption of high-value PHI in Postgres (§1a)** with a
   KEK-management design and blind-index lookups for phone. *(M–L)*
3. **MinIO TLS + external KMS; encryption in dev or ban real PHI in dev (§2);
   internal-transport TLS / mTLS (§7b).** *(S–M)*

### REMAINING — non-code (legal / process)

4. **Provider DPA / zero-retention contracts** for any cloud recipient (§3d.5).
5. **DPDP Record of Processing / data-flow map** enumerating all external egress paths,
   and a consent notice that names recipient categories + cross-border transfers.
6. **Breach-notification procedure.**
7. **Per-user admin accounts / SSO (§5e)** to replace the shared admin passcode.

---

## Appendix — things the code already does well (do not regress)

- Fail-closed `JWT_SECRET` / `DEMO_QR_SECRET` / admin passcode; python rejects
  `alg:none`/RS256 and uses constant-time HMAC compare (`auth.py`, `middleware/auth.js`).
- OTP codes stored only as salted HMAC, expiring + attempt-capped (`023`, `otp.js`).
- Phone numbers masked in all logs; follow-up worker never logs body/recipient
  (`phone.js`, `followup-worker.js`).
- Report pass-through sections (name, vitals, meds, allergies) rendered **deterministically
  in Python, never via the LLM** (`report.py:239–354`) — this both prevents hallucination and
  makes name-pseudonymisation of the LLM prompt (fix #3) straightforward.
- Public queue board is genuinely PHI-free (token labels only) (`queue.js:22–50`).
- Prod compose enforces strong secrets + KMS and only exposes Caddy; dev binds infra to
  loopback.
- Triage is deterministic and monotonic; no LLM writes acuity (`triage.py`).

*End of analysis. All findings verified against source at commit `097cb0e`; no code was
modified in producing this document.*
