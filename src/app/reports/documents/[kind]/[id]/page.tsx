import Link from "next/link";
import { notFound,redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";

type Row=Record<string,any>;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function money(amount:unknown,currency="USD"){
  const n=Number(amount??0);
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}
  catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}
}
function iso(value:unknown){return String(value??"").slice(0,10);}
function title(value:unknown){return String(value??"").replaceAll("_"," ").replace(/\b\w/g,(m)=>m.toUpperCase());}

export default async function ReportDocumentPage({params}:{params:Promise<{kind:string;id:string}>}){
  const auth=await requireUser();
  if(!auth.permissions.includes("report_documents.view"))redirect("/forbidden");
  const {kind,id}=await params;
  if(kind==="payslip"&&!auth.permissions.includes("payroll.view"))redirect("/forbidden");
  if(!UUID_RE.test(id))notFound();

  const profile=(await query<Row>("select * from school_profile where id=1")).rows[0]??{name:"Montikids Montessori Preschool & Nursery"};

  if(kind==="invoice"){
    const invoice=(await query<Row>(`
      select i.*,f.family_number,f.display_name family_name,f.address family_address,
        s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,
        y.name school_year_name,t.name term_name,fs.name fee_schedule_name
      from invoice i
      join family f on f.id=i.family_id
      join student s on s.id=i.student_id
      join school_year y on y.id=i.school_year_id
      join school_term t on t.id=i.term_id
      join fee_schedule fs on fs.id=i.fee_schedule_id
      where i.id=$1`,[id])).rows[0];
    if(!invoice)notFound();
    const lines=(await query<Row>(`
      select l.*,
        coalesce(json_agg(json_build_object(
          'label',d.discount_label,'kind',d.discount_kind,'value',d.discount_value,
          'applied',d.applied_amount,'mode',d.combination_mode
        ) order by d.application_order) filter (where d.id is not null),'[]') discounts
      from invoice_line l left join invoice_line_discount d on d.invoice_line_id=l.id
      where l.invoice_id=$1 group by l.id order by l.created_at,l.id`,[id])).rows;
    const allocations=(await query<Row>(`
      select p.receipt_number,p.received_on,pa.allocated_on,pa.amount,p.status
      from payment_allocation pa join payment p on p.id=pa.payment_id
      where pa.invoice_id=$1 order by pa.allocated_on,p.created_at`,[id])).rows;
    const credits=(await query<Row>(`
      select c.credit_note_number,c.issued_on,ca.allocated_on,ca.amount,c.status
      from credit_note_allocation ca join credit_note c on c.id=ca.credit_note_id
      where ca.invoice_id=$1 order by ca.allocated_on,c.created_at`,[id])).rows;
    const balance=(await query<Row>("select * from invoice_balance where id=$1",[id])).rows[0];

    return <main className="app-shell">
      <header className="topbar no-print"><div><p className="eyebrow">{profile.name}</p><h1>Invoice</h1></div><Link className="button-link secondary-link" href="/reports?section=documents">Back to documents</Link></header>
      <section className="panel receipt-sheet document-sheet">
        <div className="row-between"><div><p className="eyebrow">{profile.name}</p><h1>{invoice.invoice_number}</h1><p className="muted">{profile.address??""}</p></div><div><strong>{money(invoice.total_amount,invoice.currency)}</strong><div className="muted">Issued {iso(invoice.issued_on)} · Due {iso(invoice.due_on)}</div></div></div>
        <hr/>
        <div className="record-grid">
          <div><small>Family</small><strong>{invoice.family_number} · {invoice.family_name}</strong></div>
          <div><small>Student</small><strong>{invoice.student_number} · {invoice.student_name}</strong></div>
          <div><small>School period</small><strong>{invoice.school_year_name} · {invoice.term_name}</strong></div>
        </div>
        <h2>Charges</h2>
        <div className="table-wrap"><table><thead><tr><th>Description</th><th>Gross</th><th>Discount</th><th>Net</th></tr></thead><tbody>
          {lines.map((line)=><tr key={line.id}><td>{line.description}{Array.isArray(line.discounts)&&line.discounts.length?<div className="muted">{line.discounts.map((d:any)=>d.label+" ("+money(d.applied,invoice.currency)+")").join(" · ")}</div>:null}</td><td>{money(line.gross_amount,invoice.currency)}</td><td>{money(line.discount_amount,invoice.currency)}</td><td><strong>{money(line.net_amount,invoice.currency)}</strong></td></tr>)}
        </tbody><tfoot><tr><th colSpan={2}>Invoice total</th><th>{money(invoice.discount_amount,invoice.currency)}</th><th>{money(invoice.total_amount,invoice.currency)}</th></tr></tfoot></table></div>
        <h2>Payments & credits</h2>
        <div className="table-wrap"><table><thead><tr><th>Type</th><th>Reference</th><th>Date</th><th>Applied</th></tr></thead><tbody>
          {allocations.filter((x)=>x.status==="posted").map((x)=><tr key={"p:"+x.receipt_number}><td>Payment</td><td>{x.receipt_number}</td><td>{iso(x.allocated_on)}</td><td>{money(x.amount,invoice.currency)}</td></tr>)}
          {credits.filter((x)=>x.status==="issued").map((x)=><tr key={"c:"+x.credit_note_number}><td>Credit</td><td>{x.credit_note_number}</td><td>{iso(x.allocated_on)}</td><td>{money(x.amount,invoice.currency)}</td></tr>)}
          {!allocations.some((x)=>x.status==="posted")&&!credits.some((x)=>x.status==="issued")?<tr><td colSpan={4}>No payments or credits applied.</td></tr>:null}
        </tbody></table></div>
        <div className="record-grid">
          <div><small>Original total</small><strong>{money(invoice.total_amount,invoice.currency)}</strong></div>
          <div><small>Paid / credited</small><strong>{money(Number(balance?.paid_amount??0)+Number(balance?.credit_amount??0),invoice.currency)}</strong></div>
          <div><small>Balance due</small><strong>{money(balance?.balance_amount??invoice.total_amount,invoice.currency)}</strong></div>
        </div>
        {invoice.notes?<p><strong>Notes:</strong> {invoice.notes}</p>:null}
        <p className="muted">Generated from the issued invoice and immutable discount snapshots. Use your browser print command to print or save as PDF.</p>
      </section>
    </main>;
  }

  if(kind==="family-statement"){
    const family=(await query<Row>(`
      select f.*,
        concat_ws(' ',g.first_name,g.last_name) primary_guardian,
        g.phone guardian_phone,g.email guardian_email
      from family f
      left join family_guardian fg on fg.family_id=f.id and fg.is_primary=true
      left join guardian g on g.id=fg.guardian_id
      where f.id=$1`,[id])).rows[0];
    if(!family)notFound();
    const entries=(await query<Row>(`
      with activity as (
        select i.family_id,i.student_id,i.currency,i.issued_on entry_date,i.created_at occurred_at,
          'invoice'::text entry_type,i.id source_id,i.invoice_number reference,
          ('Term invoice '||t.name)::text description,i.total_amount::numeric(14,2) debit_amount,0::numeric(14,2) credit_amount
        from invoice i join school_term t on t.id=i.term_id
        where i.family_id=$1 and i.status not in ('draft','void')
        union all
        select p.family_id,p.student_id,p.currency,p.received_on,p.created_at,
          case when p.payment_kind='prepayment' then 'prepayment' else 'payment' end,
          p.id,p.receipt_number,coalesce(p.notes,'Payment received'),0::numeric(14,2),p.amount::numeric(14,2)
        from payment p where p.family_id=$1
        union all
        select p.family_id,p.student_id,p.currency,coalesce(p.reversed_at::date,p.received_on),p.reversed_at,
          'payment_reversal',p.id,p.receipt_number,coalesce(p.reversal_reason,'Payment reversed'),
          p.amount::numeric(14,2),0::numeric(14,2)
        from payment p where p.family_id=$1 and p.status='reversed'
        union all
        select c.family_id,c.student_id,c.currency,c.issued_on,c.created_at,'credit_note',
          c.id,c.credit_note_number,c.reason,0::numeric(14,2),c.amount::numeric(14,2)
        from credit_note c where c.family_id=$1
        union all
        select c.family_id,c.student_id,c.currency,coalesce(c.reversed_at::date,c.issued_on),c.reversed_at,
          'credit_note_reversal',c.id,c.credit_note_number,coalesce(c.reversal_reason,'Credit note reversed'),
          c.amount::numeric(14,2),0::numeric(14,2)
        from credit_note c where c.family_id=$1 and c.status='reversed'
      )
      select a.*,
        sum(a.debit_amount-a.credit_amount) over (
          partition by a.currency
          order by a.entry_date,a.occurred_at,a.entry_type,a.source_id
          rows between unbounded preceding and current row
        )::numeric(14,2) running_balance
      from activity a
      order by a.currency,a.entry_date,a.occurred_at,a.entry_type,a.source_id`,[id])).rows;
    const currencies=[...new Set(entries.map((x)=>String(x.currency??"USD")))];
    const credit=(await query<Row>("select * from family_credit_balance where family_id=$1 order by currency",[id])).rows;

    return <main className="app-shell">
      <header className="topbar no-print"><div><p className="eyebrow">{profile.name}</p><h1>Family statement</h1></div><Link className="button-link secondary-link" href="/reports?section=school">Back to reports</Link></header>
      <section className="panel receipt-sheet document-sheet">
        <div className="row-between"><div><p className="eyebrow">Family statement</p><h1>{family.family_number} · {family.display_name}</h1><p className="muted">{family.address??""}</p></div><div className="muted">{profile.name}<br/>{profile.phone??""}<br/>{profile.email??""}</div></div>
        <hr/>
        <div className="record-grid">
          <div><small>Primary guardian</small><strong>{family.primary_guardian||"—"}</strong></div>
          <div><small>Phone</small><strong>{family.guardian_phone||family.home_phone||"—"}</strong></div>
          <div><small>Email</small><strong>{family.guardian_email||"—"}</strong></div>
        </div>
        {currencies.map((currency)=><div key={currency}>
          <h2>{currency} activity</h2>
          <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th>Charge</th><th>Credit</th><th>Running balance</th></tr></thead><tbody>
            {entries.filter((x)=>String(x.currency??"USD")===currency).map((x)=><tr key={x.entry_type+":"+x.source_id+":"+String(x.occurred_at)}><td>{iso(x.entry_date)}</td><td>{title(x.entry_type)}</td><td>{x.reference}</td><td>{x.description}</td><td>{Number(x.debit_amount)?money(x.debit_amount,currency):"—"}</td><td>{Number(x.credit_amount)?money(x.credit_amount,currency):"—"}</td><td><strong>{money(x.running_balance,currency)}</strong></td></tr>)}
          </tbody></table></div>
        </div>)}
        {credit.length?<div className="record-grid">{credit.map((x)=><div key={x.currency}><small>Available parent credit · {x.currency}</small><strong>{money(x.available_credit,x.currency)}</strong></div>)}</div>:null}
        <p className="muted">This statement includes posted family billing activity and reversals. Use your browser print command to print or save as PDF.</p>
      </section>
    </main>;
  }

  if(kind==="expense-voucher"){
    const expense=(await query<Row>(`
      select e.*,coalesce(s.name,'Direct expense') supplier_name,
        ea.code expense_account_code,ea.name expense_account_name,
        pa.code payment_account_code,pa.name payment_account_name,
        creator.full_name created_by_name,approver.full_name approved_by_name
      from expense e
      left join supplier s on s.id=e.supplier_id
      join account ea on ea.id=e.expense_account_id
      join account pa on pa.id=e.payment_account_id
      left join app_user creator on creator.id=e.created_by
      left join app_user approver on approver.id=e.approved_by
      where e.id=$1`,[id])).rows[0];
    if(!expense)notFound();
    const receipts=(await query<Row>(`
      select d.id,d.original_name,d.mime_type,er.attached_at
      from expense_receipt er join stored_document d on d.id=er.document_id
      where er.expense_id=$1 order by er.attached_at`,[id])).rows;
    return <main className="app-shell">
      <header className="topbar no-print"><div><p className="eyebrow">{profile.name}</p><h1>Expense voucher</h1></div><Link className="button-link secondary-link" href="/reports?section=documents">Back to documents</Link></header>
      <section className="panel receipt-sheet document-sheet">
        <div className="row-between"><div><p className="eyebrow">Expense voucher</p><h1>{expense.expense_number}</h1></div><div><strong>{money(expense.amount,expense.currency)}</strong><div className="muted">{iso(expense.incurred_on)}</div></div></div>
        <hr/>
        <div className="record-grid">
          <div><small>Supplier</small><strong>{expense.supplier_name}</strong></div>
          <div><small>Expense account</small><strong>{expense.expense_account_code} · {expense.expense_account_name}</strong></div>
          <div><small>Payment account</small><strong>{expense.payment_account_code} · {expense.payment_account_name}</strong></div>
          <div><small>Method</small><strong>{title(expense.payment_method)}</strong></div>
          <div><small>Status</small><strong>{title(expense.status)}</strong></div>
          <div><small>Approved by</small><strong>{expense.approved_by_name||"—"}</strong></div>
        </div>
        {expense.reference?<p><strong>Reference:</strong> {expense.reference}</p>:null}
        {expense.notes?<p><strong>Notes:</strong> {expense.notes}</p>:null}
        {expense.approval_note?<p><strong>Approval note:</strong> {expense.approval_note}</p>:null}
        <h2>Receipts</h2>
        {receipts.length?<ul>{receipts.map((x)=><li key={x.id}><a href={"/api/expense-receipts/"+x.id}>{x.original_name}</a></li>)}</ul>:<p className="muted">No receipt attached.</p>}
        {expense.status==="reversed"?<div className="notice error">REVERSED · {expense.reversal_reason||"Expense reversed"}</div>:null}
        <p className="muted">Generated from the posted expense record. Use your browser print command to print or save as PDF.</p>
      </section>
    </main>;
  }

  if(kind==="payslip"){
    const installed=(await query<{installed:boolean}>("select to_regclass('employee') is not null installed")).rows[0]?.installed;
    if(!installed)notFound();
    const item=(await query<Row>(`
      select i.*,r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status run_status,
        e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
        jt.name job_title,s.effective_from salary_effective_from,s.monthly_salary agreed_monthly_salary,
        pp.payment_number,pp.paid_on,pp.method payment_method,pp.reference payment_reference
      from payroll_run_item i
      join payroll_run r on r.id=i.payroll_run_id
      join employee e on e.id=i.employee_id
      left join job_title jt on jt.id=e.job_title_id
      join employee_salary_agreement s on s.id=i.salary_agreement_id
      left join payroll_payment pp on pp.payroll_run_id=r.id and pp.status='posted'
      where i.id=$1 and r.status in ('locked','paid')`,[id])).rows[0];
    if(!item)notFound();
    const adjustments=(await query<Row>(`
      select adjustment_type,description,amount
      from payroll_adjustment where payroll_run_item_id=$1
      order by adjustment_type,created_at,id`,[id])).rows;
    const repayments=(await query<Row>(`
      select a.advance_number,rs.installment_number,rs.due_on,ra.amount
      from salary_advance_repayment_allocation ra
      join salary_advance_repayment_schedule rs on rs.id=ra.repayment_schedule_id
      join salary_advance a on a.id=rs.salary_advance_id
      where ra.payroll_run_item_id=$1
      order by a.advance_number,rs.installment_number`,[id])).rows;

    return <main className="app-shell">
      <header className="topbar no-print"><div><p className="eyebrow">{profile.name}</p><h1>Payslip</h1></div><Link className="button-link secondary-link" href="/reports?section=documents">Back to documents</Link></header>
      <section className="panel receipt-sheet document-sheet">
        <div className="row-between"><div><p className="eyebrow">Official payslip</p><h1>{item.employee_number} · {item.employee_name}</h1><p className="muted">{item.job_title||"Employee"}</p></div><div><strong>{money(item.net_pay,item.currency)}</strong><div className="muted">{item.run_number}</div></div></div>
        <hr/>
        <div className="record-grid">
          <div><small>Payroll period</small><strong>{iso(item.period_start)} → {iso(item.period_end)}</strong></div>
          <div><small>Pay date</small><strong>{iso(item.pay_date)}</strong></div>
          <div><small>Status</small><strong>{title(item.run_status)}</strong></div>
          <div><small>Salary agreement</small><strong>{money(item.agreed_monthly_salary,item.currency)} from {iso(item.salary_effective_from)}</strong></div>
          <div><small>Base salary</small><strong>{money(item.base_salary,item.currency)}</strong></div>
          <div><small>Gross pay</small><strong>{money(item.gross_pay,item.currency)}</strong></div>
        </div>
        <h2>Earnings & deductions</h2>
        <div className="table-wrap"><table><thead><tr><th>Type</th><th>Description</th><th>Amount</th></tr></thead><tbody>
          <tr><td>Base salary</td><td>Monthly salary for this payroll run</td><td>{money(item.base_salary,item.currency)}</td></tr>
          {adjustments.filter((x)=>x.adjustment_type==="allowance").map((x,i)=><tr key={"a"+i}><td>Allowance</td><td>{x.description}</td><td>{money(x.amount,item.currency)}</td></tr>)}
          {adjustments.filter((x)=>x.adjustment_type==="bonus").map((x,i)=><tr key={"b"+i}><td>Bonus</td><td>{x.description}</td><td>{money(x.amount,item.currency)}</td></tr>)}
          {adjustments.filter((x)=>x.adjustment_type==="deduction").map((x,i)=><tr key={"d"+i}><td>Deduction</td><td>{x.description}</td><td>− {money(x.amount,item.currency)}</td></tr>)}
          {repayments.map((x,i)=><tr key={"r"+i}><td>Salary advance repayment</td><td>{x.advance_number} · installment {x.installment_number}</td><td>− {money(x.amount,item.currency)}</td></tr>)}
        </tbody></table></div>
        <div className="record-grid">
          <div><small>Allowances</small><strong>{money(item.allowance_total,item.currency)}</strong></div>
          <div><small>Bonuses</small><strong>{money(item.bonus_total,item.currency)}</strong></div>
          <div><small>Deductions</small><strong>{money(item.deduction_total,item.currency)}</strong></div>
          <div><small>Advance repayments</small><strong>{money(item.advance_repayment_total,item.currency)}</strong></div>
          <div><small>Payroll expense</small><strong>{money(item.payroll_expense,item.currency)}</strong></div>
          <div><small>Net pay</small><strong>{money(item.net_pay,item.currency)}</strong></div>
        </div>
        {item.payment_number?<p><strong>Payment:</strong> {item.payment_number} · {iso(item.paid_on)} · {title(item.payment_method)}{item.payment_reference?" · "+item.payment_reference:""}</p>:<p className="muted">Salary is locked but has not yet been marked paid.</p>}
        <p className="muted">This payslip is generated from the locked payroll item and its immutable salary agreement reference. Use your browser print command to print or save as PDF.</p>
      </section>
    </main>;
  }

  if(kind==="supplier-statement"){
    const supplier=(await query<Row>("select * from supplier where id=$1",[id])).rows[0];
    if(!supplier)notFound();
    const entries=(await query<Row>("select * from supplier_statement where supplier_id=$1 order by currency,entry_date,occurred_at,source_id",[id])).rows;
    const currencies=[...new Set(entries.map((x)=>String(x.currency??"USD")))];
    return <main className="app-shell">
      <header className="topbar no-print"><div><p className="eyebrow">{profile.name}</p><h1>Supplier statement</h1></div><Link className="button-link secondary-link" href="/reports?section=documents">Back to documents</Link></header>
      <section className="panel receipt-sheet document-sheet">
        <div className="row-between"><div><p className="eyebrow">Supplier statement</p><h1>{supplier.supplier_number} · {supplier.name}</h1><p className="muted">{supplier.address??""}</p></div><div className="muted">{supplier.contact_name??""}<br/>{supplier.phone??""}<br/>{supplier.email??""}</div></div>
        <hr/>
        {currencies.map((currency)=><div key={currency}><h2>{currency} activity</h2><div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Description</th><th>Increase</th><th>Decrease</th><th>Payable balance</th></tr></thead><tbody>
          {entries.filter((x)=>String(x.currency??"USD")===currency).map((x)=><tr key={x.entry_type+":"+x.source_id}><td>{iso(x.entry_date)}</td><td>{title(x.entry_type)}</td><td>{x.reference}</td><td>{x.description}</td><td>{Number(x.payable_increase)?money(x.payable_increase,currency):"—"}</td><td>{Number(x.payable_decrease)?money(x.payable_decrease,currency):"—"}</td><td><strong>{money(x.running_payable_balance,currency)}</strong></td></tr>)}
        </tbody></table></div></div>)}
        {!entries.length?<p>No supplier activity yet.</p>:null}
        <p className="muted">Generated from posted supplier invoices, payments and credits. Use your browser print command to print or save as PDF.</p>
      </section>
    </main>;
  }

  notFound();
}
