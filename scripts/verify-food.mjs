import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

async function expectFailure(label,work){
  const savepoint="sp_"+Math.random().toString(16).slice(2);
  await client.query("savepoint "+savepoint);
  let failed=false;
  try{await work();}catch{failed=true;await client.query("rollback to savepoint "+savepoint);}
  assert.equal(failed,true,label);
}

try{
  await client.query("begin");

  const requiredPermissions=["food.view","food.manage","food.billing","food.payments"];
  const adminPermissions=await client.query("select rp.permission_key from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key=any($1::text[])",[requiredPermissions]);
  assert.equal(adminPermissions.rowCount,requiredPermissions.length,"Administrator must receive every Step 10 permission");

  const types=(await client.query("select id,category from account_type")).rows;
  const type=Object.fromEntries(types.map((r)=>[r.category,r.id]));
  const suffix=randomUUID().slice(0,8);
  async function account(code,name,category){
    const r=await client.query("insert into account(code,name,account_type_id,currency) values ($1,$2,$3,'USD') returning id",[code+"-"+suffix,name,type[category]]);
    return r.rows[0].id;
  }

  const ar=await account("CI-FOOD-AR","CI Food AR","asset");
  const deposits=await account("CI-FOOD-DEP","CI Food Deposits","liability");
  const cash=await account("CI-FOOD-CASH","CI Food Cash","asset");
  const tuitionIncome=await account("CI-FOOD-TUITION","CI Billing Income","income");
  const foodIncome=await account("CI-FOOD-INCOME","CI Food Income","income");

  await client.query("insert into cash_bank_account(account_id,account_kind,display_name) values ($1,'cash','CI Food Cash')",[cash]);
  const journal=(await client.query("insert into journal(code,name) values ($1,'CI Food Billing') returning id",["CIFD-"+suffix])).rows[0].id;
  await client.query("update accounting_configuration set billing_journal_id=$1 where id=1",[journal]);
  for(const [roleKey,accountId] of Object.entries({
    accounts_receivable:ar,
    customer_deposits:deposits,
    payment_asset:cash,
    billing_income:tuitionIncome,
    food_income:foodIncome,
  })){
    await client.query("insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict (role_key) do update set account_id=excluded.account_id",[roleKey,accountId]);
  }
  await client.query("insert into accounting_period(name,starts_on,ends_on,status) values ($1,'2026-09-01','2026-12-31','open')",["CI Food Oct "+suffix]);

  const family=(await client.query("insert into family(display_name) values ('CI Food Family') returning id")).rows[0].id;
  const student=(await client.query("insert into student(family_id,first_name,last_name,date_of_birth,status) values ($1,'Food','Student','2022-01-01','active') returning id",[family])).rows[0].id;
  const year=(await client.query("insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','planned') returning id",["CI-FOOD-"+suffix])).rows[0].id;
  const term=(await client.query("insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'September–December','2026-09-01','2026-12-31') returning id",[year])).rows[0].id;
  const klass=(await client.query("insert into school_class(school_year_id,name,status) values ($1,$2,'active') returning id",[year,"CI Food Class "+suffix])).rows[0].id;
  const enrollment=(await client.query("insert into student_enrollment(student_id,school_year_id,class_id,starts_on) values ($1,$2,$3,'2026-09-01') returning id",[student,year,klass])).rows[0].id;
  await client.query("insert into student_term_enrollment(enrollment_id,school_year_id,term_id,starts_on,ends_on) values ($1,$2,$3,'2026-09-01','2026-12-31')",[enrollment,year,term]);

  const item=(await client.query("insert into food_item(code,name,status) values ($1,'CI Lunch','active') returning id",["LUNCH-"+suffix])).rows[0].id;
  await client.query("insert into food_item_price(food_item_id,amount,currency,effective_from,effective_to) values ($1,5,'USD','2026-09-01','2026-10-31')",[item]);
  await expectFailure("Overlapping food item price periods must be rejected",()=>client.query("insert into food_item_price(food_item_id,amount,currency,effective_from,effective_to) values ($1,6,'USD','2026-10-01','2026-11-30')",[item]));
  await client.query("insert into food_item_price(food_item_id,amount,currency,effective_from) values ($1,6,'USD','2026-11-01')",[item]);

  const packages={};
  for(const [kind,price] of [["daily","5.00"],["weekly","20.00"],["monthly","100.00"],["term","280.00"]]){
    const p=(await client.query("insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency,available_from,available_to,status) values ($1,$2,$3,$4,$5,$6,'USD','2026-09-01','2026-12-31','draft') returning id",[year,term,kind.toUpperCase()+"-"+suffix,"CI "+kind+" food package",kind,price])).rows[0].id;
    await client.query("insert into food_package_item(food_package_id,food_item_id,quantity) values ($1,$2,1)",[p,item]);
    await client.query("update food_package set status='active' where id=$1",[p]);
    packages[kind]=p;
  }

  const kinds=await client.query("select package_kind from food_package where id=any($1::uuid[]) order by package_kind",[Object.values(packages)]);
  assert.deepEqual(new Set(kinds.rows.map((r)=>r.package_kind)),new Set(["daily","weekly","monthly","term"]),"All four food package frequencies must exist");

  await expectFailure("Activated package pricing must be immutable",()=>client.query("update food_package set package_price=110 where id=$1",[packages.monthly]));
  await expectFailure("Activated package contents must be immutable",()=>client.query("update food_package_item set quantity=2 where food_package_id=$1 and food_item_id=$2",[packages.monthly,item]));

  const selection=(await client.query("insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on) values ($1,$2,$3,$4,$5,100,'USD',1,'2026-10-01','2026-10-31') returning id,unit_price::text",[family,student,year,term,packages.monthly])).rows[0];
  assert.equal(selection.unit_price,"100.00","Student selection must snapshot the active package price");

  await expectFailure("Overlapping duplicate student food selections must be rejected",()=>client.query("insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on) values ($1,$2,$3,$4,$5,100,'USD',1,'2026-10-15','2026-10-31')",[family,student,year,term,packages.monthly]));

  const billNumber="CI-FOOD-"+randomUUID();
  const bill=(await client.query("insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency) values ($1,$2,$3,$4,$5,$6,$7,'2026-10-01','2026-10-31','2026-10-05','USD') returning id",[billNumber,family,student,year,term,packages.monthly,selection.id])).rows[0].id;
  await client.query("insert into food_bill_line(food_bill_id,description,package_kind,quantity,unit_price) values ($1,'CI monthly food package','monthly',1,100)",[bill]);
  assert.equal((await client.query("select total_amount::text from food_bill where id=$1",[bill])).rows[0].total_amount,"100.00");

  await expectFailure("Duplicate live billing periods for one selection must be rejected",()=>client.query("insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency) values ($1,$2,$3,$4,$5,$6,$7,'2026-10-01','2026-10-31','2026-10-05','USD')",["CI-DUP-"+randomUUID(),family,student,year,term,packages.monthly,selection.id]));

  await client.query("select issue_food_bill($1,'2026-10-01',null)",[bill]);
  await expectFailure("Issued food bill lines must be immutable",()=>client.query("update food_bill_line set unit_price=90 where food_bill_id=$1",[bill]));

  const billJournal=await client.query("select je.status,sum(jl.debit)::text as debit,sum(jl.credit)::text as credit from journal_entry je join journal_line jl on jl.journal_entry_id=je.id where je.source_type='food_bill' and je.source_id=$1 group by je.status",[bill]);
  assert.equal(billJournal.rows[0].status,"posted");
  assert.equal(billJournal.rows[0].debit,"100.00");
  assert.equal(billJournal.rows[0].credit,"100.00");

  const receiptNumber="CI-FOOD-REC-"+randomUUID();
  const payment=(await client.query("insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id,notes) values ($1,$2,$3,'payment',60,'USD','2026-10-02','cash',$4,'Food payment') returning id",[receiptNumber,family,student,cash])).rows[0].id;
  await client.query("select accounting_post_payment($1,null)",[payment]);
  const foodPaymentAllocation=(await client.query("insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,60,'2026-10-02') returning id",[payment,bill])).rows[0].id;
  await client.query("select accounting_post_food_payment_allocation($1,null)",[foodPaymentAllocation]);

  await expectFailure("Food allocations cannot be dated before their payment or bill",async()=>{
    const early=(await client.query("insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id) values ($1,$2,$3,'payment',1,'USD','2026-10-02','cash',$4) returning id",["CI-EARLY-"+randomUUID(),family,student,cash])).rows[0].id;
    await client.query("insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,1,'2026-09-30')",[early,bill]);
  });

  assert.equal((await client.query("select balance_amount::text,status from food_bill_balance where id=$1",[bill])).rows[0].balance_amount,"40.00","Partial food payment must reduce the bill balance");
  assert.equal((await client.query("select unallocated_amount::text from payment_balance where id=$1",[payment])).rows[0].unallocated_amount,"0.00","Food allocation must consume the shared payment balance");

  const secondBill=(await client.query("insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency) values ($1,$2,$3,$4,$5,$6,$7,'2026-10-01','2026-10-15','2026-10-05','USD') returning id",["CI-FOOD-SECOND-"+randomUUID(),family,student,year,term,packages.monthly,selection.id])).rows[0].id;
  await client.query("insert into food_bill_line(food_bill_id,description,package_kind,quantity,unit_price) values ($1,'Half month test','monthly',0.5,100)",[secondBill]);
  await client.query("select issue_food_bill($1,'2026-10-01',null)",[secondBill]);
  await expectFailure("One payment cannot be double-allocated across food bills",()=>client.query("insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,1,'2026-10-02')",[payment,secondBill]));
  await client.query("select void_food_bill($1,'2026-10-03',null,'CI cleanup')",[secondBill]);

  const creditNumber="CI-FOOD-CR-"+randomUUID();
  const credit=(await client.query("insert into credit_note(credit_note_number,family_id,student_id,amount,currency,reason,issued_on,status) values ($1,$2,$3,40,'USD','Transferable family credit','2026-10-03','issued') returning id",[creditNumber,family,student])).rows[0].id;
  await client.query("select accounting_post_credit_note($1,null)",[credit]);
  const foodCreditAllocation=(await client.query("insert into food_credit_allocation(credit_note_id,food_bill_id,amount,allocated_on) values ($1,$2,40,'2026-10-03') returning id",[credit,bill])).rows[0].id;
  await client.query("select accounting_post_food_credit_allocation($1,null)",[foodCreditAllocation]);

  await expectFailure("Food credit allocations cannot be dated before their credit or bill",async()=>{
    const earlyCredit=(await client.query("insert into credit_note(credit_note_number,family_id,student_id,amount,currency,reason,issued_on,status) values ($1,$2,$3,1,'USD','CI early-date check','2026-10-03','issued') returning id",["CI-EARLY-CR-"+randomUUID(),family,student])).rows[0].id;
    await client.query("insert into food_credit_allocation(credit_note_id,food_bill_id,amount,allocated_on) values ($1,$2,1,'2026-09-30')",[earlyCredit,bill]);
  });

  const settled=(await client.query("select balance_amount::text,paid_amount::text,credit_amount::text,status from food_bill_balance where id=$1",[bill])).rows[0];
  assert.equal(settled.balance_amount,"0.00");
  assert.equal(settled.paid_amount,"60.00");
  assert.equal(settled.credit_amount,"40.00");
  assert.equal(settled.status,"paid");
  assert.equal((await client.query("select unallocated_amount::text from credit_note_balance where id=$1",[credit])).rows[0].unallocated_amount,"0.00");

  const incomeRow=(await client.query("select total_amount::text,balance_amount::text from food_income_report where id=$1",[bill])).rows[0];
  assert.equal(incomeRow.total_amount,"100.00");
  assert.equal(incomeRow.balance_amount,"0.00");
  assert.equal((await client.query("select count(*)::int as count from family_ledger where entry_type='food_bill' and source_id=$1",[bill])).rows[0].count,1);
  assert.equal((await client.query("select count(*)::int as count from student_ledger where entry_type='food_bill' and source_id=$1",[bill])).rows[0].count,1);

  const receivable=(await client.query("select balance_amount::text from report_receivables('2026-10-31') where invoice_id=$1",[bill])).rows[0];
  assert.equal(receivable.balance_amount,"0.00","Food bill must participate in the shared receivables report");

  const gate=await client.query("select check_name,difference::text,passed from release_reconciliation_gate('2026-10-31') where check_name in ('Student balances = Accounts Receivable','Family credits = Customer Deposits')");
  assert.equal(gate.rowCount,2);
  for(const row of gate.rows){
    assert.equal(row.difference,"0.00",row.check_name+" difference must be zero");
    assert.equal(row.passed,true,row.check_name+" must still pass after food billing");
  }

  const trial=await client.query("select sum(debit_balance)::text as debit,sum(credit_balance)::text as credit from report_trial_balance('2026-10-31') where currency='USD'");
  assert.equal(trial.rows[0].debit,trial.rows[0].credit,"Trial balance must remain balanced");

  await client.query("select accounting_reverse_payment($1,'2026-10-04',null,'CI food payment reversal')",[payment]);
  await client.query("update payment set status='reversed',reversed_at='2026-10-04T12:00:00Z',reversal_reason='CI food payment reversal' where id=$1",[payment]);
  await client.query("select accounting_reverse_credit_note($1,'2026-10-04',null,'CI food credit reversal')",[credit]);
  await client.query("update credit_note set status='reversed',reversed_at='2026-10-04T12:01:00Z',reversal_reason='CI food credit reversal' where id=$1",[credit]);

  const reopened=(await client.query("select balance_amount::text,status from food_bill_balance where id=$1",[bill])).rows[0];
  assert.equal(reopened.balance_amount,"100.00","Reversing allocated funds must reopen the food receivable");
  assert.equal(reopened.status,"issued");
  await client.query("select void_food_bill($1,'2026-10-05',null,'CI food bill reversal after source reversals')",[bill]);
  assert.equal((await client.query("select status from food_bill where id=$1",[bill])).rows[0].status,"void","A food bill must be voidable after all allocated sources are reversed");
  assert.equal((await client.query("select count(*)::int as count from food_income_report where id=$1",[bill])).rows[0].count,0,"Voided food bills must not appear as current food income");
  assert.equal((await client.query("select count(*)::int as count from family_ledger where entry_type='food_bill_void' and source_id=$1",[bill])).rows[0].count,1,"Family ledger must retain the food-bill reversal");
  assert.equal((await client.query("select count(*)::int as count from student_ledger where entry_type='food_bill_void' and source_id=$1",[bill])).rows[0].count,1,"Student ledger must retain the food-bill reversal");

  const postVoidGate=await client.query("select check_name,difference::text,passed from release_reconciliation_gate('2026-10-31') where check_name in ('Student balances = Accounts Receivable','Family credits = Customer Deposits')");
  for(const row of postVoidGate.rows){
    assert.equal(row.difference,"0.00",row.check_name+" must reconcile after reversals and void");
    assert.equal(row.passed,true,row.check_name+" must pass after reversals and void");
  }
  const postVoidTrial=await client.query("select sum(debit_balance)::text as debit,sum(credit_balance)::text as credit from report_trial_balance('2026-10-31') where currency='USD'");
  assert.equal(postVoidTrial.rows[0].debit,postVoidTrial.rows[0].credit,"Trial balance must remain balanced after reversals and void");

  await client.query("update food_package set status='archived' where id=$1",[packages.monthly]);
  await client.query("update student_food_selection set status='ended',ended_at=now() where id=$1",[selection.id]);
  assert.equal((await client.query("select status from student_food_selection where id=$1",[selection.id])).rows[0].status,"ended","A selection must remain closable after its package is archived");

  const draftBeforeClose=(await client.query("insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency) values ($1,$2,$3,'CI draft before close','daily',5,'USD') returning id",[year,term,"DRAFT-"+suffix])).rows[0].id;
  await client.query("update school_term set status='closed' where id=$1",[term]);
  await expectFailure("Closed terms must reject draft package-content changes",()=>client.query("insert into food_package_item(food_package_id,food_item_id,quantity) values ($1,$2,1)",[draftBeforeClose,item]));
  await expectFailure("Closed terms must reject new food packages",()=>client.query("insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency) values ($1,$2,$3,'Closed term food','daily',5,'USD')",[year,term,"CLOSED-"+suffix]));
  await expectFailure("Closed terms must reject new food selections",()=>client.query("insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on) values ($1,$2,$3,$4,$5,20,'USD',1,'2026-10-01','2026-10-07')",[family,student,year,term,packages.weekly]));

  console.log("Step 10 food verification passed.");
  console.log("Covered: items/prices, daily/weekly/monthly/term packages, selections, price snapshots, bills, receipts, shared credits, double-allocation protection, ledgers, accounting, closed terms and Release 1 reconciliation.");
  await client.query("rollback");
}finally{
  client.release();
  await pool.end();
}
