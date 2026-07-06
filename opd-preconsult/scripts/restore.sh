#!/usr/bin/env bash
#
# A7 — Restore Postgres + MinIO from a backup directory created by backup.sh.
#   ./scripts/restore.sh backups/<timestamp>
#
# WARNING: this OVERWRITES the current database and object storage. Take a fresh
# backup first, and ideally stop the backends while restoring.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DIR="${1:?usage: restore.sh backups/<timestamp>}"
[ -f "$DIR/db.sql.gz" ] || { echo "No db.sql.gz in $DIR"; exit 1; }

env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | head -1; }
PG_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; PG_USER="${PG_USER:-opd_user}"
PG_DB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       PG_DB="${PG_DB:-opd_preconsult}"
COMPOSE="${COMPOSE_FILE:-docker-compose.yml}"
dc() { docker compose -f "$COMPOSE" "$@"; }

echo "[restore] This OVERWRITES the current DB + object storage from $DIR."
echo "[restore] Ctrl-C within 5s to abort..."; sleep 5

echo "[restore] Postgres <- $DIR/db.sql.gz"
gunzip -c "$DIR/db.sql.gz" | dc exec -T postgres psql -q -U "$PG_USER" -d "$PG_DB"

if [ -f "$DIR/minio-data.tar.gz" ]; then
  echo "[restore] MinIO <- $DIR/minio-data.tar.gz"
  MINIO_CID="$(dc ps -q minio)"
  docker run -i --rm --volumes-from "$MINIO_CID" alpine \
    sh -c 'rm -rf /data/* /data/.minio.sys 2>/dev/null; tar -C /data -xzf -' < "$DIR/minio-data.tar.gz"
  dc restart minio
fi

echo "[restore] Done. Restart node-backend/python-backend to reconnect cleanly."
