import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/security";

type Row=Record<string,any>;
function iso(v:unknown){return String(v??"").slice(0,10);}
function money(v:unknown,currency="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}}
function title(v:unknown){return String(v??"").replaceAll("_"," ").replace(/\b\w/g,m=>m.toUpperCase());}

export default async function PayslipPage({params}:{params:Promise<{id:string}>}){
  await requirePermission("payroll.view");
  const {id}=await params;
  const item=(await query<Row>("select i.*,r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status run_status,e.employee_number,e.first_name,e.last_name,j.name job_title,s.effective_from salary_effective_from from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id join employee e on e.id=i.employee_id left join job_title j on j.id=e.job_title_id join employee_salary_agreement s on s.id=i.salary_agreement_id where i.id=$1",[id])).rows[0];
  if(!item||!["locked","paid"].includes(item.run_status))notFound();
  const [profileR,adjustmentsR,repaymentsR]=await Promise.all([
    query<Row>("select * from school_profile where id=1"),
    query<Row>("select * from payroll_adjustment where payroll_run_item_id=$1 order by adjustment_type,created_at",[id]),
    query<Row>("select a.advance_number,s.installment_number,s.due_on,x.amount from salary_advance_repayment_allocation x join salary_advance_repayment_schedule s on s.id=x.repayment_schedule_id join salary_advance a on a.id=s.salary_advance_id where x.payroll_run_item_id=$1 order by s.due_on,s.installment_number",[id]),
  ]);
  const profile=profileR.rows[0]??{},adjustments=adjustmentsR.rows,repayments=repaymentsR.rows;
  return <main className="app-shell"><header className="topbar"><div><p className="eyebrow">{profile.name||"Montikids Montessori Preschool & Nursery"}</p><h1>Payslip</h1><p className="muted">{item.run_number} · {iso(item.period_start)} → {iso(item.period_end)}</p></div><div className="top-actions"><a className="button-link secondary-link" href={"/staff/"+item.employee_id}>Back to employee</a></div></header>
    <section className="panel section-block"><div className="row-between"><div><h2>{item.first_name} {item.last_name}</h2><p className="muted">{item.employee_number} · {item.job_title||"Employee"}</p></div><span className="badge">{item.run_status}</span></div><div className="record-grid"><div><small>Pay date</small><strong>{iso(item.pay_date)}</strong></div><div><small>Salary agreement</small><strong>Effective {iso(item.salary_effective_from)}</strong></div><div><small>Base salary</small><strong>{money(item.base_salary,item.currency)}</strong></div><div><small>Net pay</small><strong>{money(item.net_pay,item.currency)}</strong></div></div>
      <h3>Earnings & deductions</h3><div className="table-wrap"><table><thead><tr><th>Type</th><th>Description</th><th>Amount</th></tr></thead><tbody><tr><td>Base salary</td><td>Monthly salary</td><td>{money(item.base_salary,item.currency)}</td></tr>{adjustments.map(a=><tr key={a.id}><td>{title(a.adjustment_type)}</td><td>{a.description}</td><td>{a.adjustment_type==="deduction"?"−":"+"}{money(a.amount,item.currency)}</td></tr>)}<tr><td colSpan={2}><strong>Gross earnings</strong></td><td><strong>{money(item.gross_pay,item.currency)}</strong></td></tr><tr><td colSpan={2}><strong>Payroll expense after deductions</strong></td><td><strong>{money(item.payroll_expense,item.currency)}</strong></td></tr></tbody></table></div>
      <h3>Salary advance repayments</h3>{repayments.length?<div className="table-wrap"><table><thead><tr><th>Advance</th><th>Installment</th><th>Due</th><th>Applied</th></tr></thead><tbody>{repayments.map((r,idx)=><tr key={idx}><td>{r.advance_number}</td><td>#{r.installment_number}</td><td>{iso(r.due_on)}</td><td>−{money(r.amount,item.currency)}</td></tr>)}</tbody></table></div>:<p className="muted">No salary advance repayment in this payroll.</p>}
      <div className="record-grid"><div><small>Allowances</small><strong>{money(item.allowance_total,item.currency)}</strong></div><div><small>Bonuses</small><strong>{money(item.bonus_total,item.currency)}</strong></div><div><small>Deductions</small><strong>{money(item.deduction_total,item.currency)}</strong></div><div><small>Advance repayments</small><strong>{money(item.advance_repayment_total,item.currency)}</strong></div><div><small>Net salary</small><strong>{money(item.net_pay,item.currency)}</strong></div></div>
      <p className="muted">This payslip is generated from the locked payroll snapshot. Later salary changes do not rewrite this payroll or earlier salary history.</p>
    </section>
  </main>;
}
