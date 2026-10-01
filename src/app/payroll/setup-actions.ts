"use server";

import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";
import { PAYROLL_ROLES,bad,good,id,v } from "./action-utils";

export async function configurePayrollJournalAction(d:FormData){
  const a=await requirePermission("accounting.mapping"),journal=id(v(d,"journal_id"),"journal");
  await withTransaction(async c=>{if(!(await c.query("select 1 from journal where id=$1 and status='active'",[journal])).rowCount)bad("Select an active journal.");const before=(await c.query("select payroll_journal_id from accounting_configuration where id=1 for update")).rows[0];await c.query("update accounting_configuration set payroll_journal_id=$1,updated_at=now(),updated_by=$2 where id=1",[journal,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_journal_configured",entityType:"accounting_configuration",entityId:"1",before,after:{payrollJournalId:journal}});});
  good("Payroll journal configured.");
}

export async function configurePayrollMappingAction(d:FormData){
  const a=await requirePermission("accounting.mapping"),role=v(d,"role_key"),account=id(v(d,"account_id"),"account");if(!PAYROLL_ROLES.has(role))bad("Invalid payroll accounting role.");
  await withTransaction(async c=>{const before=(await c.query("select role_key,account_id from accounting_mapping where role_key=$1 for update",[role])).rows[0]??null;await c.query("insert into accounting_mapping(role_key,account_id,updated_by) values ($1,$2,$3) on conflict (role_key) do update set account_id=excluded.account_id,updated_at=now(),updated_by=excluded.updated_by",[role,account,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"payroll_accounting_mapping_updated",entityType:"accounting_mapping",entityId:role,before,after:{roleKey:role,accountId:account}});});
  good("Payroll accounting mapping saved.");
}
