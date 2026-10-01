"use server";

import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";
import { amt,bad,cur,day,good,id,integer,nextNo,openPeriod,payrollReady,v } from "./action-utils";

export async function createSalaryAdvanceAction(d:FormData){
  const a=await requirePermission("salary_advances.manage"),employee=id(v(d,"employee_id"),"employee"),advanceDate=day(v(d,"advance_date"),"advance date"),amount=amt(v(d,"amount"),"advance amount"),currency=cur(v(d,"currency")),payment=id(v(d,"payment_account_id"),"payment account"),installments=integer(v(d,"installments_count"),"Installments",1,120),first=day(v(d,"first_repayment_on"),"first repayment date");
  await withTransaction(async c=>{await payrollReady(c,advanceDate,["salary_advance"]);if(!(await c.query("select 1 from employee where id=$1 and status<>'inactive'",[employee])).rowCount)bad("Employee is not payroll eligible.");const number=await nextNo(c,"salary_advance",a.userId);const r=await c.query<{id:string}>("insert into salary_advance(advance_number,employee_id,advance_date,amount,currency,payment_account_id,installments_count,first_repayment_on,reference,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[number,employee,advanceDate,amount,currency,payment,installments,first,v(d,"reference")||null,v(d,"notes")||null,a.userId]);await c.query("select generate_salary_advance_schedule($1,$2)",[r.rows[0].id,a.userId]);await c.query("select accounting_post_salary_advance($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"salary_advance_posted",entityType:"salary_advance",entityId:r.rows[0].id,after:{advanceNumber:number,employeeId:employee,amount,currency,installments,firstRepaymentOn:first}});});good("Salary advance paid and repayment schedule created.");
}

export async function reverseSalaryAdvanceAction(d:FormData){
  const a=await requirePermission("salary_advances.manage"),advance=id(v(d,"salary_advance_id"),"salary advance"),date=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await openPeriod(c,date);const before=(await c.query("select * from salary_advance where id=$1 for update",[advance])).rows[0];if(!before)bad("Salary advance not found.");await c.query("select reverse_salary_advance($1,$2,$3,$4)",[advance,date,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"salary_advance_reversed",entityType:"salary_advance",entityId:advance,before,after:{status:"reversed",reason,reversalDate:date}});});good("Salary advance reversed.");
}
