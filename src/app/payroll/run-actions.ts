"use server";

import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";
import { amt,bad,cur,day,good,id,nextNo,openPeriod,payrollReady,v } from "./action-utils";

export async function createPayrollRunAction(d:FormData){
  const a=await requirePermission("payroll.manage"),start=day(v(d,"period_start"),"period start"),end=day(v(d,"period_end"),"period end"),payDate=day(v(d,"pay_date"),"pay date"),currency=cur(v(d,"currency"));if(end<start)bad("Period end cannot be before period start.");
  await withTransaction(async c=>{const number=await nextNo(c,"payroll_run",a.userId);const r=await c.query<{id:string}>("insert into payroll_run(run_number,period_start,period_end,pay_date,currency,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id",[number,start,end,payDate,currency,v(d,"notes")||null,a.userId]);const populated=await c.query<{count:number}>("select populate_payroll_run($1,$2)::int as count",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_run_created",entityType:"payroll_run",entityId:r.rows[0].id,after:{runNumber:number,periodStart:start,periodEnd:end,payDate,currency,employees:populated.rows[0]?.count??0}});});good("Payroll run created with salary snapshots.");
}

export async function addPayrollAdjustmentAction(d:FormData){
  const a=await requirePermission("payroll.manage"),item=id(v(d,"payroll_run_item_id"),"payroll item"),type=v(d,"adjustment_type"),description=v(d,"description"),amount=amt(v(d,"amount"),"adjustment amount");if(!["allowance","bonus","deduction"].includes(type))bad("Invalid adjustment type.");if(!description)bad("Adjustment description is required.");
  await withTransaction(async c=>{const r=await c.query<{id:string}>("insert into payroll_adjustment(payroll_run_item_id,adjustment_type,description,amount,created_by) values ($1,$2,$3,$4,$5) returning id",[item,type,description,amount,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_adjustment_added",entityType:"payroll_adjustment",entityId:r.rows[0].id,after:{payrollRunItemId:item,type,description,amount}});});good("Payroll adjustment added.");
}

export async function removePayrollAdjustmentAction(d:FormData){
  const a=await requirePermission("payroll.manage"),adjustment=id(v(d,"payroll_adjustment_id"),"payroll adjustment");
  await withTransaction(async c=>{const before=(await c.query("select * from payroll_adjustment where id=$1",[adjustment])).rows[0];if(!before)bad("Payroll adjustment not found.");await c.query("delete from payroll_adjustment where id=$1",[adjustment]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_adjustment_removed",entityType:"payroll_adjustment",entityId:adjustment,before});});good("Payroll adjustment removed.");
}

export async function submitPayrollRunAction(d:FormData){
  const a=await requirePermission("payroll.manage"),run=id(v(d,"payroll_run_id"),"payroll run");
  await withTransaction(async c=>{const before=(await c.query("select * from payroll_run where id=$1 for update",[run])).rows[0];if(!before||before.status!=="draft")bad("Only draft payroll can be submitted.");await c.query("update payroll_run set status='pending',submitted_at=now(),submitted_by=$2 where id=$1",[run,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_run_submitted",entityType:"payroll_run",entityId:run,before,after:{status:"pending"}});});good("Payroll run submitted for approval.");
}

export async function approvePayrollRunAction(d:FormData){
  const a=await requirePermission("payroll.approve"),run=id(v(d,"payroll_run_id"),"payroll run");
  await withTransaction(async c=>{const before=(await c.query("select * from payroll_run where id=$1 for update",[run])).rows[0];if(!before||before.status!=="pending")bad("Only pending payroll can be approved.");await c.query("update payroll_run set status='approved',approved_at=now(),approved_by=$2 where id=$1",[run,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_run_approved",entityType:"payroll_run",entityId:run,before,after:{status:"approved"}});});good("Payroll run approved.");
}

export async function returnPayrollRunToDraftAction(d:FormData){
  const a=await requirePermission("payroll.approve"),run=id(v(d,"payroll_run_id"),"payroll run"),reason=v(d,"reason");if(!reason)bad("Return reason is required.");
  await withTransaction(async c=>{const before=(await c.query("select * from payroll_run where id=$1 for update",[run])).rows[0];if(!before||!["pending","approved"].includes(before.status))bad("Only pending or approved payroll can return to draft.");await c.query("update payroll_run set status='draft',submitted_at=null,submitted_by=null,approved_at=null,approved_by=null where id=$1",[run]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_run_returned_to_draft",entityType:"payroll_run",entityId:run,before,after:{status:"draft",reason}});});good("Payroll run returned to draft.");
}

export async function lockPayrollRunAction(d:FormData){
  const a=await requirePermission("payroll.lock"),run=id(v(d,"payroll_run_id"),"payroll run");
  await withTransaction(async c=>{const before=(await c.query("select * from payroll_run where id=$1 for update",[run])).rows[0];if(!before||before.status!=="approved")bad("Only approved payroll can be locked.");await payrollReady(c,String(before.pay_date).slice(0,10),["payroll_expense","salary_payable","salary_advance"]);await c.query("select lock_payroll_run($1,$2)",[run,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_run_locked",entityType:"payroll_run",entityId:run,before,after:{status:"locked"}});});good("Payroll locked and posted to the general ledger.");
}

export async function payPayrollRunAction(d:FormData){
  const a=await requirePermission("payroll.pay"),run=id(v(d,"payroll_run_id"),"payroll run"),payment=id(v(d,"payment_account_id"),"payment account"),paidOn=day(v(d,"paid_on"),"payment date"),method=v(d,"method"),cheque=v(d,"cheque_number");if(!["cash","bank_transfer","check","other"].includes(method))bad("Invalid payroll payment method.");if(method==="check"&&!cheque)bad("Cheque number is required.");
  await withTransaction(async c=>{const pr=(await c.query<{currency:string;status:string;amount:string}>("select r.currency,r.status,coalesce(sum(i.net_pay),0)::numeric(14,2)::text as amount from payroll_run r join payroll_run_item i on i.payroll_run_id=r.id where r.id=$1 group by r.id",[run])).rows[0];if(!pr||pr.status!=="locked")bad("Only locked payroll can be paid.");await payrollReady(c,paidOn,["salary_payable"]);if(Number(pr.amount)<=0)bad("Payroll has no net amount to pay.");const number=await nextNo(c,"payroll_payment",a.userId);const r=await c.query<{id:string}>("insert into payroll_payment(payment_number,payroll_run_id,payment_account_id,amount,currency,paid_on,method,cheque_number,cheque_due_on,reference,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id",[number,run,payment,pr.amount,pr.currency,paidOn,method,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,v(d,"notes")||null,a.userId]);await c.query("select accounting_post_payroll_payment($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_payment_posted",entityType:"payroll_payment",entityId:r.rows[0].id,after:{paymentNumber:number,payrollRunId:run,amount:pr.amount,currency:pr.currency,paidOn,paymentAccountId:payment}});});good("Payroll paid and Salary Payable cleared.");
}

export async function reversePayrollPaymentAction(d:FormData){
  const a=await requirePermission("payroll.pay"),payment=id(v(d,"payroll_payment_id"),"payroll payment"),date=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await openPeriod(c,date);const before=(await c.query("select * from payroll_payment where id=$1 for update",[payment])).rows[0];if(!before||before.status!=="posted")bad("Only posted payroll payments can be reversed.");await c.query("select reverse_payroll_payment($1,$2,$3,$4)",[payment,date,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_payment_reversed",entityType:"payroll_payment",entityId:payment,before,after:{status:"reversed",reason,reversalDate:date}});});good("Payroll payment reversed. The payroll run remains locked and can be paid again.");
}
