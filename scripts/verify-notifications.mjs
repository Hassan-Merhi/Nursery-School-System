import pg from "pg";

const {Pool}=pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL});

function assert(condition,message){
  if(!condition)throw new Error(message);
}

const client=await pool.connect();
let createdInventoryView=false;
try{
  await client.query("begin");

  const permissions=await client.query(
    "select key from permission where key in ('notifications.view','notifications.manage','notifications.run')",
  );
  assert(permissions.rowCount===3,"Step 12 permissions are missing.");

  const rules=await client.query("select rule_key from notification_rule");
  assert(rules.rowCount>=9,"Expected the seeded Step 12 notification rules.");

  const employee=(await client.query(
    `insert into employee(employee_number,first_name,last_name,start_on,status)
     values ('EMP-NOTIFY-VERIFY','Notify','Verifier','2026-01-01','active')
     returning id`,
  )).rows[0];

  const employeeDoc=(await client.query(
    `insert into employee_document_expiry(employee_id,document_name,document_number,expires_on,status)
     values ($1,'First Aid Certificate','FA-VERIFY','2026-10-10','active')
     returning id`,
    [employee.id],
  )).rows[0];

  const schoolYear=(await client.query(
    `insert into school_year(name,starts_on,ends_on,status)
     values ('Notify Verify 2026-2027','2026-09-01','2027-06-30','current')
     returning id`,
  )).rows[0];

  const term=(await client.query(
    `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
     values ($1,2,'Notification Test Term','2026-10-12','2027-03-31')
     returning id`,
    [schoolYear.id],
  )).rows[0];

  const inventorySource=await client.query(
    "select to_regclass('public.inventory_low_stock_notification_source') as name",
  );
  if(!inventorySource.rows[0].name){
    await client.query(
      `create view public.inventory_low_stock_notification_source as
       select
         '11111111-1111-4111-8111-111111111111'::uuid as source_id,
         'Verification Rice'::text as item_name,
         2::numeric as current_quantity,
         5::numeric as reorder_level,
         'kg'::text as unit_name`,
    );
    createdInventoryView=true;
  }

  await client.query("select * from refresh_system_notifications('2026-10-01'::date,null)");

  const docNotification=await client.query(
    `select status from system_notification
     where rule_key='employee_document_expiry' and source_id=$1`,
    [employeeDoc.id],
  );
  assert(docNotification.rows[0]?.status==="open","Employee document expiry notification was not generated.");

  const termNotification=await client.query(
    `select status from system_notification
     where rule_key='term_start' and source_id=$1`,
    [term.id],
  );
  assert(termNotification.rows[0]?.status==="open","Term-start notification was not generated.");

  if(createdInventoryView){
    const inventoryNotification=await client.query(
      `select status from system_notification
       where rule_key='low_food_inventory'
         and source_id='11111111-1111-4111-8111-111111111111'::uuid`,
    );
    assert(inventoryNotification.rows[0]?.status==="open","Low-inventory integration contract did not generate an alert.");
  }

  const before=(await client.query("select count(*)::int as count from system_notification")).rows[0].count;
  await client.query("select * from refresh_system_notifications('2026-10-01'::date,null)");
  const after=(await client.query("select count(*)::int as count from system_notification")).rows[0].count;
  assert(after===before,"Notification refresh is not idempotent.");

  await client.query(
    "update employee_document_expiry set status='renewed' where id=$1",
    [employeeDoc.id],
  );
  await client.query("select * from refresh_system_notifications('2026-10-01'::date,null)");
  const resolved=await client.query(
    "select status from system_notification where rule_key='employee_document_expiry' and source_id=$1",
    [employeeDoc.id],
  );
  assert(resolved.rows[0]?.status==="resolved","Cleared conditions must resolve on the next same-day refresh.");

  const adminPermission=await client.query(
    `select count(*)::int as count
     from role_permission rp join role r on r.id=rp.role_id
     where lower(r.name)='administrator'
       and rp.permission_key in ('notifications.view','notifications.manage','notifications.run')`,
  );
  assert(adminPermission.rows[0].count===3,"Administrator is missing Step 12 permissions.");

  console.log("Step 12 notifications verification passed.");
  await client.query("rollback");
}catch(error){
  await client.query("rollback");
  console.error(error);
  process.exitCode=1;
}finally{
  client.release();
  await pool.end();
}
