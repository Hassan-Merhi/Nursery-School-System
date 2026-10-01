import { query } from "@/lib/db";
import { getAuthContext } from "@/lib/security";

export const runtime="nodejs";
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

type Definition={sql:string;params:(from:string,to:string)=>unknown[]};
const definitions:Record<string,Definition>={
  "general-ledger":{
    sql:"select * from report_general_ledger($1::date,$2::date) order by posting_date,entry_number,line_number",
    params:(from,to)=>[from,to],
  },
  "trial-balance":{
    sql:"select * from report_trial_balance($1::date) order by currency,account_code",
    params:(_from,to)=>[to],
  },
  "profit-loss":{
    sql:"select * from report_profit_loss($1::date,$2::date) where amount<>0 order by currency,category,account_code",
    params:(from,to)=>[from,to],
  },
  "balance-sheet":{
    sql:"select * from report_position($1::date) order by currency",
    params:(_from,to)=>[to],
  },
  "cash-flow":{
    sql:"select * from report_cash_flow($1::date,$2::date)",
    params:(from,to)=>[from,to],
  },
  "receivables":{
    sql:"select * from report_receivables($1::date) where balance_amount<>0 order by due_on,invoice_number",
    params:(_from,to)=>[to],
  },
  "outstanding":{
    sql:"select * from report_receivables($1::date) where balance_amount<>0 order by due_on,invoice_number",
    params:(_from,to)=>[to],
  },
  "payables":{
    sql:"select * from report_payables($1::date) where balance_amount<>0 order by due_on,supplier_invoice_number",
    params:(_from,to)=>[to],
  },
  "prepayments":{
    sql:"select * from report_family_credits($1::date) where available_credit<>0 order by family_name,currency",
    params:(_from,to)=>[to],
  },
  "cash-bank":{
    sql:"select * from report_cash_bank_balances($1::date) order by account_kind,display_name",
    params:(_from,to)=>[to],
  },
  "expenses":{
    sql:"select * from report_profit_loss($1::date,$2::date) where category='expense' and amount<>0 order by currency,account_code",
    params:(from,to)=>[from,to],
  },
  "income":{
    sql:"select * from report_profit_loss($1::date,$2::date) where category='income' and amount<>0 order by currency,account_code",
    params:(from,to)=>[from,to],
  },
  "salary-history":{
    sql:`select h.id,e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
      jt.name job_title,h.effective_from,h.effective_to,h.monthly_salary,h.currency,h.notes
      from employee_salary_history h join employee e on e.id=h.employee_id
      left join job_title jt on jt.id=e.job_title_id
      order by e.last_name,e.first_name,h.effective_from`,
    params:()=>[],
  },
  "payroll":{
    sql:`select * from payroll_run_summary
      where period_end>=$1::date and period_start<=$2::date
      order by period_end,run_number`,
    params:(from,to)=>[from,to],
  },
  "employee-cost":{
    sql:`select e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
      r.currency,count(distinct r.id)::int payroll_count,
      coalesce(sum(i.base_salary),0)::numeric(14,2) base_salary,
      coalesce(sum(i.allowance_total),0)::numeric(14,2) allowances,
      coalesce(sum(i.bonus_total),0)::numeric(14,2) bonuses,
      coalesce(sum(i.deduction_total),0)::numeric(14,2) deductions,
      coalesce(sum(i.payroll_expense),0)::numeric(14,2) employee_cost,
      coalesce(sum(i.net_pay),0)::numeric(14,2) net_pay
      from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id
      join employee e on e.id=i.employee_id
      where r.status in ('locked','paid') and r.period_end>=$1::date and r.period_start<=$2::date
      group by e.id,r.currency order by e.last_name,e.first_name,r.currency`,
    params:(from,to)=>[from,to],
  },
  "advances":{
    sql:`select b.advance_number,b.advance_date,b.currency,b.amount,b.installments_count,
      b.first_repayment_on,b.status,e.employee_number,concat_ws(' ',e.first_name,e.last_name) employee_name,
      b.repaid_amount,b.outstanding_amount
      from salary_advance_balance b join employee e on e.id=b.employee_id
      order by b.advance_date,e.last_name,e.first_name`,
    params:()=>[],
  },
  "students":{
    sql:`select s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,
      f.family_number,f.display_name family_name,s.status,s.date_of_birth,s.admission_date,s.exit_date
      from student s join family f on f.id=s.family_id order by s.last_name,s.first_name`,
    params:()=>[],
  },
  "families":{
    sql:`select f.family_number,f.display_name,
      count(s.id)::int student_count,
      count(s.id) filter (where s.status='active')::int active_student_count
      from family f left join student s on s.family_id=f.id
      group by f.id order by f.display_name`,
    params:()=>[],
  },
  "enrollments":{
    sql:"select * from report_enrollment order by starts_on,student_name",
    params:()=>[],
  },
  "fees":{
    sql:`select i.invoice_number,i.issued_on,i.due_on,i.currency,i.subtotal_amount,
      i.discount_amount,i.total_amount,i.status,f.family_number,f.display_name family_name,
      s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,t.name term_name
      from invoice i join family f on f.id=i.family_id join student s on s.id=i.student_id
      join school_term t on t.id=i.term_id
      where i.issued_on between $1::date and $2::date and i.status not in ('draft','void')
      order by i.issued_on,i.invoice_number`,
    params:(from,to)=>[from,to],
  },
  "discounts":{
    sql:`select invoice_number,issued_on,currency,family_number,family_name,student_number,student_name,
      term_name,line_description,gross_amount,discount_label,discount_kind,discount_value,
      applied_amount,combination_mode
      from report_fee_discount
      where issued_on between $1::date and $2::date and applied_amount is not null
      order by issued_on,student_name,invoice_number`,
    params:(from,to)=>[from,to],
  },
};

function csvCell(value:unknown){
  if(value===null||value===undefined)return "";
  let raw=value instanceof Date?value.toISOString():typeof value==="object"?JSON.stringify(value):String(value);
  if(/^[=+\-@]/.test(raw))raw="'"+raw;
  if(/[",\r\n]/.test(raw))return '"'+raw.replaceAll('"','""')+'"';
  return raw;
}

export async function GET(request:Request){
  const auth=await getAuthContext();
  if(!auth)return new Response("Unauthorized",{status:401});
  if(!auth.permissions.includes("reports.export"))return new Response("Forbidden",{status:403});

  const url=new URL(request.url);
  const kind=url.searchParams.get("kind")??"";
  const from=url.searchParams.get("from")??"";
  const to=url.searchParams.get("to")??"";
  if(!DATE_RE.test(from)||!DATE_RE.test(to)||to<from)return new Response("Invalid report period",{status:400});
  const definition=definitions[kind];
  if(!definition)return new Response("Unknown report",{status:404});
  if(["salary-history","payroll","employee-cost","advances"].includes(kind)){
    if(!auth.permissions.includes("payroll.view"))return new Response("Forbidden",{status:403});
    const installed=(await query<{installed:boolean}>("select to_regclass('employee') is not null installed")).rows[0]?.installed;
    if(!installed)return new Response("Payroll is not installed",{status:409});
  }

  const result=await query(definition.sql,definition.params(from,to));
  const headers=result.fields.map((field)=>field.name);
  const lines=[headers.map(csvCell).join(",")];
  for(const row of result.rows){
    lines.push(headers.map((header)=>csvCell(row[header])).join(","));
  }
  const body="\uFEFF"+lines.join("\r\n")+"\r\n";
  const filename=("montikids-"+kind+"-"+from+"-to-"+to+".csv").replace(/[^a-zA-Z0-9._-]/g,"_");
  return new Response(body,{
    headers:{
      "Content-Type":"text/csv; charset=utf-8",
      "Content-Disposition":`attachment; filename="${filename}"`,
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff",
    },
  });
}
