import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createAccount,migrateScratch,release2Checks } from "./release2-test-support.mjs";
import { runFoodFlow } from "./release2-food-flow.mjs";
import { runInventoryFlow } from "./release2-inventory-flow.mjs";

const {Pool}=pg;
const sourceUrl=process.env.DATABASE_URL;
if(!sourceUrl)throw new Error("DATABASE_URL is required");
const suffix=randomUUID().replaceAll("-","").slice(0,12).toLowerCase();
const scratchName="montikids_release2_"+suffix;
const adminUrl=new URL(sourceUrl); adminUrl.pathname="/postgres";
const scratchUrl=new URL(sourceUrl); scratchUrl.pathname="/"+scratchName;
const admin=new Pool({connectionString:adminUrl.toString()}); let pool;

try{
  await admin.query('create database "'+scratchName+'"');
  pool=new Pool({connectionString:scratchUrl.toString(),max:8});
  const client=await pool.connect();
  try{
    const migration=await migrateScratch(client,suffix);
    console.log(`Release 2 migration test passed across ${migration.migrationCount} migration(s).`);
    const permissions=["food.view","food.manage","food.billing","food.payments","inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust","notifications.view","notifications.manage","notifications.run","analytics.view"];
    const adminPerms=await client.query(`select rp.permission_key from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key=any($1::text[])`,[permissions]);
    assert.equal(adminPerms.rowCount,permissions.length,"Administrator must receive every Release 2 permission");
    const u=(await client.query(`insert into app_user(email,full_name,password_hash) values ($1,'Release 2 Limited User','unused') returning id`,["r2-limited-"+suffix+"@example.invalid"])).rows[0].id;
    const role=(await client.query("insert into role(name,description) values ($1,'Release 2 isolation') returning id",["Release 2 Viewer "+suffix])).rows[0].id;
    await client.query("insert into role_permission(role_id,permission_key) values ($1,'food.view')",[role]); await client.query("insert into user_role(user_id,role_id) values ($1,$2)",[u,role]);
    const effective=(await client.query(`select array_agg(rp.permission_key order by rp.permission_key) p from user_role ur join role_permission rp on rp.role_id=ur.role_id where ur.user_id=$1`,[u])).rows[0].p;
    assert.deepEqual(effective,["food.view"]); console.log("Release 2 permission isolation test passed.");

    const types=await client.query("select id,category from account_type where code=any($1::text[])",[["ASSET","LIABILITY","EQUITY","INCOME","EXPENSE"]]);
    const type=Object.fromEntries(types.rows.map(r=>[r.category,r.id])); assert.equal(Object.keys(type).length,5);
    await client.query(`insert into accounting_period(name,starts_on,ends_on,status) values ($1,'2026-10-01','2026-10-31','open')`,["Release 2 October "+suffix]);
    const journal=(await client.query("insert into journal(code,name) values ($1,'Release 2 Hardening Journal') returning id",["R2-"+suffix])).rows[0].id;
    await client.query("update accounting_configuration set billing_journal_id=$1,operations_journal_id=$1,payroll_journal_id=$1 where id=1",[journal]);
    const bank=await createAccount(client,suffix,"R2-BANK","Release 2 Operating Bank",type.asset);
    const ar=await createAccount(client,suffix,"R2-AR","Release 2 Student Receivables",type.asset);
    const inventoryAsset=await createAccount(client,suffix,"R2-INV","Release 2 Food Inventory",type.asset);
    const salaryAdvance=await createAccount(client,suffix,"R2-ADV","Release 2 Salary Advances",type.asset);
    const deposits=await createAccount(client,suffix,"R2-DEP","Release 2 Parent Credits",type.liability);
    const ap=await createAccount(client,suffix,"R2-AP","Release 2 Accounts Payable",type.liability);
    const salaryPayable=await createAccount(client,suffix,"R2-SALPAY","Release 2 Salary Payable",type.liability);
    const tuitionIncome=await createAccount(client,suffix,"R2-TUITION","Release 2 Tuition Income",type.income);
    const foodIncome=await createAccount(client,suffix,"R2-FOODINC","Release 2 Food Income",type.income);
    const foodExpense=await createAccount(client,suffix,"R2-FOODEXP","Release 2 Food Program Expense",type.expense);
    const payrollExpense=await createAccount(client,suffix,"R2-PAYEXP","Release 2 Payroll Expense",type.expense);
    await client.query(`insert into cash_bank_account(account_id,account_kind,display_name,bank_name) values ($1,'bank','Release 2 Operating Bank','CI Bank')`,[bank]);
    const mappings=[["accounts_receivable",ar],["billing_income",tuitionIncome],["customer_deposits",deposits],["payment_asset",bank],["accounts_payable",ap],["payroll_expense",payrollExpense],["salary_payable",salaryPayable],["salary_advance",salaryAdvance],["food_income",foodIncome],["inventory_asset",inventoryAsset],["food_program_expense",foodExpense]];
    for(const [key,id] of mappings)await client.query(`insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict(role_key) do update set account_id=excluded.account_id`,[key,id]);

    const food=await runFoodFlow({client,pool,suffix,family:migration.legacyFamily,bank,ar,deposits,foodIncome});
    await runInventoryFlow({client,pool,suffix,supplier:migration.legacySupplier,bank,ap,inventoryAsset,foodExpense});

    const foodReport=(await client.query("select sum(total_amount)::numeric(14,2)::text total,sum(balance_amount)::numeric(14,2)::text balance from food_income_report where id=any($1::uuid[])",[[food.bill,food.raceBill]])).rows[0];
    assert.deepEqual(foodReport,{total:"130.00",balance:"0.00"});
    assert.equal((await client.query("select sum(balance_amount)::numeric(14,2)::text b from report_receivables('2026-10-31') where invoice_id=any($1::uuid[])",[[food.bill,food.raceBill]])).rows[0].b,"0.00");
    const month=(await client.query("select * from food_program_month_summary where month_start='2026-10-01' and currency='USD'")).rows[0];
    assert.equal(month.purchased_amount,"80.00"); assert.equal(month.food_income,"130.00"); assert.equal(month.recognized_food_cost,"20.00"); assert.equal(month.rough_food_margin,"110.00");
    const trend=(await client.query("select * from analytics_food_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0];
    assert.equal(trend.purchased_amount,"80.00"); assert.equal(trend.food_revenue,"130.00"); assert.equal(trend.food_cost,"20.00"); assert.equal(trend.contribution,"110.00");
    assert.equal((await client.query("select balance::text b from report_cash_bank_balances('2026-10-31') where account_id=$1",[bank])).rows[0].b,"50.00");

    const gate=await client.query(`select check_name,currency,system_amount::text,ledger_amount::text,difference::text,passed from release2_reconciliation_gate('2026-10-31')`);
    const missing=new Set(release2Checks);
    for(const row of gate.rows){assert.equal(row.passed,true,row.check_name+" must reconcile for "+row.currency); assert.equal(row.difference,"0.00"); missing.delete(row.check_name);}
    assert.equal(missing.size,0,"Every Release 2 release-gate relationship must be checked");
    const byName=Object.fromEntries(gate.rows.map(r=>[r.check_name,r]));
    assert.equal(byName["Student balances = Accounts Receivable"].system_amount,"0.00");
    assert.equal(byName["Family credits = Customer Deposits"].system_amount,"0.00");
    assert.equal(byName["Supplier balances = Accounts Payable"].system_amount,"0.00");
    assert.equal(byName["Bank screens = Bank ledger"].system_amount,"50.00");
    assert.equal(byName["Food income = Food Income ledger"].system_amount,"130.00");
    assert.equal(byName["Inventory valuation = Inventory Asset ledger"].system_amount,"60.00");
    assert.equal(byName["Food cost = Food Program Expense ledger"].system_amount,"20.00");
    assert.equal(byName["Trial Balance debits = Trial Balance credits"].system_amount,byName["Trial Balance debits = Trial Balance credits"].ledger_amount);
    console.table(gate.rows); console.log("Release 2 hardening verification passed.");
  }finally{client.release();}
}finally{
  if(pool)await pool.end();
  try{
    for(let attempt=0;attempt<20;attempt++){
      const active=(await admin.query("select count(*)::int n from pg_stat_activity where datname=$1",[scratchName])).rows[0].n;
      if(active===0)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await admin.query('drop database if exists "'+scratchName+'"');
  }finally{await admin.end();}
}
