import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { createSalaryAgreementAction, updateEmployeeAction } from "@/app/payroll/employee-actions";
import { createSalaryAdvanceAction, reverseSalaryAdvanceAction } from "@/app/payroll/advance-actions";

type Row=Record<string,any>;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function iso(v:unknown){return String(v??"").slice(0,10);}
function money(v:unknown,currency="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}}
function title(v:unknown){return String(v??"").replaceAll("_"," ").replace(/\b\w/g,m=>m.toUpperCase());}

export default async function EmployeePage({
  params,searchParams,
}:{
  params:Promise<{id:string}>;
  searchParams:Promise<{error?:string;success?:string}>;
}){
  const auth=await requireUser();
  const {id}=await params;
  if(!UUID_RE.test(id))notFound();
  const {error,success}=await searchParams;
  const can=(permission:string)=>auth.permissions.includes(permission);
  const allowed=["employees.view","employees.manage","payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage"].some(can);
  if(!allowed)redirect("/forbidden");

  const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today??new Date().toISOString().slice(0,10);
  const currencySetting=(await query<{currency:string|null}>("select value #>> '{}' currency from app_setting where key='currency'")).rows[0]?.currency??"USD";
  const employee=(await query<Row>("select e.*,j.name job_title from employee e left join job_title j on j.id=e.job_title_id where e.id=$1",[id])).rows[0];
  if(!employee)notFound();

  const [jobsR,salaryR,advancesR,schedulesR,payrollR,cashR,ledgerR]=await Promise.all([
    can("employees.manage")?query<Row>("select * from job_title order by status,name"):Promise.resolve({rows:[] as Row[]}),
    query<Row>("select * from employee_salary_history where employee_id=$1 order by effective_from desc",[id]),
    query<Row>("select b.*,c.display_name payment_account_name from salary_advance_balance b join salary_advance a on a.id=b.id join cash_bank_account c on c.account_id=a.payment_account_id where b.employee_id=$1 order by b.advance_date desc",[id]),
    query<Row>("select s.*,coalesce(sum(x.amount),0)::numeric(14,2) applied_amount from salary_advance_repayment_schedule s join salary_advance a on a.id=s.salary_advance_id left join salary_advance_repayment_allocation x on x.repayment_schedule_id=s.id where a.employee_id=$1 group by s.id order by s.due_on,s.installment_number",[id]),
    query<Row>(
      `select i.*,r.run_number,r.period_start::text,r.period_end::text,r.pay_date::text,r.status run_status,r.currency,
         coalesce(json_agg(json_build_object('id',a.id,'type',a.adjustment_type,'description',a.description,'amount',a.amount) order by a.created_at) filter(where a.id is not null),'[]') adjustments,
         coalesce((select json_agg(json_build_object('advanceNumber',sa.advance_number,'installment',rs.installment_number,'dueOn',rs.due_on,'amount',x.amount) order by rs.due_on,rs.installment_number)
           from salary_advance_repayment_allocation x join salary_advance_repayment_schedule rs on rs.id=x.repayment_schedule_id join salary_advance sa on sa.id=rs.salary_advance_id where x.payroll_run_item_id=i.id),'[]') repayments
       from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id left join payroll_adjustment a on a.payroll_run_item_id=i.id
       where i.employee_id=$1 group by i.id,r.id order by r.period_end desc,r.created_at desc`,
      [id],
    ),
    can("salary_advances.manage")?query<Row>("select * from cash_bank_balance where is_active=true order by account_kind,display_name"):Promise.resolve({rows:[] as Row[]}),
    can("payroll.view")?query<Row>("select * from employee_payroll_ledger where employee_id=$1 order by event_date desc,ledger_key desc limit 100",[id]):Promise.resolve({rows:[] as Row[]}),
  ]);
  const jobs=jobsR.rows,salaryHistory=salaryR.rows,advances=advancesR.rows,schedules=schedulesR.rows,payrollItems=payrollR.rows,cash=cashR.rows,ledger=ledgerR.rows;
  const currentSalary=salaryHistory[0]??null;
  const currentPayroll=payrollItems.find((p)=>p.run_status!=="paid")??payrollItems[0]??null;
  const outstandingAdvance=advances.filter((a)=>a.status==="posted").reduce((sum,a)=>sum+Number(a.outstanding_amount??0),0);
  const returnTo=`/staff/${id}`;

  return <main className="app-shell employee-profile-shell">
    <header className="topbar"><div><p className="eyebrow">Employee profile</p><h1>{employee.first_name} {employee.last_name}</h1><p className="muted">{employee.employee_number} · {employee.job_title||"No job title"} · started {iso(employee.start_on)}</p></div><div className="top-actions"><Link className="button-link secondary-link" href="/staff">All staff</Link>{can("payroll.view")||can("payroll.manage")?<Link className="button-link secondary-link" href="/payroll">Advanced payroll</Link>:null}</div></header>
    {error?<div className="notice error">{error}</div>:null}{success?<div className="notice success">{success}</div>:null}

    <nav className="family-hub-nav no-print" aria-label="Employee sections"><a href="#salary">Salary</a><a href="#advances">Advances</a><a href="#payroll">Current payroll</a><a href="#history">History</a></nav>

    <section className="money-summary-grid">
      <article className="panel"><p className="eyebrow">Status</p><h2>{title(employee.status)}</h2><p className="muted">{employee.phone||employee.email||"No contact details."}</p></article>
      <article className="panel"><p className="eyebrow">Current salary</p><h2>{currentSalary?money(currentSalary.monthly_salary,currentSalary.currency):"Not set"}</h2><p className="muted">{currentSalary?`Effective ${iso(currentSalary.effective_from)}`:"Add a salary agreement."}</p></article>
      <article className="panel"><p className="eyebrow">Advance balance</p><h2>{money(outstandingAdvance,currentSalary?.currency||currencySetting)}</h2><p className="muted">{advances.filter((a)=>a.status==="posted"&&Number(a.outstanding_amount)>0).length} open advance{advances.filter((a)=>a.status==="posted"&&Number(a.outstanding_amount)>0).length===1?"":"s"}.</p></article>
      <article className="panel"><p className="eyebrow">Current payroll</p><h2>{currentPayroll?.run_number||"—"}</h2><p className="muted">{currentPayroll?`${title(currentPayroll.run_status)} · net ${money(currentPayroll.net_pay,currentPayroll.currency)}`:"No payroll item yet."}</p></article>
    </section>

    {can("employees.manage")?<details className="hub-details"><summary>Edit employee details</summary><form action={updateEmployeeAction} className="form-grid hub-action-form">
      <input type="hidden" name="return_to" value={returnTo}/><input type="hidden" name="employee_id" value={id}/>
      <label>First name<input name="first_name" defaultValue={employee.first_name} required/></label><label>Last name<input name="last_name" defaultValue={employee.last_name} required/></label>
      <label>Job title<select name="job_title_id" defaultValue={employee.job_title_id??""}><option value="">No job title</option>{jobs.map((j)=><option key={j.id} value={j.id}>{j.name}</option>)}</select></label>
      <label>Status<select name="status" defaultValue={employee.status}><option value="active">Active</option><option value="inactive">Inactive</option><option value="terminated">Terminated</option></select></label>
      <label>Start<input name="start_on" type="date" defaultValue={iso(employee.start_on)} required/></label><label>End<input name="end_on" type="date" defaultValue={employee.end_on?iso(employee.end_on):""}/></label>
      <label>Email<input name="email" type="email" defaultValue={employee.email??""}/></label><label>Phone<input name="phone" defaultValue={employee.phone??""}/></label>
      <label className="span-2">Address<input name="address" defaultValue={employee.address??""}/></label><label className="span-2">Notes<input name="notes" defaultValue={employee.notes??""}/></label><button type="submit">Save employee</button>
    </form></details>:null}

    <section className="panel section-block" id="salary">
      <div className="section-heading"><div><p className="eyebrow">Salary</p><h2>Current salary</h2><p className="muted">Salary changes create a new effective agreement; prior salary periods stay immutable.</p></div></div>
      {currentSalary?<div className="employee-primary-value"><small>Monthly salary</small><strong>{money(currentSalary.monthly_salary,currentSalary.currency)}</strong><span>Effective {iso(currentSalary.effective_from)}</span></div>:<p className="muted">No salary agreement yet.</p>}
      {can("employees.manage")?<form action={createSalaryAgreementAction} className="simple-money-form">
        <input type="hidden" name="return_to" value={returnTo}/><input type="hidden" name="employee_id" value={id}/>
        <label>New monthly salary<input name="monthly_salary" type="number" min="0.01" step="0.01" required/></label><label>Currency<input name="currency" maxLength={3} defaultValue={currentSalary?.currency||currencySetting} required/></label>
        <label>Effective from<input name="effective_from" type="date" defaultValue={today} required/></label><label>Notes<input name="notes"/></label><button type="submit">Add salary change</button>
      </form>:null}
      {salaryHistory.length>1?<details className="hub-details"><summary>Salary history ({salaryHistory.length})</summary><div className="table-wrap"><table><thead><tr><th>From</th><th>To</th><th>Monthly salary</th><th>Notes</th></tr></thead><tbody>{salaryHistory.map((s)=><tr key={s.id}><td>{iso(s.effective_from)}</td><td>{s.effective_to?iso(s.effective_to):"Current"}</td><td>{money(s.monthly_salary,s.currency)}</td><td>{s.notes||"—"}</td></tr>)}</tbody></table></div></details>:null}
    </section>

    <section className="panel section-block" id="advances">
      <div className="section-heading"><div><p className="eyebrow">Advances</p><h2>Salary advances</h2><p className="muted">Repayment installments are automatically recovered when payroll is locked.</p></div></div>
      {can("salary_advances.manage")&&employee.status!=="inactive"?<form action={createSalaryAdvanceAction} className="simple-money-form">
        <input type="hidden" name="return_to" value={returnTo}/><input type="hidden" name="employee_id" value={id}/>
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Currency<input name="currency" defaultValue={currentSalary?.currency||currencySetting} maxLength={3} required/></label>
        <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cash.map((c)=><option key={c.account_id} value={c.account_id}>{c.display_name} · {money(c.balance,c.currency)}</option>)}</select></label>
        <label>Advance date<input name="advance_date" type="date" defaultValue={today} required/></label><label>Installments<input name="installments_count" type="number" min="1" max="120" defaultValue="1" required/></label>
        <label>First repayment<input name="first_repayment_on" type="date" required/></label><label>Reference<input name="reference"/></label><label>Notes<input name="notes"/></label><button type="submit">Pay advance</button>
      </form>:null}
      <div className="card-list">{advances.map((a)=>{const ss=schedules.filter((s)=>s.salary_advance_id===a.id);return <article className="subcard" key={a.id}><div className="row-between"><div><strong>{a.advance_number}</strong><div className="muted">{iso(a.advance_date)} · {a.payment_account_name}</div></div><span className="badge">{a.status}</span></div><div className="record-grid"><div><small>Original</small><strong>{money(a.amount,a.currency)}</strong></div><div><small>Repaid</small><strong>{money(a.repaid_amount,a.currency)}</strong></div><div><small>Outstanding</small><strong>{money(a.outstanding_amount,a.currency)}</strong></div></div>{ss.length?<details className="hub-details"><summary>Repayment schedule</summary><div className="table-wrap"><table><thead><tr><th>#</th><th>Due</th><th>Scheduled</th><th>Applied</th><th>Remaining</th></tr></thead><tbody>{ss.map((s)=><tr key={s.id}><td>{s.installment_number}</td><td>{iso(s.due_on)}</td><td>{money(s.amount,a.currency)}</td><td>{money(s.applied_amount,a.currency)}</td><td>{money(Number(s.amount)-Number(s.applied_amount),a.currency)}</td></tr>)}</tbody></table></div></details>:null}{can("salary_advances.manage")&&a.status==="posted"&&Number(a.repaid_amount)===0?<form action={reverseSalaryAdvanceAction} className="inline-form compact-form"><input type="hidden" name="return_to" value={returnTo}/><input type="hidden" name="salary_advance_id" value={a.id}/><label>Reversal date<input name="reversal_date" type="date" defaultValue={today} required/></label><label>Reason<input name="reason" required/></label><button type="submit" className="secondary">Reverse</button></form>:null}</article>})}{!advances.length?<p className="muted">No salary advances.</p>:null}</div>
    </section>

    <section className="panel section-block" id="payroll">
      <div className="section-heading"><div><p className="eyebrow">Payroll</p><h2>Current payroll & payslips</h2><p className="muted">The newest payroll is shown first. Locked and paid payroll expose immutable payslips.</p></div>{(can("payroll.manage")||can("payroll.approve")||can("payroll.lock")||can("payroll.pay"))?<Link className="button-link secondary-link" href="/payroll">Manage payroll run</Link>:null}</div>
      {payrollItems.length?<div className="card-list">{payrollItems.map((p,index)=><article className={index===0?"subcard employee-current-payroll":"subcard"} key={p.id}><div className="row-between"><div><strong>{p.run_number} · {iso(p.period_start)} → {iso(p.period_end)}</strong><div className="muted">Pay date {iso(p.pay_date)}</div></div><span className="badge">{p.run_status}</span></div><div className="record-grid"><div><small>Base salary</small><strong>{money(p.base_salary,p.currency)}</strong></div><div><small>Gross</small><strong>{money(p.gross_pay,p.currency)}</strong></div><div><small>Advance repayments</small><strong>{money(p.advance_repayment_total,p.currency)}</strong></div><div><small>Net pay</small><strong>{money(p.net_pay,p.currency)}</strong></div></div>{["locked","paid"].includes(p.run_status)&&can("payroll.view")?<Link className="button-link" href={`/payroll/payslips/${p.id}`}>Open payslip</Link>:null}{index===0&&(p.adjustments as Row[]).length?<details className="hub-details"><summary>Current adjustments</summary>{(p.adjustments as Row[]).map((a)=><p className="compact-text" key={a.id}>{title(a.type)} · {a.description} · {money(a.amount,p.currency)}</p>)}</details>:null}</article>)}</div>:<p className="muted">This employee has not been included in a payroll run yet.</p>}
    </section>

    {can("payroll.view")?<section className="panel section-block" id="history">
      <div className="section-heading"><div><p className="eyebrow">Secondary detail</p><h2>Payroll accounting history</h2><p className="muted">Detailed ledger history is kept available without making it the main employee workflow.</p></div></div>
      <details className="hub-details"><summary>Employee payroll ledger ({ledger.length})</summary><div className="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Reference</th><th>Gross</th><th>Deductions</th><th>Advance</th><th>Payable</th><th>Paid</th></tr></thead><tbody>{ledger.map((l)=><tr key={l.ledger_key}><td>{iso(l.event_date)}</td><td>{title(l.event_type)}</td><td>{l.reference}</td><td>{money(l.gross_earnings,l.currency)}</td><td>{money(l.deductions,l.currency)}</td><td>{Number(l.advance_increase)>0?"+"+money(l.advance_increase,l.currency):Number(l.advance_repayment)>0?"−"+money(l.advance_repayment,l.currency):"—"}</td><td>{money(l.salary_payable,l.currency)}</td><td>{money(l.salary_paid,l.currency)}</td></tr>)}</tbody></table></div></details>
    </section>:null}
  </main>;
}
