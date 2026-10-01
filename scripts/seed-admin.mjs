import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;
const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, ...rest] = item.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }),
);

const email = (args.email ?? "").trim().toLowerCase();
const name = (args.name ?? "").trim();
const password = args.password ?? "";

function validatePassword(value) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value.length < 12) return "Password must be at least 12 characters.";
  if (bytes > 72) return "Password must be at most 72 UTF-8 bytes.";
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    return "Password must include uppercase, lowercase, and a number.";
  }
  return null;
}

if (!email || !email.includes("@")) throw new Error("Use --email=admin@example.com");
if (!name) throw new Error("Use --name=\"Administrator Name\"");
const passwordError = validatePassword(password);
if (passwordError) throw new Error(passwordError);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  const passwordHash = await bcrypt.hash(password, 12);
  await client.query("begin");

  const role = await client.query(
    "select id from role where lower(name) = 'administrator' limit 1",
  );
  if (!role.rowCount) {
    throw new Error("Administrator role missing. Run npm run db:migrate first.");
  }

  const existing = await client.query(
    "select id from app_user where lower(email) = $1 limit 1",
    [email],
  );

  let userId;
  if (existing.rowCount) {
    userId = existing.rows[0].id;
    await client.query(
      `update app_user
       set full_name=$2, password_hash=$3, status='active',
           failed_login_count=0, locked_until=null,
           password_changed_at=now(), updated_at=now()
       where id=$1`,
      [userId, name, passwordHash],
    );
  } else {
    const inserted = await client.query(
      `insert into app_user(email, full_name, password_hash)
       values ($1,$2,$3) returning id`,
      [email, name, passwordHash],
    );
    userId = inserted.rows[0].id;
  }

  await client.query(
    `insert into user_role(user_id, role_id, assigned_by)
     values ($1,$2,$1) on conflict (user_id, role_id) do nothing`,
    [userId, role.rows[0].id],
  );

  await client.query(
    `insert into audit_log(actor_user_id, action, entity_type, entity_id, after_data)
     values ($1::uuid,'bootstrap_admin','user',$1::text,jsonb_build_object('email',$2::text))`,
    [userId, email],
  );

  await client.query("commit");
  console.log(`Administrator ready: ${email}`);
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await pool.end();
}
