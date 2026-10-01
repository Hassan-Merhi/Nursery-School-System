import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool }=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new Pool({connectionString});
const client=await pool.connect();

async function postEntry(journalId,postingDate,currency,sourceType,sourceId,description,lines){
  const entry=(await client.query(
    "insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,source_type,source_id) values ($1,'system',$2,$3,$4,$5,$6) returning id",
    [journalId,postingDate,currency,description,sourceType,sourceId],
  )).rows[0].id;
  for(let i=0;i<lines.length;i+=1){
    const line=lines[i];
    await client.query(
      "insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit) values ($1,$2,$3,$4,$5,$6)",
      [entry,i+1,line.accountId,line.description??description,line.debit??0,line.credit??0],
    );
  }
  await client.query("select post_journal_entry($1,null)",[entry]);
  return entry;
}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8).toUpperCase();

  const requiredFunctions=[
    "analytics_monthly_financials","analytics_monthly_students","analytics_fee_collection",
    "analytics_expense_trend","analytics_payroll_trend","analytics_rent_trend",
    "analytics_cash_trend","analytics_food_trend","analytics_term_comparison","analytics_year_over_year",
  ];
  const functions=await client.query("select distinct proname from pg_proc where proname=any($1::text[])",[requiredFunctions]);
  assert.equal(functions.rowCount,requiredFunctions.length,"All Step 13 analytics functions must be installed");

  const permission=await client.query(
    "select 1 from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key='analytics.view'",
  );
  assert.equal(permission.rowCount,1,"Administrator must receive analytics.view");

  const analyticsSource=await readFile("src/lib/analytics.ts","utf8");
  for(const forbidden of ["employee_name","employee_number","salary_agreement_id","payslip"]){
    assert.equal(analyticsSource.includes(forbidden),false,"Analytics DTO must not expose "+forbidden);
  }
  const pageSource=await readFile("src/app/analytics/page.tsx","utf8");
  assert.match(pageSource,/requirePermission\("analytics\.view"\)/);
  for(const id of ["term-comparison","monthly-trends","expense-trends","student-growth","fee-collection","food-profitability","payroll-trends","rent-impact","cash-movement","year-over-year"]){
    assert.ok(pageSource.includes('id="'+id+'"'),"Analytics page must render "+id);
  }
  assert.ok(pageSource.includes("No fees due"),"Zero-denominator fees need an explicit UI state");
  assert.ok(pageSource.includes("Cost data unavailable"),"Food cost needs an explicit unavailable state");

  const types=(await client.query("select id,category from account_type")).rows;
  const type=Object.fromEntries(types.map((r)=>[r.category,r.id]));
  assert.ok(type.asset&&type.liability&&type.income&&type.expense,"Base accounting types are required");

  async function account(prefix,name,category,currency="USD"){
    return (await client.query(
      "insert into account(code,name,account_type_id,currency) values ($1,$2,$3,$4) returning id",
      [prefix+"-"+suffix,name,type[category],currency],
    )).rows[0].id;
  }

  const bank=await account("A-BANK","CI Analytics Bank","asset");
  const cash=await account("A-CASH","CI Analytics Cash","asset");
  const ar=await account("A-AR","CI Analytics Receivable","asset");
  const prepaid=await account("A-PRE","CI Analytics Prepaid Rent","asset");
  const inventory=await account("A-INV","CI Analytics Food Inventory","asset");
  const income=await account("A-INC","CI Analytics Tuition Income","income");
  const foodIncome=await account("A-FINC","CI Analytics Food Income","income");
  const supplies=await account("A-SUP","CI Analytics Supplies","expense");
  const rentExpense=await account("A-RENT","CI Analytics Rent","expense");
  const foodExpense=await account("A-FCOST","CI Analytics Food Cost","expense");
  const eurCash=await account("A-EUR-CASH","CI Analytics EUR Cash","asset","EUR");
  const eurIncome=await account("A-EUR-INC","CI Analytics EUR Income","income","EUR");

  await client.query("insert into cash_bank_account(account_id,account_kind,display_name) values ($1,'bank','CI Analytics Bank'),($2,'cash','CI Analytics Cash'),($3,'cash','CI Analytics EUR Cash')",[bank,cash,eurCash]);
  for(const [roleKey,accountId] of [["rent_expense",rentExpense],["food_income",foodIncome],["food_program_expense",foodExpense]]){
    await client.query("insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict(role_key) do update set account_id=excluded.account_id",[roleKey,accountId]);
  }

  const journal=(await client.query("insert into journal(code,name) values ($1,'CI Analytics Journal') returning id",["AN-"+suffix])).rows[0].id;
  await client.query("insert into accounting_period(name,starts_on,ends_on) values ($1,'2025-09-01','2026-12-31')",["CI Analytics "+suffix]);

  await postEntry(journal,"2025-10-15","USD","analytics_prior",randomUUID(),"Prior year income",[
    {accountId:bank,debit:800},{accountId:income,credit:800},
  ]);
  await postEntry(journal,"2026-10-01","USD","analytics_income",randomUUID(),"Current income",[
    {accountId:bank,debit:1000},{accountId:income,credit:1000},
  ]);
  await postEntry(journal,"2026-10-02","USD","analytics_expense",randomUUID(),"Supplies",[
    {accountId:supplies,debit:200},{accountId:cash,credit:200},
  ]);
  const reversible=await postEntry(journal,"2026-10-15","USD","analytics_expense",randomUUID(),"Reversible expense",[
    {accountId:supplies,debit:75},{accountId:cash,credit:75},
  ]);
  await postEntry(journal,"2026-10-03","USD","cash_transfer",randomUUID(),"Internal cash transfer",[
    {accountId:bank,debit:500},{accountId:cash,credit:500},
  ]);
  await postEntry(journal,"2026-10-04","USD","rent_payment",randomUUID(),"Six-month prepaid rent",[
    {accountId:prepaid,debit:12000},{accountId:bank,credit:12000},
  ]);
  await postEntry(journal,"2026-11-30","USD","rent_recognition",randomUUID(),"Monthly rent recognition",[
    {accountId:rentExpense,debit:2000},{accountId:prepaid,credit:2000},
  ]);
  await postEntry(journal,"2026-10-05","EUR","analytics_income",randomUUID(),"EUR income",[
    {accountId:eurCash,debit:100},{accountId:eurIncome,credit:100},
  ]);

  const foodRevenueEntry=await postEntry(journal,"2026-10-08","USD","food_bill",randomUUID(),"Food billing revenue",[
    {accountId:ar,debit:300},{accountId:foodIncome,credit:300},
  ]);
  assert.ok(foodRevenueEntry);

  const kg=(await client.query("select id from inventory_unit where code='KG'")).rows[0].id;
  const ingredient=(await client.query(
    "insert into ingredient(code,name,unit_id,reorder_level,status) values ($1,'CI Analytics Ingredient',$2,0,'active') returning id",
    ["AN-ING-"+suffix,kg],
  )).rows[0].id;
  async function foodAdjustment(kind,value,date){
    const adjustment=(await client.query(
      "insert into inventory_adjustment(adjustment_number,ingredient_id,adjustment_kind,quantity,occurred_on,currency,reason,status,unit_cost_snapshot,total_value,posted_at) values ($1,$2,$3,1,$4,'USD','CI analytics','posted',$5,$5,now()) returning id",
      ["AN-ADJ-"+kind+"-"+suffix,ingredient,kind,date,value],
    )).rows[0].id;
    return postEntry(journal,date,"USD","inventory_adjustment",adjustment,"Food "+kind,[
      {accountId:foodExpense,debit:value},{accountId:inventory,credit:value},
    ]);
  }
  const usageEntry=await foodAdjustment("usage",100,"2026-10-09");
  await foodAdjustment("waste",20,"2026-10-10");

  const previousYear=(await client.query(
    "insert into school_year(name,starts_on,ends_on,status) values ($1,'2025-09-01','2026-06-30','closed') returning id",
    ["CI 2025-26 "+suffix],
  )).rows[0].id;
  await client.query(
    "insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'Term 1','2025-09-01','2025-12-31'),($1,2,'Term 2','2026-01-01','2026-03-31'),($1,3,'Term 3','2026-04-01','2026-06-30')",
    [previousYear],
  );
  const year=(await client.query(
    "insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','current') returning id",
    ["CI 2026-27 "+suffix],
  )).rows[0].id;
  const terms=(await client.query(
    "insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'Term 1','2026-09-01','2026-12-31'),($1,2,'Term 2','2027-01-01','2027-03-31'),($1,3,'Term 3','2027-04-01','2027-06-30') returning id,sequence",
    [year],
  )).rows;
  const term1=terms.find((t)=>Number(t.sequence)===1).id;
  const klass=(await client.query("insert into school_class(school_year_id,name,status) values ($1,$2,'active') returning id",[year,"CI Analytics "+suffix])).rows[0].id;
  const family=(await client.query("insert into family(display_name) values ($1) returning id",["CI Analytics Family "+suffix])).rows[0].id;
  async function student(first){
    return (await client.query(
      "insert into student(family_id,first_name,last_name,date_of_birth,status,admission_date) values ($1,$2,'Analytics','2022-01-01','active','2026-09-01') returning id",
      [family,first],
    )).rows[0].id;
  }
  const studentA=await student("Alpha");
  const studentB=await student("Beta");
  const enrollA=(await client.query(
    "insert into student_enrollment(student_id,school_year_id,class_id,status,enrolled_on,starts_on) values ($1,$2,$3,'enrolled','2026-08-20','2026-09-01') returning id",
    [studentA,year,klass],
  )).rows[0].id;
  const enrollB=(await client.query(
    "insert into student_enrollment(student_id,school_year_id,class_id,status,enrolled_on,starts_on,withdrawal_on) values ($1,$2,$3,'withdrawn','2026-10-01','2026-10-15','2026-11-10') returning id",
    [studentB,year,klass],
  )).rows[0].id;
  await client.query(
    "insert into student_term_enrollment(enrollment_id,school_year_id,term_id,status,starts_on,ends_on) values ($1,$3,$4,'enrolled','2026-09-01','2026-12-31'),($2,$3,$4,'withdrawn','2026-10-15','2026-11-10')",
    [enrollA,enrollB,year,term1],
  );

  const fee=(await client.query(
    "insert into fee_schedule(school_year_id,term_id,name,standard_fee,currency,status) values ($1,$2,$3,1000,'USD','active') returning id",
    [year,term1,"CI Analytics Fees "+suffix],
  )).rows[0].id;
  const invoice=(await client.query(
    "insert into invoice(invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,currency,status,due_on) values ($1,$2,$3,$4,$5,$6,'USD','draft','2026-10-05') returning id",
    ["AN-INV-"+suffix,family,studentA,year,term1,fee],
  )).rows[0].id;
  await client.query("insert into invoice_line(invoice_id,line_type,description,gross_amount) values ($1,'nursery_fee','CI tuition',1000)",[invoice]);
  await client.query("update invoice set status='issued',issued_on='2026-09-20' where id=$1",[invoice]);
  async function payment(number,amount,date){
    const id=(await client.query(
      "insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,status) values ($1,$2,$3,'payment',$4,'USD',$5,'cash','posted') returning id",
      [number,family,studentA,amount,date],
    )).rows[0].id;
    await client.query("insert into payment_allocation(payment_id,invoice_id,amount,allocated_on) values ($1,$2,$3,$4)",[id,invoice,amount,date]);
  }
  await payment("AN-REC1-"+suffix,500,"2026-10-10");
  await payment("AN-REC2-"+suffix,100,"2026-11-10");

  const job=(await client.query("insert into job_title(name) values ($1) returning id",["CI Analytics Teacher "+suffix])).rows[0].id;
  const employee=(await client.query(
    "insert into employee(employee_number,first_name,last_name,job_title_id,start_on,status) values ($1,'CI','Teacher',$2,'2026-09-01','active') returning id",
    ["AN-EMP-"+suffix,job],
  )).rows[0].id;
  const agreement=(await client.query(
    "insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency) values ($1,'2026-09-01',800,'USD') returning id",
    [employee],
  )).rows[0].id;
  const run=(await client.query(
    "insert into payroll_run(run_number,period_start,period_end,pay_date,currency,status) values ($1,'2026-10-01','2026-10-31','2026-10-31','USD','draft') returning id",
    ["AN-PAY-"+suffix],
  )).rows[0].id;
  await client.query(
    "insert into payroll_run_item(payroll_run_id,employee_id,salary_agreement_id,base_salary,allowance_total,bonus_total,deduction_total,advance_repayment_total,gross_pay,payroll_expense,net_pay) values ($1,$2,$3,800,100,50,50,100,950,900,800)",
    [run,employee,agreement],
  );
  await client.query("update payroll_run set status='locked',locked_at=now() where id=$1",[run]);

  const months=(await client.query("select * from analytics_monthly_financials('2026-09-01','2026-11-30') where currency='USD' order by month_start")).rows;
  assert.equal(months.length,3,"Monthly analytics must include an empty September");
  assert.equal(String(months[0].income),"0.00");
  assert.equal(String(months[1].expected_fees),"1000.00");
  assert.equal(String(months[1].collected_fees),"500.00");
  assert.equal(String(months[1].collection_rate),"50.00");
  assert.equal(String(months[2].expected_fees),"0.00");
  assert.equal(months[2].collection_rate,null,"No fees due must return null collection rate");

  const students=(await client.query("select * from analytics_monthly_students('2026-09-01','2026-11-30') order by month_start")).rows;
  assert.deepEqual(students.map((r)=>Number(r.closing_active)),[1,2,1],"Student growth must honor starts and withdrawals");
  assert.deepEqual(students.map((r)=>Number(r.new_enrollments)),[1,1,0]);
  assert.deepEqual(students.map((r)=>Number(r.withdrawals)),[0,0,1]);

  const payroll=(await client.query("select * from analytics_payroll_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0];
  assert.equal(String(payroll.payroll_expense),"900.00");
  assert.equal(String(payroll.net_pay),"800.00");
  assert.equal(Number(payroll.employee_count),1);
  const payrollShape=await client.query("select * from analytics_payroll_trend('2026-10-01','2026-10-31') limit 0");
  for(const forbidden of ["employee_name","employee_number","employee_id","salary_agreement_id","payslip"]){
    assert.equal(payrollShape.fields.some((f)=>f.name===forbidden),false,"Payroll analytics must remain aggregate-only");
  }

  const rentOct=(await client.query("select * from analytics_rent_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0];
  const rentNov=(await client.query("select * from analytics_rent_trend('2026-11-01','2026-11-30') where currency='USD'")).rows[0];
  assert.equal(String(rentOct.recognized_rent_expense),"0.00","Prepaid cash is not rent expense");
  assert.equal(String(rentNov.recognized_rent_expense),"2000.00","Rent is recognized when posted to rent expense");

  const cashOct=(await client.query("select * from analytics_cash_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0];
  assert.equal(String(cashOct.external_inflow),"1000.00");
  assert.equal(String(cashOct.external_outflow),"12275.00","Internal $500 cash-to-bank transfer must not inflate outflow");
  assert.equal(String(cashOct.net_external_movement),"-11275.00");

  const food=(await client.query("select * from analytics_food_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0];
  assert.equal(food.cost_available,true);
  assert.equal(String(food.food_revenue),"300.00");
  assert.equal(String(food.usage_cost),"100.00");
  assert.equal(String(food.waste_cost),"20.00");
  assert.equal(String(food.food_cost),"120.00");
  assert.equal(String(food.contribution),"180.00");
  assert.equal(String(food.contribution_margin),"60.00");

  const eur=(await client.query("select * from analytics_monthly_financials('2026-10-01','2026-10-31') where currency='EUR'")).rows[0];
  assert.equal(String(eur.income),"100.00","EUR must remain a separate analytics series");

  const term=(await client.query("select * from analytics_term_comparison($1) where term_sequence=1 and currency='USD'",[year])).rows[0];
  assert.equal(String(term.expected_fees),"1000.00");
  assert.equal(String(term.collected_fees),"600.00");
  assert.equal(String(term.outstanding_receivables),"400.00");

  const yoy=(await client.query("select * from analytics_year_over_year('2026-10-01','2026-10-31') where metric_key='income' and currency='USD'")).rows[0];
  assert.equal(String(yoy.current_value),"1300.0000");
  assert.equal(String(yoy.prior_value),"800.0000");
  assert.equal(String(yoy.change_value),"500.0000");

  const beforeReverse=(await client.query("select expenses::text from analytics_period_summary('2026-10-01','2026-10-31') where currency='USD'")).rows[0].expenses;
  await client.query("select reverse_journal_entry($1,'2026-12-10',null,'CI later-period reversal')",[reversible]);
  const afterReverse=(await client.query("select expenses::text from analytics_period_summary('2026-10-01','2026-10-31') where currency='USD'")).rows[0].expenses;
  assert.equal(afterReverse,beforeReverse,"A later reversal must not rewrite October analytics");

  const foodBefore=(await client.query("select food_cost::text from analytics_food_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0].food_cost;
  await client.query("select reverse_journal_entry($1,'2026-12-11',null,'CI food cost reversal')",[usageEntry]);
  const foodAfter=(await client.query("select food_cost::text from analytics_food_trend('2026-10-01','2026-10-31') where currency='USD'")).rows[0].food_cost;
  const foodReversal=(await client.query("select food_cost::text from analytics_food_trend('2026-12-01','2026-12-31') where currency='USD'")).rows[0].food_cost;
  assert.equal(foodAfter,foodBefore,"A later food-cost reversal must preserve October history");
  assert.equal(foodReversal,"-100.00","Food-cost reversal belongs to its posting month");

  console.log("Step 13 advanced analytics verification passed.");
  await client.query("rollback");
}catch(error){
  try{await client.query("rollback");}catch{}
  throw error;
}finally{
  client.release();
  await pool.end();
}
