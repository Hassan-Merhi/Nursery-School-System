import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";

type Row = Record<string, any>;
type Search = { from?: string; to?: string; section?: string };

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const sections=["overview","financial","school","payroll","documents"] as const;

function money(amount:unknown,currency="USD"){
  const n=Number(amount??0);
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}
  catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}
}
function date(value:unknown){return String(value??"").slice(0,10);}
function title(value:unknown){return String(value??"").replaceAll("_"," ").replace(/\b\w/g,(m)=>m.toUpperCase());}
function qs(from:string,to:string,section:string){
  return "?"+new URLSearchParams({from,to,section}).toString();
}
function currencyTotals(rows:Row[],field:string){
  const totals=new Map<string,number>();
  for(const row of rows){
    const currency=String(row.currency??"USD");
    totals.set(currency,(totals.get(currency)??0)+Number(row[field]??0));
  }
  return [...totals.entries()].sort(([a],[b])=>a.localeCompare(b));
}
function MoneyStack({values}:{values:Array<[string,number]>}){
  if(!values.length)return <span>—</span>;
  return <span className="money-stack">{values.map(([currency,amount])=><span key={currency}>{money(amount,currency)}</span>)}</span>;
}
function Metric({label,values,note}:{label:string;values:Array<[string,number]>;note:string}){
  return <article className="panel"><p className="eyebrow">{label}</p><h2 className="metric-value"><MoneyStack values={values}/></h2><p className="muted compact-text">{note}</p></article>;
}

export default async function ReportsPage({searchParams}:{searchParams:Promise<Search>}){
  const auth=await requireUser();
  const can=(p:string)=>auth.permissions.includes(p);
  if(!["management.view","reports.view","report_documents.view"].some(can))redirect("/forbidden");

  const visibleSections=sections.filter((item)=>{
    if(item==="overview")return can("management.view");
    if(item==="financial"||item==="school")return can("reports.view");
    if(item==="payroll")return can("reports.view")&&can("payroll.view");
    if(item==="documents")return can("report_documents.view");
    return false;
  });
  if(!visibleSections.length)redirect("/forbidden");

  const params=await searchParams;
  const clock=(await query<{today:string;month_start:string}>(
    `select
       (now() at time zone sp.timezone)::date::text today,
       date_trunc('month',now() at time zone sp.timezone)::date::text month_start
     from school_profile sp where sp.id=1`,
  )).rows[0];
  const from=DATE_RE.test(params.from??"")?params.from!:clock.month_start;
  const to=DATE_RE.test(params.to??"")?params.to!:clock.today;
  if(to<from)redirect("/reports?section=overview");
  const requestedSection=sections.includes((params.section??visibleSections[0]) as any)
    ?String(params.section??visibleSections[0])
    :String(visibleSections[0]);
  if(!visibleSections.includes(requestedSection as (typeof sections)[number])){
    redirect("/reports?section="+visibleSections[0]);
  }
  const section=requestedSection;

  const payrollInstalled=(await query<{installed:boolean}>(
    "select to_regclass('employee') is not null as installed",
  )).rows[0]?.installed??false;

  const [
    activeStudentsResult,expectedResult,collectedResult,receivablesResult,cashBankResult,
    plResult,rentDueResult,positionResult,creditsResult,
  ]=await Promise.all([
    query<Row>("select report_active_student_count($1::date) as count",[to]),
    query<Row>(`
      select currency,coalesce(sum(total_amount),0)::numeric(14,2)::text amount
      from invoice
      where due_on between $1::date and $2::date and status not in ('draft','void')
      group by currency order by currency`,[from,to]),
    query<Row>(`
      select p.currency,coalesce(sum(pa.amount),0)::numeric(14,2)::text amount
      from payment p
      join payment_allocation pa on pa.payment_id=p.id
      where p.received_on between $1::date and $2::date
        and pa.allocated_on<=$2::date
        and (p.status='posted' or p.reversed_at::date>$2::date)
      group by p.currency order by p.currency`,[from,to]),
    query<Row>("select * from report_receivables($1::date) where balance_amount<>0 order by due_on,invoice_number",[to]),
    query<Row>("select * from report_cash_bank_balances($1::date) order by account_kind,display_name",[to]),
    query<Row>("select * from report_profit_loss($1::date,$2::date) order by category,account_code",[from,to]),
    query<Row>(`
      select b.currency,b.normal_balance::numeric(14,2)::text amount
      from accounting_mapping m
      join report_account_balances($1::date) b on b.account_id=m.account_id
      where m.role_key='rent_payable'`,[to]),
    query<Row>("select * from report_position($1::date) order by currency",[to]),
    query<Row>("select * from report_family_credits($1::date) where available_credit<>0 order by family_name,currency",[to]),
  ]);

  const activeStudents=Number(activeStudentsResult.rows[0]?.count??0);
  const expected=expectedResult.rows.map((x)=>[String(x.currency),Number(x.amount)] as [string,number]);
  const collected=collectedResult.rows.map((x)=>[String(x.currency),Number(x.amount)] as [string,number]);
  const outstanding=currencyTotals(receivablesResult.rows,"balance_amount");
  const cash=currencyTotals(cashBankResult.rows.filter((x)=>x.account_kind==="cash"),"balance");
  const bank=currencyTotals(cashBankResult.rows.filter((x)=>x.account_kind==="bank"),"balance");
  const expenses=currencyTotals(plResult.rows.filter((x)=>x.category==="expense"),"amount");
  const rentDue=rentDueResult.rows.map((x)=>[String(x.currency),Number(x.amount)] as [string,number]);
  const netPosition=positionResult.rows.map((x)=>[String(x.currency),Number(x.net_position)] as [string,number]);
  const prepayments=currencyTotals(creditsResult.rows,"available_credit");

  let payrollDue:Array<[string,number]>=[];
  if(payrollInstalled){
    const payrollMapping=await query<Row>(`
      select b.currency,b.normal_balance::numeric(14,2)::text amount
      from accounting_mapping m
      join report_account_balances($1::date) b on b.account_id=m.account_id
      where m.role_key in ('salary_payable','payroll_payable')`,[to]);
    payrollDue=payrollMapping.rows.map((x)=>[String(x.currency),Number(x.amount)] as [string,number]);
  }

  let ledger:Row[]=[],trialBalance:Row[]=[],cashFlow:Row[]=[],payables:Row[]=[];
  let students:Row[]=[],families:Row[]=[],enrollments:Row[]=[],fees:Row[]=[],discounts:Row[]=[];
  let salaryHistory:Row[]=[],payrollRuns:Row[]=[],payrollItems:Row[]=[],employeeCosts:Row[]=[],advances:Row[]=[];
  let documentInvoices:Row[]=[],documentPayments:Row[]=[],documentExpenses:Row[]=[],documentSuppliers:Row[]=[],payslips:Row[]=[];
  if(section==="financial"&&can("reports.view")){
    const results=await Promise.all([
      query<Row>("select * from report_general_ledger($1::date,$2::date) order by posting_date desc,entry_number desc,line_number limit 1000",[from,to]),
      query<Row>("select * from report_trial_balance($1::date) order by currency,account_code",[to]),
      query<Row>("select * from report_cash_flow($1::date,$2::date)",[from,to]),
      query<Row>("select * from report_payables($1::date) where balance_amount<>0 order by due_on,supplier_invoice_number",[to]),
    ]);
    ledger=results[0].rows;trialBalance=results[1].rows;cashFlow=results[2].rows;payables=results[3].rows;
  }
  if(section==="school"&&can("reports.view")){
    const results=await Promise.all([
      query<Row>(`
        select s.id,s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,s.status,
          f.family_number,f.display_name family_name,s.admission_date,s.exit_date
        from student s join family f on f.id=s.family_id
        order by s.last_name,s.first_name limit 1000`),
      query<Row>(`
        select f.id,f.family_number,f.display_name,
          count(s.id)::int student_count,
          count(s.id) filter (where s.status='active')::int active_student_count
        from family f left join student s on s.family_id=f.id
        group by f.id order by f.display_name limit 1000`),
      query<Row>("select * from report_enrollment order by starts_on desc,student_name limit 1000"),
      query<Row>(`
        select i.id,i.invoice_number,i.issued_on,i.due_on,i.currency,i.subtotal_amount,
          i.discount_amount,i.total_amount,i.status,f.family_number,f.display_name family_name,
          s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,t.name term_name
        from invoice i join family f on f.id=i.family_id join student s on s.id=i.student_id
        join school_term t on t.id=i.term_id
        where i.issued_on between $1::date and $2::date and i.status not in ('draft','void')
        order by i.issued_on desc,i.invoice_number`,[from,to]),
      query<Row>(`
        select * from report_fee_discount
        where issued_on between $1::date and $2::date and applied_amount is not null
        order by issued_on desc,student_name,invoice_number`,[from,to]),
    ]);
    students=results[0].rows;families=results[1].rows;enrollments=results[2].rows;fees=results[3].rows;discounts=results[4].rows;
  }
  if(section==="payroll"&&can("reports.view")&&can("payroll.view")&&payrollInstalled){
    const results=await Promise.all([
      query<Row>(`
        select h.id,h.employee_id,e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
          jt.name job_title,h.effective_from,h.effective_to,h.monthly_salary,h.currency,h.notes
        from employee_salary_history h
        join employee e on e.id=h.employee_id
        left join job_title jt on jt.id=e.job_title_id
        order by e.last_name,e.first_name,h.effective_from desc`),
      query<Row>(`
        select *
        from payroll_run_summary
        where period_end>=$1::date and period_start<=$2::date
        order by period_end desc,run_number desc`,[from,to]),
      query<Row>(`
        select i.id,r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status,
          e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
          i.base_salary,i.allowance_total,i.bonus_total,i.deduction_total,
          i.advance_repayment_total,i.gross_pay,i.payroll_expense,i.net_pay
        from payroll_run_item i
        join payroll_run r on r.id=i.payroll_run_id
        join employee e on e.id=i.employee_id
        where r.period_end>=$1::date and r.period_start<=$2::date
        order by r.period_end desc,e.last_name,e.first_name`,[from,to]),
      query<Row>(`
        select e.id employee_id,e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
          r.currency,count(distinct r.id)::int payroll_count,
          coalesce(sum(i.base_salary),0)::numeric(14,2) base_salary,
          coalesce(sum(i.allowance_total),0)::numeric(14,2) allowances,
          coalesce(sum(i.bonus_total),0)::numeric(14,2) bonuses,
          coalesce(sum(i.deduction_total),0)::numeric(14,2) deductions,
          coalesce(sum(i.payroll_expense),0)::numeric(14,2) employee_cost,
          coalesce(sum(i.net_pay),0)::numeric(14,2) net_pay
        from payroll_run_item i
        join payroll_run r on r.id=i.payroll_run_id
        join employee e on e.id=i.employee_id
        where r.status in ('locked','paid')
          and r.period_end>=$1::date and r.period_start<=$2::date
        group by e.id,r.currency order by e.last_name,e.first_name,r.currency`,[from,to]),
      query<Row>(`
        select b.*,e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name
        from salary_advance_balance b
        join employee e on e.id=b.employee_id
        order by b.advance_date desc,b.advance_number desc`),
    ]);
    salaryHistory=results[0].rows;payrollRuns=results[1].rows;payrollItems=results[2].rows;
    employeeCosts=results[3].rows;advances=results[4].rows;
  }

  if(section==="documents"&&can("report_documents.view")){
    const results=await Promise.all([
      query<Row>(`
        select i.id,i.invoice_number,i.issued_on,i.currency,i.total_amount,
          f.display_name family_name,concat_ws(' ',s.first_name,s.last_name) student_name
        from invoice i join family f on f.id=i.family_id join student s on s.id=i.student_id
        where i.status not in ('draft','void') order by i.issued_on desc,i.created_at desc limit 100`),
      query<Row>(`
        select p.id,p.receipt_number,p.received_on,p.currency,p.amount,f.display_name family_name
        from payment p join family f on f.id=p.family_id
        order by p.received_on desc,p.created_at desc limit 100`),
      query<Row>(`
        select e.id,e.expense_number,e.incurred_on,e.currency,e.amount,e.status,
          coalesce(s.name,'Direct expense') supplier_name
        from expense e left join supplier s on s.id=e.supplier_id
        where e.status in ('posted','reversed')
        order by e.incurred_on desc,e.created_at desc limit 100`),
      query<Row>("select id,supplier_number,name from supplier order by name limit 100"),
    ]);
    documentInvoices=results[0].rows;documentPayments=results[1].rows;documentExpenses=results[2].rows;documentSuppliers=results[3].rows;
    if(payrollInstalled&&can("payroll.view")){
      payslips=(await query<Row>(`
        select i.id,r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status,
          e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,i.net_pay
        from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id
        join employee e on e.id=i.employee_id
        where r.status in ('locked','paid')
        order by r.period_end desc,e.last_name,e.first_name limit 100`)).rows;
    }
  }

  const exportHref=(kind:string)=>"/reports/export?"+new URLSearchParams({kind,from,to}).toString();

  return <main className="app-shell report-shell">
    <header className="topbar">
      <div>
        <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
        <h1>Net Position, Management & Reports</h1>
        <p className="muted">Read-only management reporting from posted accounting, billing, enrollment, rentals and payroll records.</p>
      </div>
      <div className="top-actions no-print">
        <a className="button-link secondary-link" href="/dashboard">Administration</a>
        {can("accounting.view")?<a className="button-link secondary-link" href="/accounting">Accounting</a>:null}
      </div>
    </header>

    <section className="panel report-filter no-print">
      <form className="inline-form" action="/reports" method="get">
        <input type="hidden" name="section" value={section}/>
        <label>From<input type="date" name="from" defaultValue={from}/></label>
        <label>To<input type="date" name="to" defaultValue={to}/></label>
        <button type="submit">Apply period</button>
      </form>
    </section>

    <nav className="report-nav no-print" aria-label="Report sections">
      {visibleSections.map((item)=><a key={item} className={section===item?"active":""} href={"/reports"+qs(from,to,item)}>{title(item)}</a>)}
    </nav>

    {section==="overview"?<>
      <section className="status-grid">
        <article className="panel"><p className="eyebrow">Active students</p><h2 className="metric-value">{activeStudents}</h2><p className="muted compact-text">Active enrollment on {to}.</p></article>
        <Metric label="Expected fees" values={expected} note={"Invoice amounts due from "+from+" through "+to+"."}/>
        <Metric label="Collected fees" values={collected} note="Parent payments received in the selected period and allocated to invoices by the end date."/>
        <Metric label="Outstanding" values={outstanding} note={"Student receivables still open as of "+to+"."}/>
        <Metric label="Cash" values={cash} note="Cash-account balances as of the report date."/>
        <Metric label="Bank" values={bank} note="Bank-account balances as of the report date."/>
        <Metric label="Expenses" values={expenses} note="Posted expense-account activity in the selected period."/>
        <Metric label="Rent due" values={rentDue} note="Rent Payable accounting balance as of the report date."/>
        <Metric label="Payroll due" values={payrollDue} note={payrollInstalled?"Salary/payroll payable as of the report date.":"Payroll module is not installed on this branch yet."}/>
        <Metric label="Net position" values={netPosition} note="Assets less liabilities as of the report date."/>
        <Metric label="Prepayments" values={prepayments} note="Unallocated family funds and credits as of the report date."/>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Accounting control</p><h2>Position reconciliation</h2><p className="muted">Every currency must keep an accounting equation difference of exactly zero.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Currency</th><th>Assets</th><th>Liabilities</th><th>Equity</th><th>Income</th><th>Expenses</th><th>Surplus</th><th>Net position</th><th>Difference</th></tr></thead>
        <tbody>{positionResult.rows.map((x)=><tr key={x.currency}><td>{x.currency}</td><td>{money(x.assets,x.currency)}</td><td>{money(x.liabilities,x.currency)}</td><td>{money(x.equity,x.currency)}</td><td>{money(x.income,x.currency)}</td><td>{money(x.expenses,x.currency)}</td><td>{money(x.current_surplus,x.currency)}</td><td><strong>{money(x.net_position,x.currency)}</strong></td><td><strong>{money(x.equation_difference,x.currency)}</strong></td></tr>)}</tbody></table></div>
      </section>
    </>:null}

    {section==="financial"&&can("reports.view")?<>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Financial statements</p><h2>Profit & Loss</h2><p className="muted">{from} through {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("profit-loss")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Account</th><th>Category</th><th>Currency</th><th>Amount</th></tr></thead><tbody>{plResult.rows.filter((x)=>Number(x.amount)!==0).map((x)=><tr key={x.account_id}><td>{x.account_code} · {x.account_name}</td><td>{title(x.category)}</td><td>{x.currency}</td><td>{money(x.amount,x.currency)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Financial position</p><h2>Balance Sheet / Net Position</h2><p className="muted">As of {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("balance-sheet")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Currency</th><th>Assets</th><th>Liabilities</th><th>Equity</th><th>Current surplus</th><th>Net position</th><th>Difference</th></tr></thead><tbody>{positionResult.rows.map((x)=><tr key={x.currency}><td>{x.currency}</td><td>{money(x.assets,x.currency)}</td><td>{money(x.liabilities,x.currency)}</td><td>{money(x.equity,x.currency)}</td><td>{money(x.current_surplus,x.currency)}</td><td><strong>{money(x.net_position,x.currency)}</strong></td><td>{money(x.equation_difference,x.currency)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Controls</p><h2>Trial Balance</h2><p className="muted">As of {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("trial-balance")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Account</th><th>Currency</th><th>Debit</th><th>Credit</th><th>Debit balance</th><th>Credit balance</th></tr></thead><tbody>{trialBalance.filter((x)=>Number(x.total_debit)!==0||Number(x.total_credit)!==0).map((x)=><tr key={x.account_id}><td>{x.account_code} · {x.account_name}</td><td>{x.currency}</td><td>{money(x.total_debit,x.currency)}</td><td>{money(x.total_credit,x.currency)}</td><td>{money(x.debit_balance,x.currency)}</td><td>{money(x.credit_balance,x.currency)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Cash Flow</p><h2>Cash movement</h2><p className="muted">Direct cash/bank movement classification; internal transfers cancel at consolidated level.</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("cash-flow")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Class</th><th>Source</th><th>Currency</th><th>Inflow</th><th>Outflow</th><th>Net</th></tr></thead><tbody>{cashFlow.map((x)=><tr key={[x.activity_class,x.source_type,x.currency].join(":")}><td>{title(x.activity_class)}</td><td>{title(x.source_type)}</td><td>{x.currency}</td><td>{money(x.inflow,x.currency)}</td><td>{money(x.outflow,x.currency)}</td><td><strong>{money(x.net_change,x.currency)}</strong></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Accounts Receivable</p><h2>Outstanding student balances</h2><p className="muted">As of {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("receivables")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Due</th><th>Invoice</th><th>Family</th><th>Student</th><th>Total</th><th>Paid</th><th>Credits</th><th>Outstanding</th></tr></thead><tbody>{receivablesResult.rows.map((x)=><tr key={x.invoice_id}><td>{date(x.due_on)}</td><td>{x.invoice_number}</td><td>{x.family_number} · {x.family_name}</td><td>{x.student_number} · {x.student_name}</td><td>{money(x.total_amount,x.currency)}</td><td>{money(x.paid_amount,x.currency)}</td><td>{money(x.credit_amount,x.currency)}</td><td><strong>{money(x.balance_amount,x.currency)}</strong></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Accounts Payable</p><h2>Outstanding supplier balances</h2><p className="muted">As of {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("payables")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Due</th><th>Bill</th><th>Supplier</th><th>Total</th><th>Paid</th><th>Credits</th><th>Outstanding</th></tr></thead><tbody>{payables.map((x)=><tr key={x.supplier_invoice_id}><td>{date(x.due_on)}</td><td>{x.supplier_invoice_number}</td><td>{x.supplier_number} · {x.supplier_name}</td><td>{money(x.total_amount,x.currency)}</td><td>{money(x.paid_amount,x.currency)}</td><td>{money(x.credit_amount,x.currency)}</td><td><strong>{money(x.balance_amount,x.currency)}</strong></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">General Ledger</p><h2>Posted ledger activity</h2><p className="muted">Showing up to 1,000 lines for {from} through {to}.</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("general-ledger")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Entry</th><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th><th>Running balance</th></tr></thead><tbody>{ledger.map((x)=><tr key={x.journal_entry_id+":"+x.line_number}><td>{date(x.posting_date)}</td><td>{x.entry_number}<div className="muted">{title(x.source_type??x.entry_kind)}</div></td><td>{x.account_code} · {x.account_name}</td><td>{x.line_description??x.entry_description}</td><td>{Number(x.debit)?money(x.debit,x.currency):"—"}</td><td>{Number(x.credit)?money(x.credit,x.currency):"—"}</td><td>{money(x.running_balance,x.currency)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="record-grid">
        <article className="panel"><p className="eyebrow">Expense report</p><h2><MoneyStack values={expenses}/></h2>{can("reports.export")?<a href={exportHref("expenses")}>Export account detail</a>:null}</article>
        <article className="panel"><p className="eyebrow">Income report</p><h2><MoneyStack values={currencyTotals(plResult.rows.filter((x)=>x.category==="income"),"amount")}/></h2>{can("reports.export")?<a href={exportHref("income")}>Export account detail</a>:null}</article>
        <article className="panel"><p className="eyebrow">Cash & bank</p><h2><MoneyStack values={currencyTotals(cashBankResult.rows,"balance")}/></h2>{can("reports.export")?<a href={exportHref("cash-bank")}>Export balances</a>:null}</article>
      </section>
    </>:null}

    {section==="school"&&can("reports.view")?<>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Students</p><h2>Student report</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("students")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Student</th><th>Family</th><th>Status</th><th>Admission</th><th>Exit</th></tr></thead><tbody>{students.map((x)=><tr key={x.id}><td>{x.student_number} · {x.student_name}</td><td>{x.family_number} · {x.family_name}</td><td>{title(x.status)}</td><td>{date(x.admission_date)||"—"}</td><td>{date(x.exit_date)||"—"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Families</p><h2>Family report</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("families")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Family</th><th>Students</th><th>Active students</th><th>Statement</th></tr></thead><tbody>{families.map((x)=><tr key={x.id}><td>{x.family_number} · {x.display_name}</td><td>{x.student_count}</td><td>{x.active_student_count}</td><td>{can("report_documents.view")?<a href={"/reports/documents/family-statement/"+x.id}>Open statement</a>:"—"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Enrollment</p><h2>Enrollment report</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("enrollments")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Student</th><th>School year</th><th>Class</th><th>Start</th><th>Status</th><th>Withdrawal</th></tr></thead><tbody>{enrollments.map((x)=><tr key={x.enrollment_id}><td>{x.student_number} · {x.student_name}</td><td>{x.school_year_name}</td><td>{x.class_name}</td><td>{date(x.starts_on)}</td><td>{title(x.enrollment_status)}</td><td>{date(x.withdrawal_on)||"—"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Fees</p><h2>Fee report</h2><p className="muted">{from} through {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("fees")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Student</th><th>Term</th><th>Gross</th><th>Discount</th><th>Net</th><th>Status</th></tr></thead><tbody>{fees.map((x)=><tr key={x.id}><td>{x.invoice_number}<div className="muted">{date(x.issued_on)}</div></td><td>{x.student_name}<div className="muted">{x.family_name}</div></td><td>{x.term_name}</td><td>{money(x.subtotal_amount,x.currency)}</td><td>{money(x.discount_amount,x.currency)}</td><td><strong>{money(x.total_amount,x.currency)}</strong></td><td>{title(x.status)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Discounts</p><h2>Applied discount report</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("discounts")}>Export CSV</a>:null}</div>
        <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Student</th><th>Discount</th><th>Rule</th><th>Applied</th></tr></thead><tbody>{discounts.map((x,i)=><tr key={x.invoice_line_id+":"+i}><td>{x.invoice_number}</td><td>{x.student_name}</td><td>{x.discount_label}</td><td>{title(x.discount_kind)} {x.discount_value} · {title(x.combination_mode)}</td><td>{money(x.applied_amount,x.currency)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="record-grid">
        <article className="panel"><p className="eyebrow">Outstanding balances</p><h2><MoneyStack values={outstanding}/></h2>{can("reports.export")?<a href={exportHref("outstanding")}>Export detail</a>:null}</article>
        <article className="panel"><p className="eyebrow">Prepayments</p><h2><MoneyStack values={prepayments}/></h2>{can("reports.export")?<a href={exportHref("prepayments")}>Export detail</a>:null}</article>
      </section>
    </>:null}

    {section==="payroll"&&can("reports.view")&&can("payroll.view")?<>
      {!payrollInstalled?<section className="panel section-block"><div className="notice">Payroll is not installed in this database yet. Step 8 will show payroll reports automatically after the Step 7 migrations are applied.</div></section>:<>
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Salary history</p><h2>Immutable salary agreements</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("salary-history")}>Export CSV</a>:null}</div>
          <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Job title</th><th>Effective from</th><th>Effective to</th><th>Monthly salary</th><th>Notes</th></tr></thead><tbody>{salaryHistory.map((x)=><tr key={x.id}><td>{x.employee_number} · {x.employee_name}</td><td>{x.job_title||"—"}</td><td>{date(x.effective_from)}</td><td>{date(x.effective_to)||"Current"}</td><td>{money(x.monthly_salary,x.currency)}</td><td>{x.notes||"—"}</td></tr>)}</tbody></table></div>
        </section>
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Payroll</p><h2>Payroll runs</h2><p className="muted">{from} through {to}</p></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("payroll")}>Export CSV</a>:null}</div>
          <div className="table-wrap"><table><thead><tr><th>Run</th><th>Period</th><th>Pay date</th><th>Status</th><th>Employees</th><th>Gross</th><th>Employee cost</th><th>Advance repayments</th><th>Net pay</th></tr></thead><tbody>{payrollRuns.map((x)=><tr key={x.id}><td>{x.run_number}</td><td>{date(x.period_start)} → {date(x.period_end)}</td><td>{date(x.pay_date)}</td><td>{title(x.status)}</td><td>{x.employee_count}</td><td>{money(x.gross_pay,x.currency)}</td><td>{money(x.payroll_expense,x.currency)}</td><td>{money(x.advance_repayments,x.currency)}</td><td><strong>{money(x.net_pay,x.currency)}</strong></td></tr>)}</tbody></table></div>
          <h3>Employee payroll detail</h3>
          <div className="table-wrap"><table><thead><tr><th>Run / employee</th><th>Base</th><th>Allowances</th><th>Bonus</th><th>Deductions</th><th>Advance</th><th>Gross</th><th>Net</th></tr></thead><tbody>{payrollItems.map((x)=><tr key={x.id}><td>{x.run_number}<div className="muted">{x.employee_number} · {x.employee_name}</div></td><td>{money(x.base_salary,x.currency)}</td><td>{money(x.allowance_total,x.currency)}</td><td>{money(x.bonus_total,x.currency)}</td><td>{money(x.deduction_total,x.currency)}</td><td>{money(x.advance_repayment_total,x.currency)}</td><td>{money(x.gross_pay,x.currency)}</td><td><strong>{money(x.net_pay,x.currency)}</strong></td></tr>)}</tbody></table></div>
        </section>
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Employee cost</p><h2>Locked payroll employee cost</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("employee-cost")}>Export CSV</a>:null}</div>
          <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Currency</th><th>Payrolls</th><th>Base</th><th>Allowances</th><th>Bonuses</th><th>Deductions</th><th>Employee cost</th><th>Net pay</th></tr></thead><tbody>{employeeCosts.map((x)=><tr key={x.employee_id+":"+x.currency}><td>{x.employee_number} · {x.employee_name}</td><td>{x.currency}</td><td>{x.payroll_count}</td><td>{money(x.base_salary,x.currency)}</td><td>{money(x.allowances,x.currency)}</td><td>{money(x.bonuses,x.currency)}</td><td>{money(x.deductions,x.currency)}</td><td><strong>{money(x.employee_cost,x.currency)}</strong></td><td>{money(x.net_pay,x.currency)}</td></tr>)}</tbody></table></div>
        </section>
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Salary advances</p><h2>Advance balances & repayments</h2></div>{can("reports.export")?<a className="button-link no-print" href={exportHref("advances")}>Export CSV</a>:null}</div>
          <div className="table-wrap"><table><thead><tr><th>Advance</th><th>Employee</th><th>Date</th><th>Installments</th><th>Original</th><th>Repaid</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>{advances.map((x)=><tr key={x.id}><td>{x.advance_number}</td><td>{x.employee_number} · {x.employee_name}</td><td>{date(x.advance_date)}</td><td>{x.installments_count}</td><td>{money(x.amount,x.currency)}</td><td>{money(x.repaid_amount,x.currency)}</td><td><strong>{money(x.outstanding_amount,x.currency)}</strong></td><td>{title(x.status)}</td></tr>)}</tbody></table></div>
        </section>
      </>}
    </>:null}

    {section==="documents"&&can("report_documents.view")?<>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Invoices</p><h2>Printable invoices</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Family / student</th><th>Total</th><th /></tr></thead><tbody>{documentInvoices.map((x)=><tr key={x.id}><td>{date(x.issued_on)}</td><td>{x.invoice_number}</td><td>{x.family_name}<div className="muted">{x.student_name}</div></td><td>{money(x.total_amount,x.currency)}</td><td><a href={"/reports/documents/invoice/"+x.id}>Open</a></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Receipts</p><h2>Printable payment receipts</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Receipt</th><th>Family</th><th>Amount</th><th /></tr></thead><tbody>{documentPayments.map((x)=><tr key={x.id}><td>{date(x.received_on)}</td><td>{x.receipt_number}</td><td>{x.family_name}</td><td>{money(x.amount,x.currency)}</td><td><a href={"/receipts/"+x.id}>Open</a></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Expense vouchers</p><h2>Posted expense documents</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Voucher</th><th>Supplier</th><th>Amount</th><th>Status</th><th /></tr></thead><tbody>{documentExpenses.map((x)=><tr key={x.id}><td>{date(x.incurred_on)}</td><td>{x.expense_number}</td><td>{x.supplier_name}</td><td>{money(x.amount,x.currency)}</td><td>{title(x.status)}</td><td><a href={"/reports/documents/expense-voucher/"+x.id}>Open</a></td></tr>)}</tbody></table></div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Supplier statements</p><h2>Printable supplier statements</h2></div></div>
        <div className="card-list">{documentSuppliers.map((x)=><article className="subcard row-between" key={x.id}><div><strong>{x.supplier_number} · {x.name}</strong></div><a href={"/reports/documents/supplier-statement/"+x.id}>Open statement</a></article>)}</div>
      </section>
      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Payslips</p><h2>Payroll documents</h2></div></div>
        {!payrollInstalled?<p className="muted">Payslips become available when Step 7 payroll is installed.</p>:!can("payroll.view")?<p className="muted">Payroll permission is required to view payslips.</p>:<div className="table-wrap"><table><thead><tr><th>Period</th><th>Employee</th><th>Run</th><th>Net pay</th><th /></tr></thead><tbody>{payslips.map((x)=><tr key={x.id}><td>{date(x.period_start)} → {date(x.period_end)}</td><td>{x.employee_number} · {x.employee_name}</td><td>{x.run_number}</td><td>{money(x.net_pay,x.currency)}</td><td><a href={"/reports/documents/payslip/"+x.id}>Open</a></td></tr>)}</tbody></table></div>}
      </section>
    </>:null}
  </main>;
}
