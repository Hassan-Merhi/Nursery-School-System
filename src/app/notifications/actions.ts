"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function bad(m:string):never{redirect("/notifications?error="+encodeURIComponent(m));}
function good(m:string):never{
  revalidatePath("/notifications");
  revalidatePath("/dashboard");
  redirect("/notifications?success="+encodeURIComponent(m));
}
function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
function day(raw:string,label:string){
  if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");
  return raw;
}

export async function runNotificationRefreshAction(){
  const a=await requirePermission("notifications.run");
  const result=await query<{open_count:number;newly_detected:number;resolved_count:number}>(
    "select * from refresh_system_notifications(current_date,$1)",
    [a.userId],
  );
  const row=result.rows[0]??{open_count:0,newly_detected:0,resolved_count:0};
  good(`Refresh complete: ${row.open_count} active, ${row.newly_detected} new, ${row.resolved_count} resolved.`);
}

export async function updateNotificationRuleAction(d:FormData){
  const a=await requirePermission("notifications.manage");
  const rule=v(d,"rule_key");
  const enabled=v(d,"enabled")==="on";
  const lead=Number(v(d,"lead_days"));
  const severity=v(d,"severity");
  if(!rule)bad("Notification rule is required.");
  if(!Number.isInteger(lead)||lead<0||lead>365)bad("Lead days must be between 0 and 365.");
  if(!["info","warning","critical"].includes(severity))bad("Invalid severity.");

  await withTransaction(async c=>{
    const before=(await c.query("select * from notification_rule where rule_key=$1 for update",[rule])).rows[0];
    if(!before)bad("Notification rule not found.");
    await c.query(
      "update notification_rule set enabled=$2,lead_days=$3,severity=$4,updated_at=now(),updated_by=$5 where rule_key=$1",
      [rule,enabled,lead,severity,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"notification_rule_updated",entityType:"notification_rule",entityId:rule,before,after:{enabled,leadDays:lead,severity}});
  });
  await query("select * from refresh_system_notifications(current_date,$1)",[a.userId]);
  good("Notification rule updated.");
}

async function mutateNotification(d:FormData,next:"acknowledged"|"dismissed"|"open"|"snoozed"){
  const a=await requirePermission("notifications.manage");
  const notification=id(v(d,"notification_id"),"notification");
  const snoozedUntil=next==="snoozed"?day(v(d,"snoozed_until"),"snooze date"):null;

  await withTransaction(async c=>{
    const before=(await c.query("select * from system_notification where id=$1 for update",[notification])).rows[0];
    if(!before)bad("Notification not found.");

    if(next==="acknowledged"){
      await c.query(
        "update system_notification set status='acknowledged',acknowledged_at=now(),acknowledged_by=$2,snoozed_until=null,updated_at=now() where id=$1",
        [notification,a.userId],
      );
    }else if(next==="dismissed"){
      await c.query(
        "update system_notification set status='dismissed',dismissed_at=now(),dismissed_by=$2,snoozed_until=null,updated_at=now() where id=$1",
        [notification,a.userId],
      );
    }else if(next==="snoozed"){
      await c.query(
        "update system_notification set status='snoozed',snoozed_until=$2,updated_at=now() where id=$1",
        [notification,snoozedUntil],
      );
    }else{
      await c.query(
        "update system_notification set status='open',snoozed_until=null,acknowledged_at=null,acknowledged_by=null,dismissed_at=null,dismissed_by=null,updated_at=now() where id=$1",
        [notification],
      );
    }
    await writeAudit(c,{actorUserId:a.userId,action:"notification_status_changed",entityType:"system_notification",entityId:notification,before,after:{status:next,snoozedUntil}});
  });
  good("Notification updated.");
}

export async function acknowledgeNotificationAction(d:FormData){return mutateNotification(d,"acknowledged");}
export async function dismissNotificationAction(d:FormData){return mutateNotification(d,"dismissed");}
export async function reopenNotificationAction(d:FormData){return mutateNotification(d,"open");}
export async function snoozeNotificationAction(d:FormData){return mutateNotification(d,"snoozed");}

export async function createEmployeeDocumentExpiryAction(d:FormData){
  const a=await requirePermission("notifications.manage");
  const employee=id(v(d,"employee_id"),"employee");
  const name=v(d,"document_name");
  const number=v(d,"document_number")||null;
  const expires=day(v(d,"expires_on"),"expiry date");
  const notes=v(d,"notes")||null;
  if(!name)bad("Document name is required.");

  await withTransaction(async c=>{
    if(!(await c.query("select 1 from employee where id=$1 and status<>'terminated'",[employee])).rowCount)bad("Select an active employee.");
    const r=await c.query<{id:string}>(
      "insert into employee_document_expiry(employee_id,document_name,document_number,expires_on,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id",
      [employee,name,number,expires,notes,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"employee_document_expiry_created",entityType:"employee_document_expiry",entityId:r.rows[0].id,after:{employeeId:employee,documentName:name,expiresOn:expires}});
  });
  await query("select * from refresh_system_notifications(current_date,$1)",[a.userId]);
  good("Employee document expiry added.");
}

export async function updateEmployeeDocumentExpiryStatusAction(d:FormData){
  const a=await requirePermission("notifications.manage");
  const document=id(v(d,"document_id"),"employee document");
  const status=v(d,"status");
  if(!["active","renewed","cancelled"].includes(status))bad("Invalid document status.");

  await withTransaction(async c=>{
    const before=(await c.query("select * from employee_document_expiry where id=$1 for update",[document])).rows[0];
    if(!before)bad("Employee document not found.");
    await c.query(
      "update employee_document_expiry set status=$2,updated_at=now(),updated_by=$3 where id=$1",
      [document,status,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"employee_document_expiry_status_changed",entityType:"employee_document_expiry",entityId:document,before,after:{status}});
  });
  await query("select * from refresh_system_notifications(current_date,$1)",[a.userId]);
  good("Employee document status updated.");
}
