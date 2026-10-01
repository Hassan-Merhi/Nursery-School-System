"use server";

import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";
import { amt,bad,cur,day,good,id,oid,v,nextNo } from "./action-utils";

export async function createJobTitleAction(d:FormData){
  const a=await requirePermission("employees.manage"),name=v(d,"name");if(!name)bad("Job title is required.");
  await withTransaction(async c=>{const r=await c.query<{id:string}>("insert into job_title(name,description,created_by,updated_by) values ($1,$2,$3,$3) returning id",[name,v(d,"description")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"job_title_created",entityType:"job_title",entityId:r.rows[0].id,after:{name}});});good("Job title created.");
}

export async function updateJobTitleAction(d:FormData){
  const a=await requirePermission("employees.manage"),job=id(v(d,"job_title_id"),"job title"),name=v(d,"name"),status=v(d,"status");if(!name)bad("Job title is required.");if(!["active","inactive"].includes(status))bad("Invalid job title status.");
  await withTransaction(async c=>{const before=(await c.query("select * from job_title where id=$1 for update",[job])).rows[0];if(!before)bad("Job title not found.");await c.query("update job_title set name=$2,description=$3,status=$4,updated_at=now(),updated_by=$5 where id=$1",[job,name,v(d,"description")||null,status,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"job_title_updated",entityType:"job_title",entityId:job,before,after:{name,status}});});good("Job title updated.");
}

export async function createEmployeeAction(d:FormData){
  const a=await requirePermission("employees.manage"),first=v(d,"first_name"),last=v(d,"last_name"),job=oid(v(d,"job_title_id"),"job title"),start=day(v(d,"start_on"),"start date");if(!first||!last)bad("Employee first and last name are required.");
  await withTransaction(async c=>{const number=await nextNo(c,"employee",a.userId);const r=await c.query<{id:string}>("insert into employee(employee_number,first_name,last_name,job_title_id,email,phone,address,start_on,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id",[number,first,last,job,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,start,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"employee_created",entityType:"employee",entityId:r.rows[0].id,after:{employeeNumber:number,firstName:first,lastName:last,startOn:start}});});good("Employee created.");
}

export async function updateEmployeeAction(d:FormData){
  const a=await requirePermission("employees.manage"),employee=id(v(d,"employee_id"),"employee"),first=v(d,"first_name"),last=v(d,"last_name"),job=oid(v(d,"job_title_id"),"job title"),start=day(v(d,"start_on"),"start date"),status=v(d,"status"),endRaw=v(d,"end_on");if(!first||!last)bad("Employee first and last name are required.");if(!["active","inactive","terminated"].includes(status))bad("Invalid employee status.");const end=endRaw?day(endRaw,"end date"):null;if(end&&end<start)bad("End date cannot be before start date.");if(status==="terminated"&&!end)bad("Terminated employees require an end date.");
  await withTransaction(async c=>{const before=(await c.query("select * from employee where id=$1 for update",[employee])).rows[0];if(!before)bad("Employee not found.");await c.query("update employee set first_name=$2,last_name=$3,job_title_id=$4,email=$5,phone=$6,address=$7,start_on=$8,end_on=$9,status=$10,notes=$11,updated_at=now(),updated_by=$12 where id=$1",[employee,first,last,job,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,start,end,status,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"employee_updated",entityType:"employee",entityId:employee,before,after:{firstName:first,lastName:last,startOn:start,endOn:end,status}});});good("Employee updated.");
}

export async function createSalaryAgreementAction(d:FormData){
  const a=await requirePermission("employees.manage"),employee=id(v(d,"employee_id"),"employee"),effective=day(v(d,"effective_from"),"effective date"),salary=amt(v(d,"monthly_salary"),"monthly salary"),currency=cur(v(d,"currency"));
  await withTransaction(async c=>{const e=(await c.query<{start_on:string}>("select start_on::text from employee where id=$1",[employee])).rows[0];if(!e)bad("Employee not found.");if(effective<String(e.start_on).slice(0,10))bad("Salary agreement cannot start before employment.");const r=await c.query<{id:string}>("insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency,notes,created_by) values ($1,$2,$3,$4,$5,$6) returning id",[employee,effective,salary,currency,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"salary_agreement_created",entityType:"employee_salary_agreement",entityId:r.rows[0].id,after:{employeeId:employee,effectiveFrom:effective,monthlySalary:salary,currency}});});good("New salary agreement added. Earlier salary history was preserved.");
}
