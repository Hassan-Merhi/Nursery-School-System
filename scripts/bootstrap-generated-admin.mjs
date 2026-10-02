import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import pg from "pg";

const email="admin@montikids.school";
const name="Montikids Administrator";
if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const password =
  crypto.randomBytes(18).toString("base64url").slice(0,20) + "Aa1";

const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect();

try{
  const passwordHash=await bcrypt.hash(password,12);
  await client.query("begin");

  const role=await client.query(
    "select id from role where lower(name)='administrator' limit 1",
  );
  if(!role.rowCount) throw new Error("Administrator role missing after migrations.");

  const existing=await client.query(
    "select id from app_user where lower(email)=$1 limit 1",
    [email],
  );

  let userId;
  if(existing.rowCount){
    userId=existing.rows[0].id;
    await client.query(
      `update app_user
       set full_name=$2,password_hash=$3,status='active',failed_login_count=0,
           locked_until=null,password_changed_at=now(),updated_at=now()
       where id=$1`,
      [userId,name,passwordHash],
    );
  }else{
    userId=(await client.query(
      "insert into app_user(email,full_name,password_hash) values ($1,$2,$3) returning id",
      [email,name,passwordHash],
    )).rows[0].id;
  }

  await client.query(
    `insert into user_role(user_id,role_id,assigned_by)
     values ($1,$2,$1) on conflict (user_id,role_id) do nothing`,
    [userId,role.rows[0].id],
  );

  await client.query(
    `insert into audit_log(actor_user_id,action,entity_type,entity_id,after_data)
     values ($1::uuid,'bootstrap_admin','user',$1::text,jsonb_build_object('email',$2::text))`,
    [userId,email],
  );

  await client.query("commit");
  console.log("MONTIKIDS_BOOTSTRAP_ADMIN=" + email);
  console.log("MONTIKIDS_BOOTSTRAP_PASSWORD=" + password);
}catch(error){
  await client.query("rollback");
  throw error;
}finally{
  client.release();
  await pool.end();
}
