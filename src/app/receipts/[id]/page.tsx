import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";

function money(amount:unknown,currency:string){
  const n=Number(amount??0);
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2}).format(n);}
  catch{return currency+" "+n.toFixed(2);}
}

export default async function ReceiptPage({params}:{params:Promise<{id:string}>}){
  const auth=await requireUser();
  if(!["payments.view","payments.manage","report_documents.view"].some((p)=>auth.permissions.includes(p)))redirect("/forbidden");
  const {id}=await params;
  const payment=(await query<any>(
    `select p.*,f.family_number,f.display_name as family_name,
       s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
       a.name as payment_account_name,a.code as payment_account_code
     from payment_balance p
     join family f on f.id=p.family_id
     left join student s on s.id=p.student_id
     left join account a on a.id=p.payment_account_id
     where p.id=$1`,[id])).rows[0];
  if(!payment)notFound();
  const allocations=(await query<any>(
    `select pa.amount,pa.allocated_on,i.invoice_number,
       concat_ws(' ',s.first_name,s.last_name) as student_name
     from payment_allocation pa
     join invoice i on i.id=pa.invoice_id
     join student s on s.id=i.student_id
     where pa.payment_id=$1 order by pa.allocated_on,pa.created_at`,[id])).rows;

  return <main className="app-shell">
    <header className="topbar no-print"><div><p className="eyebrow">Montikids Montessori Preschool & Nursery</p><h1>Payment receipt</h1></div><div className="top-actions"><Link className="button-link secondary-link" href="/billing">Back to billing</Link></div></header>
    <section className="panel receipt-sheet">
      <div className="row-between"><div><p className="eyebrow">Official receipt</p><h1>{payment.receipt_number}</h1></div><div><strong>{money(payment.amount,payment.currency)}</strong><div className="muted">{String(payment.received_on).slice(0,10)}</div></div></div>
      <hr/>
      <div className="record-grid">
        <div><small>Family</small><strong>{payment.family_number} · {payment.family_name}</strong></div>
        <div><small>Student</small><strong>{payment.student_name||"Family-level payment"}</strong></div>
        <div><small>Payment type</small><strong>{String(payment.payment_kind).replaceAll("_"," ")}</strong></div>
        <div><small>Method</small><strong>{payment.method==="check"?"Cheque":String(payment.method).replaceAll("_"," ")}</strong></div>
        <div><small>Received into</small><strong>{payment.payment_account_name?payment.payment_account_code+" · "+payment.payment_account_name:"Default mapped payment asset"}</strong></div>
        <div><small>Status</small><strong>{payment.status}</strong></div>
      </div>
      {payment.cheque_number?<p><strong>Cheque:</strong> {payment.cheque_number}{payment.cheque_due_on?" · due "+String(payment.cheque_due_on).slice(0,10):""}</p>:null}
      {payment.reference?<p><strong>Reference:</strong> {payment.reference}</p>:null}
      {payment.notes?<p><strong>Notes:</strong> {payment.notes}</p>:null}
      <h2>Allocation</h2>
      <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Student</th><th>Date</th><th>Applied</th></tr></thead><tbody>
        {allocations.map((x:any)=><tr key={x.invoice_number}><td>{x.invoice_number}</td><td>{x.student_name}</td><td>{String(x.allocated_on).slice(0,10)}</td><td>{money(x.amount,payment.currency)}</td></tr>)}
        {!allocations.length?<tr><td colSpan={4}>No invoice allocation — funds remain as parent credit/prepayment.</td></tr>:null}
      </tbody></table></div>
      <div className="record-grid"><div><small>Allocated</small><strong>{money(payment.allocated_amount,payment.currency)}</strong></div><div><small>Available credit</small><strong>{money(payment.unallocated_amount,payment.currency)}</strong></div><div><small>Total received</small><strong>{money(payment.amount,payment.currency)}</strong></div></div>
      {payment.status==="reversed"?<div className="notice error">REVERSED · {payment.reversal_reason||"Payment reversed"}</div>:null}
      <p className="muted">This receipt is generated from the immutable payment record. Use your browser print command to print or save it as PDF.</p>
    </section>
  </main>;
}
