# Backup strategy

Step 1 treats backups as an operational requirement, not an afterthought.

## What is backed up

- PostgreSQL: daily custom-format `pg_dump`.
- Stored documents: daily archive/snapshot of `STORAGE_DIR`.
- Retention: 30 days by default.
- Off-site copy: required in production. Copy both backup artifacts to a different provider or physical location.
- Encryption: required for production backup storage.
- Restore drills: perform at least quarterly and before major releases.

## Run a backup

```bash
DATABASE_URL=... STORAGE_DIR=./data/uploads ./scripts/backup.sh
```

## Restore PostgreSQL

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" backups/db-YYYYMMDDTHHMMSSZ.dump
```

Restore the matching document archive into the configured `STORAGE_DIR`.

A backup is not considered valid until a restore has been tested.
