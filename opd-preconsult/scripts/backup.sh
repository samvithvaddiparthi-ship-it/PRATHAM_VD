#!/usr/bin/env bash
#
# A7 — Backups. Dumps Postgres and archives the MinIO object store to
# ./backups/<timestamp>/. Run from anywhere; paths resolve to the project root.
#
# Cron example (daily 02:00, keep 14 days), on the deploy host:
#   0 2 * * *  COMPOSE_FILE=docker-compose.prod.yml /opt/opd-preconsult/scripts/backup.sh >> /var/log/opd-backup.log 2>&1
#
# Restore with scripts/restore.sh backups/<timestamp>  (see that script).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Read a var from .env WITHOUT executing it (values may contain spaces).
env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | head -1; }
PG_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; PG_USER="${PG_USER:-opd_user}"
PG_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       PG_DB="${PG_DB:-opd_preconsult}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE="${COMPOSE_FILE:-docker-compose.yml}"     # set to docker-compose.prod.yml in prod
dc() { docker compose -f "$COMPOSE" "$@"; }

TS="$(date +%Y%m%d_%H%M%S)"
OUT="$ROOT/backups/$TS"
mkdir -p "$OUT"

echo "[backup] Postgres -> $OUT/db.sql.gz"
# --clean --if-exists so the dump can be restored over an existing database.
dc exec -T postgres pg_dump --clean --if-exists -U "$PG_USER" "$PG_DB" | gzip > "$OUT/db.sql.gz"

echo "[backup] MinIO data volume -> $OUT/minio-data.tar.gz"
MINIO_CID="$(dc ps -q minio)"
if [ -n "$MINIO_CID" ]; then
  # Stream a tar of MinIO's /data volume to the host via a throwaway alpine that
  # shares MinIO's mounts. Streaming to stdout (like pg_dump above) avoids docker
  # -v path issues and needs no `mc`; the single-quoted sh -c keeps paths intact.
  docker run --rm --volumes-from "$MINIO_CID" alpine \
    sh -c 'tar -C /data -czf - .' > "$OUT/minio-data.tar.gz"
else
  echo "[backup] WARNING: minio container not found — skipping object storage."
fi

echo "[backup] Pruning backups older than $RETENTION_DAYS days"
find "$ROOT/backups" -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] Done: $OUT"
