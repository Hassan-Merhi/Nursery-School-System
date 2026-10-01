import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function migrateScratch(client,suffix){
  await client.query(`create table if not exists schema_migration(filename text primary key,applied_at timestamptz not null default now())`);
  const dir=path.resolve("db");
  const migrations=(await readdir(dir)).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  const release2Index=migrations.indexOf("017_food_packages_billing.sql");
  assert.ok(release2Index>=0,"Step 10 migration must exist");
  assert.ok(migrations.includes("021_release2_hardening.sql"),"Step 14 migration must exist");
  for(const filename of migrations.slice(0,release2Index)){
    await client.query(await readFile(path.join(dir,filename),"utf8"));
    await client.query("insert into schema_migration(filename) values ($1)",[filename]);
  }
  const legacyFamily=(await client.query("insert into family(display_name) values ($1) returning id",["Release 2 legacy family "+suffix])).rows[0].id;
  const legacySupplier=(await client.query(`insert into supplier(supplier_number,name,payment_terms_days,status) values ($1,$2,7,'active') returning id`,["R2-LEG-SUP-"+suffix,"Release 2 legacy supplier "+suffix])).rows[0].id;
  for(const filename of migrations.slice(release2Index)){
    await client.query(await readFile(path.join(dir,filename),"utf8"));
    await client.query("insert into schema_migration(filename) values ($1)",[filename]);
  }
  assert.equal((await client.query("select count(*)::int n from family where id=$1",[legacyFamily])).rows[0].n,1,"Release 1 family data must survive Release 2 migrations");
  assert.equal((await client.query("select count(*)::int n from supplier where id=$1",[legacySupplier])).rows[0].n,1,"Release 1 supplier data must survive Release 2 migrations");
  const migrationCount=(await client.query("select count(*)::int n from schema_migration")).rows[0].n;
  assert.equal(migrationCount,migrations.length,"Every migration must be recorded");
  return {legacyFamily,legacySupplier,migrationCount};
}

export async function createAccount(client,suffix,code,name,typeId){
  return (await client.query(`insert into account(code,name,account_type_id,currency,allow_posting) values ($1,$2,$3,'USD',true) returning id`,[code+"-"+suffix,name,typeId])).rows[0].id;
}

export async function balance(client,accountId){
  return (await client.query("select normal_balance::numeric(14,2)::text v from account_balance where account_id=$1",[accountId])).rows[0]?.v??"0.00";
}

export async function makePayment(client,{number,family,student,amount,bank,date}){
  const id=(await client.query(`insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id) values ($1,$2,$3,'payment',$4,'USD',$5,'bank_transfer',$6) returning id`,[number,family,student,amount,date,bank])).rows[0].id;
  await client.query("select accounting_post_payment($1,null)",[id]);
  return id;
}

export async function allocateFood(client,{payment,bill,amount,date}){
  const id=(await client.query(`insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,$3,$4) returning id`,[payment,bill,amount,date])).rows[0].id;
  await client.query("select accounting_post_food_payment_allocation($1,null)",[id]);
  return id;
}

export async function reversePayment(client,payment,date,reason){
  await client.query("select accounting_reverse_payment($1,$2,null,$3)",[payment,date,reason]);
  await client.query("update payment set status='reversed',reversed_at=now(),reversal_reason=$2 where id=$1",[payment,reason]);
}

export const release2Checks=[
  "Student balances = Accounts Receivable",
  "Family credits = Customer Deposits",
  "Supplier balances = Accounts Payable",
  "Cash screens = Cash ledger",
  "Bank screens = Bank ledger",
  "Payroll reports = Payroll accounting",
  "Net Position = Accounting ledger",
  "Trial Balance debits = Trial Balance credits",
  "Food income = Food Income ledger",
  "Inventory valuation = Inventory Asset ledger",
  "Food cost = Food Program Expense ledger",
];
