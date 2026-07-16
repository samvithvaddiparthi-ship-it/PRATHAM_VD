# Operations runbook (pilot)

Quick reference for running the pilot. Seeds checklist item **D5**.

## Production deploy (self-hosted, TLS)
```bash
# One-time: fill .env with strong secrets
node scripts/gen-secrets.js   # paste output into .env, plus TWILIO_* + DEMO_HOSPITAL_*
# Point DNS for $DOMAIN at this server, then:
DOMAIN=opd.hospital.in docker compose -f docker-compose.prod.yml up -d --build
```
Caddy obtains/renews HTTPS automatically. Only 80/443 are exposed; Postgres/Redis/MinIO/backends stay on the internal network.

## Update after a `git pull`
```bash
docker compose -f docker-compose.prod.yml build node-backend python-backend frontend
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml restart gateway   # drop stale upstream IPs
```
Migrations auto-apply on node-backend startup. **A `db/migrations/*` change means rebuild node-backend (not just restart).**

## Patient check-in — the QR poster & tokens (roll-out)

**One static QR for the whole hospital.** It is *not* per-department and *not* per-patient — it is printed once and put up in the OPD. The QR is just the plain check-in URL `https://<your-domain>/?h=<hospital_id>`; it carries **no** patient data, department, or token. Everything else is decided in the app.

**What the hospital does to go live (one-time):**
1. Deploy the app (see *Production deploy* above) so `https://<your-domain>` is reachable over HTTPS.
2. In **HIS admin** (`/his`), configure the hospital's **departments** (name + icon), **doctors**, **questionnaires**, and (optionally) each department's **report focus**. Do this *before* printing the poster.
3. Print the poster: run `node scripts/generate-qr.js https://<your-domain>` for the URL, or open `scripts/qr-poster.html` in a browser for a printable poster. **Put up the one poster** at the registration desk / waiting area. It never needs reprinting — nothing about it changes per day, per department, or per patient.
4. Put the **public "Now Serving" board** on a wall display: open `https://<your-domain>/queue?dept=CARD` (one screen per department, or rotate). It shows token numbers only — no names, no acuity.
5. Staff the **assisted desk** (see below).

**How the queue token works (important operating fact):**
- The token is **assigned by the server at registration**, not by the QR.
- It is **daily-sequential per department** — e.g. `CARD-007`, `GEN-013` — via an atomic counter, and **auto-resets each day at local (IST) midnight**. Each department has its own independent series.
- It is **idempotent**: a patient tapping Back or refreshing does **not** burn a new number.
- So the same poster produces correct, fresh, per-day tokens forever — staff do nothing to "reset" it.

**Assisted intake (the intended operating model).** The pilot population is elderly / low-literacy / high-volume, so plan for **social workers or kiosk tablets at the desk** helping patients scan and complete the form — this is what Assist mode, read-aloud (TTS), large touch targets, and Hindi/Telugu localization are for. Patients' own phones also work, but do not assume every patient self-serves.

**Patient journey after scanning** (for reference): scan QR → pick language → phone → OTP → details → pick department (+ optional preferred doctor) → token issued → questionnaire during the wait.

**Multi-hospital.** `?h=<hospital_id>` is what lets one deployment serve several hospitals — each site's poster carries its own id. A single-hospital pilot can ignore it; the app defaults the id from `NEXT_PUBLIC_HOSPITAL_ID` set at build time. (Legacy base64 `?qr=` and department-scoped QRs still resolve, for backward compatibility, but are not what you print.)

## Backups (A7)
```bash
# Manual: dumps Postgres + archives MinIO to ./backups/<timestamp>/
COMPOSE_FILE=docker-compose.prod.yml scripts/backup.sh

# Cron (daily 02:00, keep 14 days):
0 2 * * *  cd /opt/opd-preconsult && COMPOSE_FILE=docker-compose.prod.yml ./scripts/backup.sh >> /var/log/opd-backup.log 2>&1
```
Restore (OVERWRITES current data — take a fresh backup first):
```bash
COMPOSE_FILE=docker-compose.prod.yml scripts/restore.sh backups/<timestamp>
```
Store backups off-box too (copy `./backups/` to separate storage). **Test a restore before go-live.**

## Monitoring (A12)
- **Liveness:** point an uptime monitor (UptimeRobot / healthchecks.io) at `https://$DOMAIN/healthz` (expects `200 ok`).
- **Deeper check:** also monitor `GET /api/queue/board?department=CARD` (public; exercises node + Postgres).
- **Container health:** `docker compose -f docker-compose.prod.yml ps` (postgres/redis/minio/node/python report healthy).
- **Error tracking (TODO):** Sentry not wired yet — needs a package + DSN; add when chosen.

## Smoke test after a deploy (A11)
```bash
node scripts/smoke.js https://$DOMAIN    # scan → OTP → register → triage; all PASS expected
```
(Creates a throwaway "Smoke Test" session — fine in staging; avoid on live prod data.)

## Health of the demo secrets
- `node scripts/gen-secrets.js` regenerates all secrets. Rotating `JWT_SECRET` logs everyone out.
- node-backend refuses to boot in production with a weak `JWT_SECRET` or `QR_SIGNING_SECRET`.
- On startup, node checks whether any active doctor still uses the default PIN `1234`.
  In **development** it only warns. In **production it force-expires those accounts**
  (`is_active = false`) so the weak PIN cannot be used.
  **If a doctor suddenly cannot log in after a deploy and sees "Doctor not found", this is
  why** — re-activate them in HIS and set a fresh PIN (or `POST /api/doctor/change-pin`).
  Detection runs through `verifyPin`, so it catches both bcrypt and legacy SHA-256 hashes.

## Encryption at rest (B1)
- **Uploaded PHI (MinIO):** set `MINIO_KMS_SECRET_KEY` in `.env` (format `key-name:base64-of-32-bytes`;
  `node scripts/gen-secrets.js` prints a valid value). `docker-compose.prod.yml` **requires** it; on
  first upload the python-backend turns on the bucket's default **SSE-S3** so new objects (documents,
  audio) are encrypted on disk. Existing objects stay readable. **Back this key up securely and never
  rotate it once objects are encrypted — losing it makes them unreadable.**
- **Database (Postgres):** use **host disk / volume encryption** on the server (LUKS/dm-crypt on Linux,
  or an encrypted cloud volume). This is a one-time OS/infra step done when provisioning the server —
  encrypt the disk that backs the `pg-data` volume *before* loading real data. (In-app column encryption
  is intentionally avoided for the pilot: it needs schema + code changes and complicates queries.)
- **In transit:** Caddy terminates TLS for everything outside the box (A2); infra ports aren't published (A5).

## Access audit — who viewed which patient (B7)
Every clinician who opens a patient's summary is logged. Query it:
```bash
docker compose exec postgres psql -U opd_user -d opd_preconsult -c \
  "SELECT created_at, actor, event_type, session_id FROM audit_log \
   WHERE event_type IN ('patient_viewed','doctor_opened','doctor_dispatched') \
   ORDER BY created_at DESC LIMIT 50;"
```
`patient_viewed` rows come from report views (deduped ~5 min per doctor+patient so the log stays
readable); consultation actions (`doctor_opened/assigned/dispatched/released/reassigned`, `admin_action`)
are also there. Keep this for incident review; export before pruning old rows.

---

## Paper fallback / downtime SOP (D5)
**Goal: the OPD never stops because the app is down.** The queue can always run on paper.

**When to switch to paper**
- Dashboard won't load, patients can't reach the form, or a core service is unhealthy for >5 min.
- Shift lead (not individual staff) makes the call and announces "paper mode" to the floor.

**Immediate steps**
1. Help-desk stops sending patients to the QR; hands out **pre-printed paper token slips**
   (per department, sequential — mirror the `DEPT-NNN` format so numbering doesn't clash).
2. Patients wait as normal; doctors call tokens from the paper slips in arrival order
   (pull obvious emergencies first — same triage judgement, no app needed).
3. Doctors consult and **write prescriptions on paper** as they did before the system.
4. Keep the paper slips — they're the record of who was seen during the outage.

**Restart the system**
```bash
docker compose -f docker-compose.prod.yml ps         # find the unhealthy service
docker compose -f docker-compose.prod.yml restart gateway   # 502s after a rebuild? do this first
docker compose -f docker-compose.prod.yml up -d      # bring anything stopped back up
docker compose -f docker-compose.prod.yml logs --tail=50 <service>   # if still failing
```
If it doesn't recover in ~10 min, **stay on paper** and call the support contact — do not attempt
database/server surgery on a live pilot.

**Coming back online**
- Resume QR intake for **new** patients only. Do **not** back-enter the outage patients mid-rush.
- Optionally, admin adds the paper-seen patients later for records; their paper prescriptions stand.
- Shift lead notes: start time, end time, rough patient count handled on paper, cause if known.

**Keep at every station:** a stack of paper token slips, blank prescription pads, this SOP, and the
support contact card.

---

## Support & feedback (D7)
**Support contact (fill in before go-live):**
```
Primary (on-site):   __________________________  (name / phone)
Technical escalation:__________________________  (name / phone / email)
Hours:               __________________________
```
Put this on a card at the help-desk, the doctors' room, and the HIS station.

**Feedback loop**
- **Doctors** rate every summary **Accurate / Inaccurate** (and edit when wrong) — the main quality
  signal. Review the mix daily (HIS → Analytics / `session_reports.doctor_feedback`).
- **All staff** log issues on a **feedback sheet** at each station (or tell the shift lead). The team
  triages them **daily** during the pilot and files anything actionable.
- Track recurring problems (bad OCR on a report type, a confusing question, OTP failures) and feed
  them into the validation/tuning work before scaling beyond one department.
