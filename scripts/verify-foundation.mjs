import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query("begin");

  const permissionCount = await client.query("select count(*)::int as count from permission");
  const adminPermissionCount = await client.query(
    `select count(*)::int as count
     from role_permission rp
     join role r on r.id=rp.role_id
     where lower(r.name)='administrator'`,
  );
  assert.equal(
    adminPermissionCount.rows[0].count,
    permissionCount.rows[0].count,
    "Administrator must have every permission",
  );

  const activeAdminCount = await client.query(
    `select count(distinct u.id)::int as count
     from app_user u
     join user_role ur on ur.user_id=u.id
     join role r on r.id=ur.role_id
     where u.status='active' and lower(r.name)='administrator'`,
  );
  assert.ok(activeAdminCount.rows[0].count >= 1, "At least one active administrator must exist");

  const roleName = `CI Limited ${randomUUID()}`;
  const limitedRole = await client.query(
    "insert into role(name,description) values ($1,'CI verification role') returning id",
    [roleName],
  );
  const roleId = limitedRole.rows[0].id;

  await client.query(
    `insert into role_permission(role_id,permission_key)
     values ($1,'dashboard.view'),($1,'school_years.view')`,
    [roleId],
  );

  const limitedUser = await client.query(
    `insert into app_user(email,full_name,password_hash)
     values ($1,'CI Limited User','not-used-in-this-test') returning id`,
    [`ci-limited-${randomUUID()}@example.invalid`],
  );
  const userId = limitedUser.rows[0].id;
  await client.query(
    "insert into user_role(user_id,role_id) values ($1,$2)",
    [userId, roleId],
  );

  const effective = await client.query(
    `select array_agg(distinct rp.permission_key order by rp.permission_key) as permissions
     from user_role ur
     join role_permission rp on rp.role_id=ur.role_id
     where ur.user_id=$1`,
    [userId],
  );
  assert.deepEqual(
    effective.rows[0].permissions,
    ["dashboard.view", "school_years.view"],
    "Limited roles must not gain unrelated permissions",
  );

  const yearId = randomUUID();
  await client.query(
    `insert into school_year(id,name,starts_on,ends_on,status)
     values ($1,'CI-2098-2099','2098-09-01','2099-06-30','planned')`,
    [yearId],
  );
  await client.query(
    `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
     values
       ($1,1,'September–December','2098-09-01','2098-12-31'),
       ($1,2,'January–March','2099-01-01','2099-03-31'),
       ($1,3,'April–June','2099-04-01','2099-06-30')`,
    [yearId],
  );
  const terms = await client.query(
    "select sequence,name from school_term where school_year_id=$1 order by sequence",
    [yearId],
  );
  assert.deepEqual(
    terms.rows.map((row) => [row.sequence, row.name]),
    [
      [1, "September–December"],
      [2, "January–March"],
      [3, "April–June"],
    ],
    "School year must support the required three-term structure",
  );

  const audit = await client.query(
    `insert into audit_log(action,entity_type,entity_id)
     values ('ci_verify','verification','immutable') returning id`,
  );
  await client.query("savepoint audit_immutability");
  let blocked = false;
  try {
    await client.query("update audit_log set action='tampered' where id=$1", [audit.rows[0].id]);
  } catch {
    blocked = true;
    await client.query("rollback to savepoint audit_immutability");
  }
  assert.equal(blocked, true, "Audit records must reject updates");

  await client.query("rollback");
  console.log("Foundation database invariants verified.");
} finally {
  client.release();
  await pool.end();
}
