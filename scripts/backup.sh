#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STORAGE_DIR="${STORAGE_DIR:-./data/uploads}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --file="$BACKUP_DIR/db-$STAMP.dump" "$DATABASE_URL"

if [ -d "$STORAGE_DIR" ]; then
  tar -czf "$BACKUP_DIR/documents-$STAMP.tar.gz" "$STORAGE_DIR"
fi

find "$BACKUP_DIR" -type f -mtime +30 -delete

printf 'Backup completed: %s\n' "$STAMP"
