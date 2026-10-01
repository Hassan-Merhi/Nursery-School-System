import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool }=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new Pool({connectionString});
const client=await pool.connect();

async function createAccount(code,name,typeId,suffix){
  const r=await client.query(
    "insert into account(code,name,account_type_id,currency,allow_posting) values ($1,$2,$3,'USD',true) returning id",
    [code+"-"+suffix,name,typeId],
  );
  return r.rows[0].id;
}
async function amount(sql,params=[]){
  const r=await client.query(sql,params);
  return r.rows[0]?.amount??"0.00";
}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8).toUpperCase();

  const required=["management.view","reports.view","reports.export","report_documents.view"];
  const permissions=await client.query(
    `select rp.permission_key
     from role_permission rp join role r on r.id=rp.role_id
     where lower(r.name)='administrator' and rp.permission_key=any($1::text[])`,
    [required],
  );
  assert.equal(permissions.rowCount,required.length,"Administrator must receive every Step 8 permission");
  const payrollInstalled=(await client.query(
    "select to_regclass('employee') is not null as installed",
  )).rows[0].installed;

  const types=await client.query(
    "select id,category from account_type where code=any($1::text[])",
    [["ASSET","LIABILITY","EQUITY","INCOME","EXPENSE"]],
  );
  const type=Object.fromEntries(types.rows.map((x)=>[x.category,x.id]));
  assert.equal(Object.keys(type).length,5);

  await client.query(
    "insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-10-01','2026-10-31')",
    ["CI Step8 October "+suffix],
  );
  const journal=(await client.query(
    "insert into journal(code,name) values ($1,'CI Step 8 Journal') returning id",
    ["RPT-"+suffix],
  )).rows[0].id;
  await client.query(
    "update accounting_configuration set billing_journal_id=$1,operations_journal_id=$1,rentals_journal_id=$1 where id=1",
    [journal],
  );
  if(payrollInstalled){
    await client.query("update accounting_configuration set payroll_journal_id=$1 where id=1",[journal]);
  }

  const bank=await createAccount("1010","Operating Bank",type.asset,suffix);
  const cash=await createAccount("1020","School Cash",type.asset,suffix);
  const ar=await createAccount("1100","Student Receivables",type.asset,suffix);
  const prepaidRent=await createAccount("1200","Prepaid Rent",type.asset,suffix);
  const rentDeposit=await createAccount("1250","Rent Deposit",type.asset,suffix);
  const parentCredits=await createAccount("2100","Parent Credits",type.liability,suffix);
  const ap=await createAccount("2200","Accounts Payable",type.liability,suffix);
  const rentPayable=await createAccount("2250","Rent Payable",type.liability,suffix);
  const tuition=await createAccount("4000","Tuition Income",type.income,suffix);
  const supplies=await createAccount("5100","School Supplies",type.expense,suffix);
  const rentExpense=await createAccount("6100","Rent Expense",type.expense,suffix);
  let payrollExpense=null;
  let salaryPayable=null;
  let salaryAdvance=null;
  if(payrollInstalled){
    payrollExpense=await createAccount("6200","Payroll Expense",type.expense,suffix);
    salaryPayable=await createAccount("2300","Salary Payable",type.liability,suffix);
    salaryAdvance=await createAccount("1300","Salary Advances",type.asset,suffix);
  }

  await client.query(
    "insert into cash_bank_account(account_id,account_kind,display_name,bank_name) values ($1,'bank','Operating Bank','CI Bank'),($2,'cash','School Cash',null)",
    [bank,cash],
  );
  const mappings=[
    ["accounts_receivable",ar],["billing_income",tuition],["customer_deposits",parentCredits],
    ["payment_asset",bank],["accounts_payable",ap],["rent_expense",rentExpense],
    ["prepaid_rent",prepaidRent],["rent_payable",rentPayable],["rent_deposit",rentDeposit],
  ];
  if(payrollInstalled){
    mappings.push(["payroll_expense",payrollExpense],["salary_payable",salaryPayable],["salary_advance",salaryAdvance]);
  }
  for(const [role,accountId] of mappings){
    await client.query(
      "insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict (role_key) do update set account_id=excluded.account_id",
      [role,accountId],
    );
  }

  const year=(await client.query(
    "insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','planned') returning id",
    ["CI Step8 2026-2027 "+suffix],
  )).rows[0].id;
  const term=(await client.query(
    "insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'September–December','2026-09-01','2026-12-31') returning id",
    [year],
  )).rows[0].id;
  const schoolClass=(await client.query(
    "insert into school_class(school_year_id,name,capacity,status) values ($1,$2,20,'active') returning id",
    [year,"CI Montessori "+suffix],
  )).rows[0].id;
  const fee=(await client.query(
    "insert into fee_schedule(school_year_id,term_id,name,standard_fee,currency,status,activated_at) values ($1,$2,$3,1000.00,'USD','active',now()) returning id",
    [year,term,"CI October Tuition "+suffix],
  )).rows[0].id;

  const families=[];
  const students=[];
  let firstPayment=null;
  for(let i=1;i<=2;i++){
    const family=(await client.query(
      "insert into family(display_name) values ($1) returning id",
      ["CI Step8 Family "+i+" "+suffix],
    )).rows[0].id;
    families.push(family);
    const student=(await client.query(
      "insert into student(family_id,first_name,last_name,date_of_birth,status,admission_date) values ($1,$2,'Reports','2022-01-01','active','2026-09-01') returning id",
      [family,"Child"+i],
    )).rows[0].id;
    students.push(student);
    const enrollment=(await client.query(
      "insert into student_enrollment(student_id,school_year_id,class_id,status,enrolled_on,starts_on) values ($1,$2,$3,'enrolled','2026-09-01','2026-09-01') returning id",
      [student,year,schoolClass],
    )).rows[0].id;
    await client.query(
      "insert into student_term_enrollment(enrollment_id,school_year_id,term_id,status,starts_on,ends_on) values ($1,$2,$3,'enrolled','2026-09-01','2026-12-31')",
      [enrollment,year,term],
    );

    const invoice=(await client.query(
      "insert into invoice(invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,currency,due_on) values ($1,$2,$3,$4,$5,$6,'USD','2026-10-05') returning id",
      ["CI8-INV-"+i+"-"+suffix,family,student,year,term,fee],
    )).rows[0].id;
    await client.query(
      "insert into invoice_line(invoice_id,line_type,description,gross_amount) values ($1,'nursery_fee','October tuition',1000.00)",
      [invoice],
    );
    await client.query("update invoice set status='issued',issued_on='2026-10-01' where id=$1",[invoice]);
    await client.query("select accounting_post_invoice($1,null)",[invoice]);

    const paymentAmount=i===1?"1100.00":"400.00";
    const allocated=i===1?"1000.00":"400.00";
    const paymentAccount=i===1?bank:cash;
    const payment=(await client.query(
      `insert into payment(
        receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id
      ) values ($1,$2,$3,'payment',$4,'USD',$5,$6,$7) returning id`,
      [
        "CI8-REC-"+i+"-"+suffix,family,student,paymentAmount,
        i===1?"2026-10-03":"2026-10-04",i===1?"bank_transfer":"cash",paymentAccount,
      ],
    )).rows[0].id;
    if(i===1)firstPayment=payment;
    await client.query("select accounting_post_payment($1,null)",[payment]);
    const allocation=(await client.query(
      "insert into payment_allocation(payment_id,invoice_id,amount,allocated_on) values ($1,$2,$3,$4) returning id",
      [payment,invoice,allocated,i===1?"2026-10-03":"2026-10-04"],
    )).rows[0].id;
    await client.query("select accounting_post_payment_allocation($1,null)",[allocation]);
  }

  const expense=(await client.query(
    `insert into expense(
      expense_number,expense_account_id,payment_account_id,amount,currency,incurred_on,
      payment_method,notes,status,submitted_at,approved_at
    ) values ($1,$2,$3,300.00,'USD','2026-10-10','cash','October supplies','approved',now(),now()) returning id`,
    ["CI8-EXP-"+suffix,supplies,cash],
  )).rows[0].id;
  await client.query("select accounting_post_expense($1,null)",[expense]);

  const landlord=(await client.query(
    "insert into landlord(landlord_number,name) values ($1,'CI Step8 Landlord') returning id",
    ["CI8-LND-"+suffix],
  )).rows[0].id;
  const agreement=(await client.query(
    `insert into rental_agreement(
      agreement_number,landlord_id,property_name,property_address,start_on,end_on,
      recurring_amount,currency,frequency,due_day,deposit_amount
    ) values ($1,$2,'CI October Property','CI Address','2026-10-01','2026-10-31',500.00,'USD','monthly',1,0) returning id`,
    ["CI8-RNT-"+suffix,landlord],
  )).rows[0].id;
  await client.query("select activate_rental_agreement($1,null)",[agreement]);
  const recognized=await client.query("select recognize_rent_through($1,'2026-10-31',null)::int count",[agreement]);
  assert.equal(recognized.rows[0].count,1,"October rent must be recognized once");

  let payrollRun=null;
  if(payrollInstalled){
    const jobTitle=(await client.query(
      "insert into job_title(name) values ($1) returning id",
      ["CI Teacher "+suffix],
    )).rows[0].id;
    const employee=(await client.query(
      `insert into employee(employee_number,first_name,last_name,job_title_id,start_on,status)
       values ($1,'October','Teacher',$2,'2026-09-01','active') returning id`,
      ["CI8-EMP-"+suffix,jobTitle],
    )).rows[0].id;
    await client.query(
      `insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency,notes)
       values ($1,'2026-09-01',700.00,'USD','Milestone 8 salary')`,
      [employee],
    );
    payrollRun=(await client.query(
      `insert into payroll_run(run_number,period_start,period_end,pay_date,currency,status)
       values ($1,'2026-10-01','2026-10-31','2026-10-31','USD','draft') returning id`,
      ["CI8-PAY-"+suffix],
    )).rows[0].id;
    const populated=await client.query("select populate_payroll_run($1,null)::int count",[payrollRun]);
    assert.equal(populated.rows[0].count,1,"October payroll must include the test employee");
    await client.query(
      "update payroll_run set status='approved',submitted_at=now(),approved_at=now() where id=$1",
      [payrollRun],
    );
    await client.query("select lock_payroll_run($1,null)",[payrollRun]);
  }

  // Independent October 2026 arithmetic:
  // Fees due 2,000; fee collections allocated 1,400; AR 600; prepayment 100.
  // Bank 1,100; cash 100 after a 300 supply expense.
  // Without payroll: expenses 800 = 300 supplies + 500 rent; liabilities 600; net position 1,200.
  // With Step 7 installed: add payroll expense/payable 700, so expenses 1,500,
  // liabilities 1,300 and net position 500. Cash is unchanged because payroll remains unpaid.
  const active=await client.query("select report_active_student_count('2026-10-31') count");
  assert.equal(active.rows[0].count,2,"Dashboard active students");

  assert.equal(await amount(
    "select coalesce(sum(total_amount),0)::numeric(14,2)::text amount from invoice where due_on between '2026-10-01' and '2026-10-31' and status not in ('draft','void')",
  ),"2000.00","Expected fees");

  assert.equal(await amount(
    `select coalesce(sum(pa.amount),0)::numeric(14,2)::text amount
     from payment p join payment_allocation pa on pa.payment_id=p.id
     where p.received_on between '2026-10-01' and '2026-10-31'
       and pa.allocated_on<='2026-10-31'
       and (p.status='posted' or p.reversed_at::date>'2026-10-31')`,
  ),"1400.00","Collected fees");

  assert.equal(await amount(
    "select coalesce(sum(balance_amount),0)::numeric(14,2)::text amount from report_receivables('2026-10-31')",
  ),"600.00","Accounts receivable");
  assert.equal(await amount(
    "select coalesce(sum(available_credit),0)::numeric(14,2)::text amount from report_family_credits('2026-10-31')",
  ),"100.00","Family prepayment");

  assert.equal(await amount(
    "select balance::numeric(14,2)::text amount from report_cash_bank_balances('2026-10-31') where account_id=$1",
    [bank],
  ),"1100.00","Bank balance");
  assert.equal(await amount(
    "select balance::numeric(14,2)::text amount from report_cash_bank_balances('2026-10-31') where account_id=$1",
    [cash],
  ),"100.00","Cash balance");

  const pnl=await client.query(
    `select category,sum(amount)::numeric(14,2)::text amount
     from report_profit_loss('2026-10-01','2026-10-31')
     group by category order by category`,
  );
  const pnlMap=Object.fromEntries(pnl.rows.map((x)=>[x.category,x.amount]));
  assert.equal(pnlMap.income,"2000.00","Income report");
  assert.equal(pnlMap.expense,payrollInstalled?"1500.00":"800.00","Expense report");

  assert.equal(await amount(
    `select b.normal_balance::numeric(14,2)::text amount
     from accounting_mapping m join report_account_balances('2026-10-31') b on b.account_id=m.account_id
     where m.role_key='rent_payable'`,
  ),"500.00","Rent due");

  if(payrollInstalled){
    assert.equal(await amount(
      `select b.normal_balance::numeric(14,2)::text amount
       from accounting_mapping m join report_account_balances('2026-10-31') b on b.account_id=m.account_id
       where m.role_key='salary_payable'`,
    ),"700.00","Payroll due");
    assert.equal(await amount(
      "select payroll_expense::numeric(14,2)::text amount from payroll_run_summary where id=$1",
      [payrollRun],
    ),"700.00","Employee payroll cost");
    const salaryHistory=await client.query(
      "select monthly_salary::numeric(14,2)::text salary,effective_from::text,effective_to::text from employee_salary_history where employee_id=(select employee_id from payroll_run_item where payroll_run_id=$1)",
      [payrollRun],
    );
    assert.equal(salaryHistory.rows[0].salary,"700.00","Salary history amount");
    assert.equal(salaryHistory.rows[0].effective_from,"2026-09-01","Salary history start");
    assert.equal(salaryHistory.rows[0].effective_to,null,"Current salary agreement remains open-ended");
  }

  const position=(await client.query(
    "select * from report_position('2026-10-31') where currency='USD'",
  )).rows[0];
  assert.equal(position.assets,"1800.00");
  assert.equal(position.liabilities,payrollInstalled?"1300.00":"600.00");
  assert.equal(position.equity,"0.00");
  assert.equal(position.income,"2000.00");
  assert.equal(position.expenses,payrollInstalled?"1500.00":"800.00");
  assert.equal(position.current_surplus,payrollInstalled?"500.00":"1200.00");
  assert.equal(position.net_position,payrollInstalled?"500.00":"1200.00");
  assert.equal(position.equation_difference,"0.00","Accounting equation must reconcile");

  const tb=(await client.query(
    `select sum(debit_balance)::numeric(14,2)::text debit,
       sum(credit_balance)::numeric(14,2)::text credit
     from report_trial_balance('2026-10-31') where currency='USD'`,
  )).rows[0];
  assert.equal(tb.debit,payrollInstalled?"3300.00":"2600.00");
  assert.equal(tb.credit,payrollInstalled?"3300.00":"2600.00");
  assert.equal(tb.debit,tb.credit,"Trial balance must balance");

  assert.equal(await amount(
    "select coalesce(sum(net_change),0)::numeric(14,2)::text amount from report_cash_flow('2026-10-01','2026-10-31') where currency='USD'",
  ),"1200.00","October net cash movement");

  const enrollmentCount=await client.query(
    "select count(*)::int count from report_enrollment where school_year_id=$1",
    [year],
  );
  assert.equal(enrollmentCount.rows[0].count,2,"Enrollment report must contain both students");

  const ledgerControl=await client.query(
    `select coalesce(sum(debit),0)::numeric(14,2)::text debit,
       coalesce(sum(credit),0)::numeric(14,2)::text credit
     from report_general_ledger('2026-10-01','2026-10-31')`,
  );
  assert.equal(ledgerControl.rows[0].debit,ledgerControl.rows[0].credit,"Period ledger debits and credits");

  // Historical integrity: later operational changes must not rewrite October.
  await client.query(
    "insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-11-01','2026-11-30')",
    ["CI Step8 November "+suffix],
  );
  assert.ok(firstPayment,"Expected the first sample payment");
  await client.query(
    "update payment set status='reversed',reversed_at=now(),reversal_reason='Future-effective CI reversal' where id=$1",
    [firstPayment],
  );
  await client.query(
    "select accounting_reverse_payment($1,'2026-11-05',null,'Future-effective CI reversal')",
    [firstPayment],
  );
  assert.equal(await amount(
    "select coalesce(sum(balance_amount),0)::numeric(14,2)::text amount from report_receivables('2026-10-31')",
  ),"600.00","A November payment reversal must not rewrite October receivables");
  assert.equal(await amount(
    "select coalesce(sum(available_credit),0)::numeric(14,2)::text amount from report_family_credits('2026-10-31')",
  ),"100.00","A November payment reversal must not rewrite October prepayments");
  assert.equal(await amount(
    "select coalesce(sum(balance_amount),0)::numeric(14,2)::text amount from report_receivables('2026-11-05')",
  ),"1600.00","The payment reversal must take effect on its accounting posting date");
  assert.equal(await amount(
    "select coalesce(sum(available_credit),0)::numeric(14,2)::text amount from report_family_credits('2026-11-05')",
  ),"0.00","Reversed parent credit must clear on the reversal posting date");

  const enrollmentId=(await client.query(
    "select id from student_enrollment where student_id=$1 and school_year_id=$2",
    [students[0],year],
  )).rows[0].id;
  await client.query(
    "update student_enrollment set status='withdrawn',withdrawal_on='2026-11-15',withdrawal_reason='CI future withdrawal' where id=$1",
    [enrollmentId],
  );
  await client.query(
    "update student_term_enrollment set status='withdrawn',ends_on='2026-11-15' where enrollment_id=$1 and term_id=$2",
    [enrollmentId,term],
  );
  await client.query(
    "update student set status='withdrawn',exit_date='2026-11-15' where id=$1",
    [students[0]],
  );
  assert.equal((await client.query("select report_active_student_count('2026-10-31') count")).rows[0].count,2,
    "A later withdrawal must not rewrite October active-student count");
  assert.equal((await client.query("select report_active_student_count('2026-11-15') count")).rows[0].count,1,
    "Withdrawal must stop active status on its effective date");
  assert.equal((await client.query("select report_active_student_count('2027-01-15') count")).rows[0].count,0,
    "Students must not remain active outside their enrolled term");

  await client.query("update cash_bank_account set is_active=false where account_id=$1",[cash]);
  assert.equal(await amount(
    "select balance::numeric(14,2)::text amount from report_cash_bank_balances('2026-10-31') where account_id=$1",
    [cash],
  ),"100.00","Deactivating a cash account must not erase it from historical balances");

  console.log("Step 8 verification passed: October 2026 manual totals and historical report integrity match exactly.");
  await client.query("rollback");
} catch(error){
  try{await client.query("rollback");}catch{}
  throw error;
} finally {
  client.release();
  await pool.end();
}
