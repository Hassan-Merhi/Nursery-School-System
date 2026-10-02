import bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const COOKIE_NAME = "montikids_session";
const DUMMY_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5lIEfi5yP8I7U66vQc6Wen8m0OHM6hC";

export type AuthContext = {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  permissions: string[];
  roles: string[];
};

function sessionHours() {
  const value = Number(process.env.SESSION_TTL_HOURS ?? "8");
  return Number.isFinite(value) && value >= 1 && value <= 168 ? value : 8;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function validatePassword(value: string): string | null {
  if (value.length < 12) return "Password must be at least 12 characters.";
  if (Buffer.byteLength(value, "utf8") > 72) {
    return "Password must be at most 72 UTF-8 bytes.";
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    return "Password must include uppercase, lowercase, and a number.";
  }
  return null;
}

export async function hashPassword(value: string) {
  const error = validatePassword(value);
  if (error) throw new Error(error);
  return bcrypt.hash(value, 12);
}

export async function authenticate(emailInput: string, password: string) {
  const email = emailInput.trim().toLowerCase();

  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      password_hash: string;
      status: string;
      locked_until: Date | null;
    }>(
      `select id, password_hash, status, locked_until
       from app_user where lower(email)=$1 for update`,
      [email],
    );

    const user = result.rows[0];
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      await writeAudit(client, {
        action: "login_failed",
        entityType: "authentication",
        entityId: email || null,
        after: { reason: "invalid_credentials" },
      });
      return { ok: false as const };
    }

    if (
      user.status !== "active" ||
      (user.locked_until && user.locked_until.getTime() > Date.now())
    ) {
      await writeAudit(client, {
        actorUserId: user.id,
        action: "login_failed",
        entityType: "authentication",
        entityId: user.id,
        after: { reason: "unavailable" },
      });
      return { ok: false as const };
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await client.query(
        `update app_user
         set failed_login_count =
               case when failed_login_count + 1 >= 5 then 0
                    else failed_login_count + 1 end,
             locked_until =
               case when failed_login_count + 1 >= 5
                    then now() + interval '15 minutes'
                    else locked_until end,
             updated_at=now()
         where id=$1`,
        [user.id],
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: "login_failed",
        entityType: "authentication",
        entityId: user.id,
        after: { reason: "invalid_credentials" },
      });
      return { ok: false as const };
    }

    await client.query(
      `update app_user
       set failed_login_count=0, locked_until=null, last_login_at=now(), updated_at=now()
       where id=$1`,
      [user.id],
    );
    await writeAudit(client, {
      actorUserId: user.id,
      action: "login_succeeded",
      entityType: "authentication",
      entityId: user.id,
    });
    return { ok: true as const, userId: user.id };
  });
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const ttlHours = sessionHours();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await query(
    `insert into user_session(user_id, token_hash, expires_at)
     values ($1,$2,$3)`,
    [userId, tokenHash, expiresAt],
  );

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function getAuthContext(): Promise<AuthContext | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const result = await query<{
    session_id: string;
    id: string;
    email: string;
    full_name: string;
    permissions: string[];
    roles: string[];
  }>(
    `select
       s.id as session_id,
       u.id,
       u.email,
       u.full_name,
       coalesce((
         select array_agg(distinct rp.permission_key order by rp.permission_key)
         from user_role ur
         join role_permission rp on rp.role_id=ur.role_id
         where ur.user_id=u.id
       ), '{}') as permissions,
       coalesce((
         select array_agg(distinct r.name order by r.name)
         from user_role ur
         join role r on r.id=ur.role_id
         where ur.user_id=u.id
       ), '{}') as roles
     from user_session s
     join app_user u on u.id=s.user_id
     where s.token_hash=$1
       and s.revoked_at is null
       and s.expires_at > now()
       and u.status='active'
     limit 1`,
    [hashToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    userId: row.id,
    email: row.email,
    fullName: row.full_name,
    permissions: row.permissions ?? [],
    roles: row.roles ?? [],
  };
}

export async function requireUser() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  return auth;
}

export async function requirePermission(permission: string) {
  const auth = await requireUser();
  if (!auth.permissions.includes(permission)) redirect("/forbidden");
  return auth;
}

export async function revokeCurrentSession() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (token) {
    await query(
      "update user_session set revoked_at=now() where token_hash=$1 and revoked_at is null",
      [hashToken(token)],
    );
  }
  (await cookies()).delete(COOKIE_NAME);
}

export async function changePassword(
  auth: AuthContext,
  currentPassword: string,
  newPassword: string,
) {
  const validation = validatePassword(newPassword);
  if (validation) return { ok: false as const, message: validation };

  return withTransaction(async (client) => {
    const result = await client.query<{ password_hash: string }>(
      "select password_hash from app_user where id=$1 for update",
      [auth.userId],
    );
    const current = result.rows[0];
    if (!current || !(await bcrypt.compare(currentPassword, current.password_hash))) {
      return { ok: false as const, message: "Current password is incorrect." };
    }

    const nextHash = await bcrypt.hash(newPassword, 12);
    await client.query(
      `update app_user
       set password_hash=$2, password_changed_at=now(), updated_at=now()
       where id=$1`,
      [auth.userId, nextHash],
    );
    await client.query(
      `update user_session set revoked_at=now()
       where user_id=$1 and id<>$2 and revoked_at is null`,
      [auth.userId, auth.sessionId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "password_changed",
      entityType: "user",
      entityId: auth.userId,
    });
    return { ok: true as const };
  });
}
