import { query } from "@/lib/db";
import { requirePermission } from "@/lib/security";
import {
  acknowledgeNotificationAction,
  createEmployeeDocumentExpiryAction,
  dismissNotificationAction,
  reopenNotificationAction,
  runNotificationRefreshAction,
  snoozeNotificationAction,
  updateEmployeeDocumentExpiryStatusAction,
  updateNotificationRuleAction,
} from "./actions";

type Rule={
  rule_key:string;label:string;category:string;enabled:boolean;lead_days:number;severity:string;description:string;
};
type Notification={
  id:string;rule_key:string;rule_label:string;category:string;source_type:string;source_id:string;
  due_on:Date|null;severity:string;title:string;message:string;recipient_email:string|null;
  status:string;snoozed_until:Date|null;first_detected_on:Date;last_detected_on:Date;
};
type Employee={id:string;employee_number:string;first_name:string;last_name:string};
type EmployeeDoc={
  id:string;employee_id:string;employee_number:string;employee_name:string;document_name:string;
  document_number:string|null;expires_on:Date;status:string;
};

function dateValue(value:Date|string|null){
  if(!value)return "";
  const d=value instanceof Date?value:new Date(value);
  return d.toISOString().slice(0,10);
}
function dueLabel(value:Date|null){
  if(!value)return "No date";
  return dateValue(value);
}

export default async function NotificationsPage({
  searchParams,
}:{
  searchParams:Promise<{error?:string;success?:string;status?:string}>;
}){
  const auth=await requirePermission("notifications.view");
  const {error,success,status}=await searchParams;
  const canManage=auth.permissions.includes("notifications.manage");
  const canRun=auth.permissions.includes("notifications.run");

  const rules=(await query<Rule>(
    "select rule_key,label,category,enabled,lead_days,severity,description from notification_rule order by category,label",
  )).rows;

  const filter=status&&["open","snoozed","acknowledged","dismissed","resolved"].includes(status)?status:"active";
  const notifications=(await query<Notification>(
    `select n.id,n.rule_key,r.label as rule_label,r.category,n.source_type,n.source_id,n.due_on,
       n.severity,n.title,n.message,n.recipient_email,n.status,n.snoozed_until,
       n.first_detected_on,n.last_detected_on
     from system_notification n
     join notification_rule r on r.rule_key=n.rule_key
     where ($1='active' and n.status in ('open','snoozed')) or ($1<>'active' and n.status=$1)
     order by
       case n.severity when 'critical' then 1 when 'warning' then 2 else 3 end,
       n.due_on nulls last,n.created_at desc
     limit 250`,
    [filter],
  )).rows;

  const counts=(await query<{status:string;count:string}>(
    "select status,count(*)::text as count from system_notification group by status",
  )).rows;
  const countMap=new Map(counts.map(x=>[x.status,Number(x.count)]));

  const employees=canManage?(await query<Employee>(
    "select id,employee_number,first_name,last_name from employee where status<>'terminated' order by last_name,first_name",
  )).rows:[];

  const employeeDocs=canManage?(await query<EmployeeDoc>(
    `select d.id,d.employee_id,e.employee_number,
       e.first_name||' '||e.last_name as employee_name,
       d.document_name,d.document_number,d.expires_on,d.status
     from employee_document_expiry d
     join employee e on e.id=d.employee_id
     order by d.expires_on,d.document_name`,
  )).rows:[];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Step 12</p>
          <h1>Notifications & Automation</h1>
          <p className="muted">
            Alerts are recalculated from billing, supplier, rental, payroll, academic, inventory and employee records.
          </p>
        </div>
        <div className="top-actions">
          <a className="button-link" href="/dashboard">Dashboard</a>
          {canRun?(
            <form action={runNotificationRefreshAction}>
              <button type="submit">Refresh now</button>
            </form>
          ):null}
        </div>
      </header>

      {error?<div className="notice error">{error}</div>:null}
      {success?<div className="notice success">{success}</div>:null}

      <section className="status-grid">
        <article className="panel">
          <p className="eyebrow">Needs attention</p>
          <h2>{(countMap.get("open")??0)+(countMap.get("snoozed")??0)}</h2>
          <p className="muted">Open or snoozed notifications.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Acknowledged</p>
          <h2>{countMap.get("acknowledged")??0}</h2>
          <p className="muted">Seen and accepted by staff.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Auto-resolved</p>
          <h2>{countMap.get("resolved")??0}</h2>
          <p className="muted">Underlying source condition is no longer active.</p>
        </article>
      </section>

      <section className="panel section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Notification center</p>
            <h2>Current alerts</h2>
          </div>
          <div className="top-actions">
            {["active","open","snoozed","acknowledged","dismissed","resolved"].map(x=>(
              <a key={x} className="button-link" href={"/notifications?status="+x}>{x}</a>
            ))}
          </div>
        </div>

        {notifications.length===0?(
          <p className="muted">No notifications match this view.</p>
        ):(
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th><th>Notification</th><th>Due</th><th>Status</th><th>Recipient</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map(n=>(
                  <tr key={n.id}>
                    <td><span className="badge">{n.severity}</span></td>
                    <td>
                      <strong>{n.title}</strong>
                      <div className="muted">{n.message}</div>
                      <div className="muted">{n.rule_label} · {n.source_type}</div>
                    </td>
                    <td>{dueLabel(n.due_on)}</td>
                    <td>{n.status}{n.snoozed_until?" until "+dueLabel(n.snoozed_until):""}</td>
                    <td>{n.recipient_email??"Staff / in-app"}</td>
                    <td>
                      {canManage?(
                        <div className="top-actions">
                          {n.status!=="acknowledged"?(
                            <form action={acknowledgeNotificationAction}>
                              <input type="hidden" name="notification_id" value={n.id}/>
                              <button className="secondary" type="submit">Acknowledge</button>
                            </form>
                          ):null}
                          {n.status!=="dismissed"?(
                            <form action={dismissNotificationAction}>
                              <input type="hidden" name="notification_id" value={n.id}/>
                              <button className="secondary" type="submit">Dismiss</button>
                            </form>
                          ):null}
                          {["acknowledged","dismissed","resolved"].includes(n.status)?(
                            <form action={reopenNotificationAction}>
                              <input type="hidden" name="notification_id" value={n.id}/>
                              <button className="secondary" type="submit">Reopen</button>
                            </form>
                          ):null}
                          {n.status==="open"?(
                            <form action={snoozeNotificationAction}>
                              <input type="hidden" name="notification_id" value={n.id}/>
                              <input name="snoozed_until" type="date" required aria-label="Snooze until"/>
                              <button className="secondary" type="submit">Snooze</button>
                            </form>
                          ):null}
                        </div>
                      ):null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Rules</p>
            <h2>Lead times & severity</h2>
          </div>
          {!canManage?<span className="badge">Read only</span>:null}
        </div>
        <div className="card-grid">
          {rules.map(r=>(
            <article className="panel" key={r.rule_key}>
              <p className="eyebrow">{r.category}</p>
              <h3>{r.label}</h3>
              <p className="muted">{r.description}</p>
              <form action={updateNotificationRuleAction} className="form-grid">
                <input type="hidden" name="rule_key" value={r.rule_key}/>
                <label>
                  Lead days
                  <input type="number" min="0" max="365" name="lead_days" defaultValue={r.lead_days} disabled={!canManage}/>
                </label>
                <label>
                  Severity
                  <select name="severity" defaultValue={r.severity} disabled={!canManage}>
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <label>
                  Enabled
                  <input type="checkbox" name="enabled" defaultChecked={r.enabled} disabled={!canManage}/>
                </label>
                {canManage?<button type="submit">Save rule</button>:null}
              </form>
            </article>
          ))}
        </div>
      </section>

      {canManage?(
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Employees</p>
              <h2>Document expiry tracking</h2>
            </div>
          </div>
          <form action={createEmployeeDocumentExpiryAction} className="form-grid">
            <label>
              Employee
              <select name="employee_id" required>
                <option value="">Select employee</option>
                {employees.map(e=>(
                  <option key={e.id} value={e.id}>{e.employee_number} · {e.first_name} {e.last_name}</option>
                ))}
              </select>
            </label>
            <label>
              Document
              <input name="document_name" placeholder="Residence permit, first aid certificate…" required/>
            </label>
            <label>
              Document number
              <input name="document_number"/>
            </label>
            <label>
              Expires on
              <input type="date" name="expires_on" required/>
            </label>
            <label className="span-2">
              Notes
              <input name="notes"/>
            </label>
            <button type="submit">Add expiry</button>
          </form>

          {employeeDocs.length?(
            <div className="table-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Document</th><th>Number</th><th>Expires</th><th>Status</th><th>Update</th></tr></thead>
                <tbody>
                  {employeeDocs.map(d=>(
                    <tr key={d.id}>
                      <td>{d.employee_number} · {d.employee_name}</td>
                      <td>{d.document_name}</td>
                      <td>{d.document_number??"—"}</td>
                      <td>{dueLabel(d.expires_on)}</td>
                      <td>{d.status}</td>
                      <td>
                        <form action={updateEmployeeDocumentExpiryStatusAction} className="top-actions">
                          <input type="hidden" name="document_id" value={d.id}/>
                          <select name="status" defaultValue={d.status}>
                            <option value="active">Active</option>
                            <option value="renewed">Renewed</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                          <button className="secondary" type="submit">Save</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ):<p className="muted">No employee document expiries recorded yet.</p>}
        </section>
      ):null}
    </main>
  );
}
