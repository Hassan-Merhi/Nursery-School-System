import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool }=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new Pool({connectionString});
const client=await pool.connect();
async function balance(accountId){const r=await client.query("select normal_balance::numeric(14,2)::text balance from account_balance where account_id=$1",[accountId]);return r.rows[0]?.balance??"0.00";}
async function account(code,name,typeId,suffix){return (await client.query("insert into account(code,name,account_type_id,currency,allow_posting) values ($1,$2,$3,'USD',true) returning id",[code+"-"+suffix,name,typeId])).rows[0].id;}
async function expectFailure(label,work){const sp="sp_"+randomUUID().replaceAll("-","");await client.query("savepoint "+sp);let failed=false;try{await work();}catch{failed=true;await client.query("rollback to savepoint "+sp);}assert.equal(failed,true,label);}
async function payroll(number,start,end,payDate){const r=(await client.query("insert into payroll_run(run_number,period_start,period_end,pay_date,currency) values ($1,$2,$3,$4,'USD') returning id",[number,start,end,payDate])).rows[0];await client.query("select populate_payroll_run($1,null)",[r.id]);return r.id;}
async function lock(run){await client.query("update payroll_run set status='pending',submitted_at=now() where id=$1",[run]);await client.query("update payroll_run set status='approved',approved_at=now() where id=$1",[run]);return (await client.query("select lock_payroll_run($1,null) id",[run])).rows[0].id;}
async function pay(number,run,bank,date){const amount=(await client.query("select sum(net_pay)::numeric(14,2)::text amount from payroll_run_item where payroll_run_id=$1",[run])).rows[0].amount;const id=(await client.query("insert into payroll_payment(payment_number,payroll_run_id,payment_account_id,amount,currency,paid_on,method) values ($1,$2,$3,$4,'USD',$5,'bank_transfer') returning id",[number,run,bank,amount,date])).rows[0].id;await client.query("select accounting_post_payroll_payment($1,null)",[id]);return {id,amount};}
async function advance(number,employee,bank,amount,date,first,installments){const id=(await client.query("insert into salary_advance(advance_number,employee_id,advance_date,amount,currency,payment_account_id,installments_count,first_repayment_on) values ($1,$2,$3,$4,'USD',$5,$6,$7) returning id",[number,employee,date,amount,bank,installments,first])).rows[0].id;await client.query("select generate_salary_advance_schedule($1,null)",[id]);await client.query("select accounting_post_salary_advance($1,null)",[id]);return id;}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8).toUpperCase();
  const required=["employees.view","employees.manage","payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage"];
  const perms=await client.query("select rp.permission_key from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key=any($1::text[])",[required]);
  assert.equal(perms.rowCount,required.length,"Administrator must receive every Step 7 permission");

  const types=await client.query("select id,category from account_type where code=any($1::text[])",[["ASSET","LIABILITY","EQUITY","EXPENSE"]]);
  const type=Object.fromEntries(types.rows.map(x=>[x.category,x.id]));
  assert.equal(Object.keys(type).length,4);
  await client.query("insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-09-01','2026-12-31')",["CI Step7 "+suffix]);
  const journal=(await client.query("insert into journal(code,name) values ($1,'CI Payroll Journal') returning id",["PAY-"+suffix])).rows[0].id;
  await client.query("update accounting_configuration set payroll_journal_id=$1 where id=1",[journal]);
  const bank=await account("1015","Payroll Bank",type.asset,suffix);
  const advanceAsset=await account("1260","Salary Advances",type.asset,suffix);
  const payable=await account("2210","Salary Payable",type.liability,suffix);
  const equity=await account("3005","Opening Net Position",type.equity,suffix);
  const expense=await account("6200","Payroll Expense",type.expense,suffix);
  await client.query("insert into cash_bank_account(account_id,account_kind,display_name,bank_name) values ($1,'bank','Payroll Bank','CI Bank')",[bank]);
  for(const [role,id] of [["payroll_expense",expense],["salary_payable",payable],["salary_advance",advanceAsset]])await client.query("insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict(role_key) do update set account_id=excluded.account_id",[role,id]);
  const opening=(await client.query("insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference) values ($1,'opening_balance','2026-09-01','USD','CI Step 7 opening','CI7-OPEN') returning id",[journal])).rows[0].id;
  await client.query("insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit) values ($1,1,$2,'Opening bank',50000,0),($1,2,$3,'Opening equity',0,50000)",[opening,bank,equity]);
  await client.query("select post_journal_entry($1,null)",[opening]);

  const teacher=(await client.query("insert into job_title(name,description) values ($1,'Teacher') returning id",["Teacher "+suffix])).rows[0].id;
  const admin=(await client.query("insert into job_title(name,description) values ($1,'Administrator') returning id",["Administrator "+suffix])).rows[0].id;
  const alice=(await client.query("insert into employee(employee_number,first_name,last_name,job_title_id,start_on) values ($1,'Alice','Teacher',$2,'2026-09-01') returning id",["CI7-E1-"+suffix,teacher])).rows[0].id;
  const bob=(await client.query("insert into employee(employee_number,first_name,last_name,job_title_id,start_on) values ($1,'Bob','Admin',$2,'2026-10-01') returning id",["CI7-E2-"+suffix,admin])).rows[0].id;
  const carol=(await client.query("insert into employee(employee_number,first_name,last_name,job_title_id,start_on) values ($1,'Carol','Teacher',$2,'2026-10-01') returning id",["CI7-E3-"+suffix,teacher])).rows[0].id;
  const salary800=(await client.query("insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency,notes) values ($1,'2026-09-01',800,'USD','Original salary') returning id",[alice])).rows[0].id;
  const salary1000=(await client.query("insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency,notes) values ($1,'2026-10-01',1000,'USD','October raise') returning id",[alice])).rows[0].id;
  await client.query("insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency) values ($1,'2026-10-01',900,'USD'),($2,'2026-10-01',800,'USD')",[bob,carol]);

  const history=await client.query("select id,effective_from::text,effective_to::text,monthly_salary::text from employee_salary_history where employee_id=$1 order by effective_from",[alice]);
  assert.equal(history.rowCount,2);
  assert.equal(history.rows[0].id,salary800);
  assert.equal(history.rows[0].monthly_salary,"800.00");
  assert.equal(history.rows[0].effective_to,"2026-09-30");
  assert.equal(history.rows[1].id,salary1000);
  assert.equal(history.rows[1].monthly_salary,"1000.00");
  assert.equal(history.rows[1].effective_to,null);
  await expectFailure("Salary history must be immutable",()=>client.query("update employee_salary_agreement set monthly_salary=999 where id=$1",[salary800]));

  const sep=await payroll("CI7-PAY-SEP-"+suffix,"2026-09-01","2026-09-30","2026-09-30");
  const sepItem=(await client.query("select * from payroll_run_item where payroll_run_id=$1",[sep])).rows[0];
  assert.equal(sepItem.employee_id,alice);
  assert.equal(sepItem.salary_agreement_id,salary800);
  assert.equal(sepItem.base_salary,"800.00","September payroll must retain the original 800 salary");
  await lock(sep);
  assert.equal((await client.query("select net_pay::text from payroll_run_item where id=$1",[sepItem.id])).rows[0].net_pay,"800.00");
  const sepPayment=await pay("CI7-PPAY-SEP-"+suffix,sep,bank,"2026-09-30");
  assert.equal(sepPayment.amount,"800.00");

  const adv1=await advance("CI7-ADV1-"+suffix,carol,bank,"300.00","2026-10-01","2026-10-31",2);
  const adv2=await advance("CI7-ADV2-"+suffix,carol,bank,"200.00","2026-10-01","2026-10-31",2);
  assert.ok(adv1&&adv2);
  assert.equal(await balance(advanceAsset),"500.00");
  const sched=await client.query("select a.advance_number,s.installment_number,s.due_on::text,s.amount::text from salary_advance_repayment_schedule s join salary_advance a on a.id=s.salary_advance_id where a.id=any($1::uuid[]) order by a.advance_number,s.installment_number",[[adv1,adv2]]);
  assert.equal(sched.rowCount,4);
  assert.deepEqual(sched.rows.map(x=>x.amount),["150.00","150.00","100.00","100.00"]);

  const oct=await payroll("CI7-PAY-OCT-"+suffix,"2026-10-01","2026-10-31","2026-10-31");
  const octItems=await client.query("select * from payroll_run_item where payroll_run_id=$1 order by employee_id",[oct]);
  assert.equal(octItems.rowCount,3);
  const ai=octItems.rows.find(x=>x.employee_id===alice);
  const bi=octItems.rows.find(x=>x.employee_id===bob);
  const ci=octItems.rows.find(x=>x.employee_id===carol);
  assert.equal(ai.salary_agreement_id,salary1000);
  assert.equal(ai.base_salary,"1000.00","October payroll must use new 1,000 salary without changing September history");
  await client.query("insert into payroll_adjustment(payroll_run_item_id,adjustment_type,description,amount) values ($1,'allowance','Class lead allowance',100),($1,'bonus','Performance bonus',200),($2,'deduction','Attendance deduction',100)",[ai.id,bi.id]);
  await client.query("update payroll_run set status='pending',submitted_at=now() where id=$1",[oct]);
  await expectFailure("Adjustments must freeze after submission",()=>client.query("insert into payroll_adjustment(payroll_run_item_id,adjustment_type,description,amount) values ($1,'bonus','Late change',1)",[ai.id]));
  await client.query("update payroll_run set status='approved',approved_at=now() where id=$1",[oct]);
  const octJournal=(await client.query("select lock_payroll_run($1,null) id",[oct])).rows[0].id;
  assert.ok(octJournal);

  const locked=await client.query("select i.*,e.first_name from payroll_run_item i join employee e on e.id=i.employee_id where i.payroll_run_id=$1 order by e.first_name",[oct]);
  const la=locked.rows.find(x=>x.employee_id===alice),lb=locked.rows.find(x=>x.employee_id===bob),lc=locked.rows.find(x=>x.employee_id===carol);
  assert.equal(la.allowance_total,"100.00");
  assert.equal(la.bonus_total,"200.00");
  assert.equal(la.gross_pay,"1300.00");
  assert.equal(la.net_pay,"1300.00");
  assert.equal(lb.deduction_total,"100.00");
  assert.equal(lb.payroll_expense,"800.00");
  assert.equal(lb.net_pay,"800.00");
  assert.equal(lc.advance_repayment_total,"250.00","Two advance schedules must both repay in the same payroll run");
  assert.equal(lc.net_pay,"550.00");
  const allocations=await client.query("select count(*)::int n,sum(x.amount)::numeric(14,2)::text total from salary_advance_repayment_allocation x where x.payroll_run_item_id=$1",[lc.id]);
  assert.equal(allocations.rows[0].n,2);
  assert.equal(allocations.rows[0].total,"250.00");

  const summary=(await client.query("select * from payroll_run_summary where id=$1",[oct])).rows[0];
  assert.equal(summary.allowances,"100.00");
  assert.equal(summary.bonuses,"200.00");
  assert.equal(summary.deductions,"100.00");
  assert.equal(summary.advance_repayments,"250.00");
  assert.equal(summary.payroll_expense,"2900.00");
  assert.equal(summary.net_pay,"2650.00");
  assert.equal(await balance(payable),"2650.00","Locking payroll must create salary payable");
  assert.equal(await balance(advanceAsset),"250.00","Payroll repayments must reduce salary advance asset");
  assert.equal(await balance(expense),"3700.00","Payroll expense must include September plus October");
  await expectFailure("Locked payroll dates must be immutable",()=>client.query("update payroll_run set pay_date='2026-11-01' where id=$1",[oct]));

  const octPayment=await pay("CI7-PPAY-OCT-"+suffix,oct,bank,"2026-10-31");
  assert.equal(octPayment.amount,"2650.00");
  assert.equal(await balance(payable),"0.00","Payroll payment must clear Salary Payable");
  assert.equal(await balance(bank),"46050.00","Bank must reflect opening less September payroll, advances and October payroll");
  assert.equal((await client.query("select status from payroll_run where id=$1",[oct])).rows[0].status,"paid");

  const ledger=await client.query("select event_type,count(*)::int n from employee_payroll_ledger where employee_id=any($1::uuid[]) group by event_type",[[alice,bob,carol]]);
  const events=Object.fromEntries(ledger.rows.map(x=>[x.event_type,x.n]));
  assert.equal(events.salary_advance,2);
  assert.equal(events.payroll_locked,4);
  assert.equal(events.payroll_paid,4);
  const tb=await client.query("select sum(debit_balance)::numeric(14,2)::text debit,sum(credit_balance)::numeric(14,2)::text credit from trial_balance where currency='USD'");
  assert.equal(tb.rows[0].debit,tb.rows[0].credit,"Step 7 trial balance must balance");

  console.log("Step 7 employees/payroll verification passed.");
  console.log("Milestone 7: preserved Alice salary history 800 -> 1,000; ran September normal payroll and October payroll for three employees with allowance, bonus, deduction, two simultaneous advance repayments, payroll approval/locking, payslip-ready snapshots, Salary Payable, bank payment, employee ledger, payroll report and balanced general ledger.");
  console.log("October payroll: gross 3,000.00; deductions 100.00; payroll expense 2,900.00; advance repayments 250.00; net salary payable/payment 2,650.00. Final salary payable 0.00; remaining salary advances 250.00.");
  await client.query("rollback");
}catch(error){try{await client.query("rollback");}catch{}throw error;}finally{client.release();await pool.end();}
