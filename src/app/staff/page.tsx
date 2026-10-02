import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { createEmployeeAction } from "@/app/payroll/employee-actions";

type Row = Record<string, any>;
function iso(value: unknown) { return String(value ?? "").slice(0,10); }
function money(value: unknown, currency="USD") {
  const n=Number(value??0);
  try { return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0); }
  catch { return currency+" "+(Number.isFinite(n)?n:0).toFixed(2); }
}

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{error?:string;success?:string;q?:string}>;
}) {
  const auth=await requireUser();
  const {error,success,q=""}=await searchParams;
  const can=(permission:string)=>auth.permissions.includes(permission);
  const allowed=["employees.view","employees.manage","payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage"].some(can);
  if(!allowed) redirect("/forbidden");

  const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today??new Date().toISOString().slice(0,10);
  const currency=(await query<{currency:string|null}>("select value #>> '{}' currency from app_setting where key='currency'")).rows[0]?.currency??"USD";
  const jobs=(can("employees.manage") ? await query<Row>("select * from job_title where status='active' order by name") : {rows:[] as Row[]}).rows;
  const employees=(await query<Row>(
    `select e.*,j.name job_title,
       s.monthly_salary current_salary,s.currency salary_currency,s.effective_from salary_effective_from,
       coalesce((select sum(b.outstanding_amount) from salary_advance_balance b where b.employee_id=e.id and b.status='posted'),0)::numeric(14,2) outstanding_advance,
       (select r.run_number from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id where i.employee_id=e.id order by r.period_end desc,r.created_at desc limit 1) latest_run,
       (select r.status from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id where i.employee_id=e.id order by r.period_end desc,r.created_at desc limit 1) latest_payroll_status
     from employee e left join job_title j on j.id=e.job_title_id
     left join lateral (
       select * from employee_salary_agreement x
       where x.employee_id=e.id and x.effective_from<=$1
       order by x.effective_from desc limit 1
     ) s on true
     where ($2='' or e.employee_number ilike '%'||$2||'%' or concat_ws(' ',e.first_name,e.last_name) ilike '%'||$2||'%' or j.name ilike '%'||$2||'%')
     order by case e.status when 'active' then 1 else 2 end,e.last_name,e.first_name`,
    [today,String(q).trim()],
  )).rows;
  const runs=(await query<Row>("select * from payroll_run_summary order by period_end desc,run_number desc limit 12")).rows;
  const currentRuns=runs.filter((r)=>r.status!=="paid");
  const current=currentRuns[0]??runs[0]??null;
  const active=employees.filter((e)=>e.status==="active");

  return <main className="app-shell staff-workspace">
    <header className="topbar">
      <div><p className="eyebrow">Staff</p><h1>Employees & current payroll</h1><p className="muted">Open an employee to manage salary, advances, payroll history and payslips. Detailed posting controls stay in Advanced payroll.</p></div>
      <div className="top-actions">{can("payroll.view")||can("payroll.manage")?<Link className="button-link secondary-link" href="/payroll">Advanced payroll</Link>:null}</div>
    </header>
    {error?<div className="notice error">{error}</div>:null}{success?<div className="notice success">{success}</div>:null}

    <section className="money-summary-grid">
      <article className="panel"><p className="eyebrow">Active employees</p><h2>{active.length}</h2><p className="muted">{employees.length} employee records shown.</p></article>
      <article className="panel"><p className="eyebrow">Current payroll</p><h2>{current?current.run_number:"—"}</h2><p className="muted">{current?`${iso(current.period_start)} → ${iso(current.period_end)} · ${current.status}`:"No payroll runs yet."}</p></article>
      <article className="panel"><p className="eyebrow">Current net payroll</p><h2>{current?money(current.net_pay,current.currency):"—"}</h2><p className="muted">{current?`Pay date ${iso(current.pay_date)}`:"Create a payroll run when ready."}</p></article>
      <article className="panel"><p className="eyebrow">Outstanding advances</p><h2>{money(employees.reduce((sum,e)=>sum+Number(e.outstanding_advance??0),0),currency)}</h2><p className="muted">Across the employees shown.</p></article>
    </section>

    {current?<section className="panel section-block current-payroll-strip">
      <div className="section-heading"><div><p className="eyebrow">Current payroll</p><h2>{current.run_number} · {iso(current.period_start)} → {iso(current.period_end)}</h2><p className="muted">{current.employee_count} employees · pay date {iso(current.pay_date)}</p></div><span className="badge">{current.status}</span></div>
      <div className="record-grid"><div><small>Base salaries</small><strong>{money(current.base_salary,current.currency)}</strong></div><div><small>Adjustments</small><strong>{money(Number(current.allowances)+Number(current.bonuses)-Number(current.deductions),current.currency)}</strong></div><div><small>Advance repayments</small><strong>{money(current.advance_repayments,current.currency)}</strong></div><div><small>Net pay</small><strong>{money(current.net_pay,current.currency)}</strong></div></div>
      {(can("payroll.manage")||can("payroll.approve")||can("payroll.lock")||can("payroll.pay"))?<Link className="button-link" href="/payroll">Continue payroll workflow</Link>:null}
    </section>:null}

    <section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">People</p><h2>Employee directory</h2></div></div>
      <form method="get" action="/staff" className="billing-search-form"><label>Find employee<input name="q" defaultValue={q} placeholder="Name, employee number or job title"/></label><button type="submit">Find</button>{q?<Link className="button-link secondary-link" href="/staff">Clear</Link>:null}</form>

      {can("employees.manage")?<details className="hub-details staff-create-employee"><summary>Add employee</summary>
        <form action={createEmployeeAction} className="form-grid hub-action-form">
          <input type="hidden" name="return_to" value="/staff"/>
          <label>First name<input name="first_name" required/></label><label>Last name<input name="last_name" required/></label>
          <label>Job title<select name="job_title_id" defaultValue=""><option value="">No job title</option>{jobs.map((j)=><option key={j.id} value={j.id}>{j.name}</option>)}</select></label>
          <label>Start date<input name="start_on" type="date" defaultValue={today} required/></label><label>Email<input name="email" type="email"/></label><label>Phone<input name="phone"/></label>
          <label className="span-2">Address<input name="address"/></label><label className="span-2">Notes<input name="notes"/></label><button type="submit">Create employee</button>
        </form>
      </details>:null}

      <div className="staff-card-grid">
        {employees.map((e)=><Link className="staff-card" href={`/staff/${e.id}`} key={e.id}>
          <div className="row-between"><div><p className="eyebrow">{e.employee_number}</p><h3>{e.first_name} {e.last_name}</h3></div><span className="badge">{e.status}</span></div>
          <p className="muted">{e.job_title||"No job title"} · started {iso(e.start_on)}</p>
          <div className="staff-card-stats"><span><small>Salary</small><strong>{e.current_salary?money(e.current_salary,e.salary_currency):"Not set"}</strong></span><span><small>Advance due</small><strong>{money(e.outstanding_advance,e.salary_currency||currency)}</strong></span><span><small>Latest payroll</small><strong>{e.latest_run||"—"}</strong><small>{e.latest_payroll_status||""}</small></span></div>
          <span className="section-card-action">Open employee →</span>
        </Link>)}
        {!employees.length?<p className="muted">No matching employees.</p>:null}
      </div>
    </section>
  </main>;
}
