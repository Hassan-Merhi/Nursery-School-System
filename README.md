# Montikids Montessori Preschool & Nursery

Management system for Montikids Montessori Preschool & Nursery.

## Step 1 — Foundation & Security

Implemented:

- School profile and timezone
- School years with automatic fixed terms: September–December, January–March, April–June
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

1. Copy environment variables with `cp .env.example .env`.
2. Start PostgreSQL with `docker compose up -d`.
3. Run `npm install` and `npm run db:migrate`.
4. Create the bootstrap administrator:

```bash
npm run db:seed-admin -- --email=admin@example.com --name="School Administrator" --password="<secure-password>"
```

5. Run `npm run dev` and open `http://localhost:3000`.

## Security rules

- Passwords require at least 12 characters, uppercase, lowercase, and a number.
- bcrypt's 72-byte input limit is enforced instead of silently truncating passwords.
- Five consecutive failed attempts trigger a 15-minute lockout.
- Session tokens are random and only SHA-256 token hashes are stored in PostgreSQL.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- UI visibility is not treated as authorization. Every protected server action re-checks its permission.
- Disabling a user revokes active sessions.
- Changing a password revokes all other sessions.
- The built-in Administrator role is migration-controlled and cannot be weakened in the UI.
- Sensitive mutations are written to `audit_log`.

## Backups

See [docs/BACKUPS.md](docs/BACKUPS.md). Production requires an off-site encrypted copy and periodic restore drills.


## Step 2 — Families, Students & Enrollment

Implemented:

- Families with generated family numbers
- Parents/guardians linked to families, including primary guardian, custody, and pickup flags
- Students with generated student numbers and lifecycle statuses
- Sibling relationships derived from shared family membership
- Family-level or student-specific emergency contacts
- Classes scoped to school years with optional capacity limits
- School-year enrollment plus explicit term enrollment
- Mid-term enrollment using the student's actual start date
- Withdrawal that closes enrollment without deleting the student or prior enrollment data
- Student document upload/download using the existing protected storage layer
- Append-only student history for creation, enrollment, withdrawal, status changes, and documents
- Fine-grained Step 2 permissions, automatically granted to the built-in Administrator role
- CI verification of the Milestone 2 family → parent → two siblings → Term 1 flow

The Step 2 workspace is available at `/students` to authorized users.
