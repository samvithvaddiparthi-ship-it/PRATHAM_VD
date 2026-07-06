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
- node-backend refuses to boot in production with a weak `JWT_SECRET` or `DEMO_QR_SECRET`.
- On startup, node warns if any active doctor still uses the default PIN `1234` — reset via HIS or `POST /api/doctor/change-pin`.
