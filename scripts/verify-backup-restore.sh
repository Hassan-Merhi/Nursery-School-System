#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for the backup/restore drill" >&2
  exit 1
}

DB_USER="$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(decodeURIComponent(u.username))')"
DB_PASS="$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(decodeURIComponent(u.password))')"
DB_NAME="$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(decodeURIComponent(u.pathname.slice(1)))')"

CID="${POSTGRES_CONTAINER_ID:-}"
if [ -z "$CID" ]; then
  CID="$(docker ps --filter ancestor=postgres:17 --format '{{.ID}}' | head -n 1)"
fi
if [ -z "$CID" ]; then
  CID="$(docker ps --format '{{.ID}} {{.Image}}' | awk '$2 ~ /^postgres:17/ {print $1; exit}')"
fi
if [ -z "$CID" ]; then
  echo "PostgreSQL 17 service container not found. Set POSTGRES_CONTAINER_ID to run this drill." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
WORK="/tmp/montikids-restore-$STAMP"
RESTORE_DB="montikids_restore_${STAMP}"
RESTORE_DB="$(printf '%s' "$RESTORE_DB" | tr -c 'A-Za-z0-9_' '_')"

cleanup() {
  docker exec -e PGPASSWORD="$DB_PASS" "$CID"     psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1     -c "drop database if exists \"$RESTORE_DB\" with (force)" >/dev/null 2>&1 || true
  docker exec "$CID" rm -rf "$WORK" /tmp/montikids-backup.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker exec "$CID" sh -c "mkdir -p '$WORK/backups' '$WORK/uploads' && printf 'release-restore-sentinel\n' > '$WORK/uploads/sentinel.txt'"
docker cp scripts/backup.sh "$CID:/tmp/montikids-backup.sh" >/dev/null

docker exec   -e DATABASE_URL="postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"   -e BACKUP_DIR="$WORK/backups"   -e STORAGE_DIR="$WORK/uploads"   "$CID" sh /tmp/montikids-backup.sh

DUMP="$(docker exec "$CID" sh -c "ls -1 '$WORK'/backups/db-*.dump | head -n 1")"
DOCUMENTS="$(docker exec "$CID" sh -c "ls -1 '$WORK'/backups/documents-*.tar.gz | head -n 1")"
[ -n "$DUMP" ] || { echo "Database backup was not created" >&2; exit 1; }
[ -n "$DOCUMENTS" ] || { echo "Document backup was not created" >&2; exit 1; }

docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1   -c "create database \"$RESTORE_DB\"" >/dev/null

docker exec -e PGPASSWORD="$DB_PASS" "$CID"   pg_restore -h 127.0.0.1 -U "$DB_USER" --no-owner --dbname="$RESTORE_DB" "$DUMP"

SOURCE_MIGRATIONS="$(docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -Atc "select count(*) from schema_migration")"
RESTORED_MIGRATIONS="$(docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d "$RESTORE_DB" -Atc "select count(*) from schema_migration")"
[ "$SOURCE_MIGRATIONS" = "$RESTORED_MIGRATIONS" ] || {
  echo "Restore migration count mismatch: source=$SOURCE_MIGRATIONS restored=$RESTORED_MIGRATIONS" >&2
  exit 1
}

SOURCE_USERS="$(docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -Atc "select count(*) from app_user")"
RESTORED_USERS="$(docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d "$RESTORE_DB" -Atc "select count(*) from app_user")"
[ "$SOURCE_USERS" = "$RESTORED_USERS" ] || {
  echo "Restore user count mismatch: source=$SOURCE_USERS restored=$RESTORED_USERS" >&2
  exit 1
}

GATE_FUNCTION="$(docker exec -e PGPASSWORD="$DB_PASS" "$CID"   psql -h 127.0.0.1 -U "$DB_USER" -d "$RESTORE_DB" -Atc "select count(*) from pg_proc where proname='release_reconciliation_gate'")"
[ "$GATE_FUNCTION" -ge 1 ] || {
  echo "Restored database is missing the Release 1 reconciliation gate" >&2
  exit 1
}

docker exec "$CID" tar -tzf "$DOCUMENTS" | grep -q 'sentinel.txt' || {
  echo "Document archive did not contain the restore sentinel" >&2
  exit 1
}

printf 'Backup/restore verification passed: %s migration(s), %s user(s), database and documents restored.\n'   "$RESTORED_MIGRATIONS" "$RESTORED_USERS"
