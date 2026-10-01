# Montikids Montessori Preschool & Nursery

Management system for Montikids Montessori Preschool & Nursery.

## Step 1 — Foundation & Security

This branch establishes the system foundation before accounting, fees, rentals, or later operational modules are added.

Implemented:

- School profile and timezone
- School years with automatic fixed terms:
  - September–December
  - January–March
  - April–June
- Multiple users
- Roles and fine-grained permissions
- Database-backed login sessions and logout
- Password policy, login throttling/temporary lockout, and session revocation
- Append-only audit log for privileged changes and authentication events
- Core regional settings: currency, number locale, timezone
- Document numbering prefixes and counters
- Local file/document storage abstraction with database metadata
- PostgreSQL backup script and documented restore strategy

## Stack

- Next.js 16 / React 19 / TypeScript
- PostgreSQL
- `pg` with explicit SQL migrations
- `bcryptjs` for password hashing

## Local setup

1. Copy environment variables:

```bash
cp .env.example .env
```

2. Start PostgreSQL:

```bash
docker compose up -d
```

3. Install dependencies and migrate:

```bash
npm install
npm run db:migrate
```

4. Create or reset the bootstrap administrator:

```bash
npm run db:seed-admin -- \
  --email=admin@example.com \
  --name="School Administrator" \
  --password="ChangeThis123!"
```

5. Start the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Security rules

- Passwords require at least 12 characters, uppercase, lowercase, and a number.
- bcrypt's 72-byte input limit is enforced instead of silently truncating passwords.
- Five consecutive failed attempts trigger a 15-minute lockout.
- Session tokens are random and only SHA-256 token hashes are stored in PostgreSQL.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- UI visibility is not treated as authorization. Every protected server action re-checks the required permission.
- Disabling a user revokes active sessions.
- Changing a password revokes all other sessions.
- The built-in Administrator role is migration-controlled and cannot be weakened in the UI.
- Sensitive mutations are written to `audit_log`.

## Backups

See [docs/BACKUPS.md](docs/BACKUPS.md). Production requires an off-site encrypted copy and periodic restore drills.
