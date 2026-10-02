import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import {
  activateRentalAgreementAction,
  configureRentalMappingAction,
  configureRentalsJournalAction,
  createLandlordAction,
  createRentalAgreementAction,
  createRentPaymentAction,
  endRentalAgreementAction,
  recognizeRentThroughAction,
  reverseRentPaymentAction,
  reverseRentRecognitionAction,
  updateLandlordAction,
  updateRentalAgreementAction,
} from "./actions";

type Row=Record<string,any>;

function iso(value:unknown){return String(value??"").slice(0,10);}
function money(amount:unknown,currency="USD"){
  const n=Number(amount??0);
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}
  catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}
}
function title(value:unknown){return String(value??"").replaceAll("_"," ").replace(/\b\w/g,(m)=>m.toUpperCase());}

export default async function RentalsPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const auth=await requireUser();
  const {error,success}=await searchParams;
  const can=(p:string)=>auth.permissions.includes(p);
  const rentalPermissions=[
    "rentals.view","rentals.manage","rentals.pay","rentals.post",
    "rental_documents.view","rental_documents.manage",
  ];
  const canRental=rentalPermissions.some(can);
  if(!canRental&&!can("accounting.mapping"))redirect("/forbidden");

  const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text as today")).rows[0]?.today??"";
  const currencySetting=(await query<{currency:string|null}>("select value #>> '{}' as currency from app_setting where key='currency'")).rows[0]?.currency??"USD";
  const canSeeData=canRental;

  const [
    journalsResult,configResult,rolesResult,accountsResult,landlordsResult,agreementsResult,
    schedulesResult,paymentsResult,recognitionsResult,attachmentsResult,historyResult,cashBankResult,
  ]=await Promise.all([
    (can("accounting.mapping")||canSeeData)?query<Row>("select id,code,name from journal where status='active' order by code"):Promise.resolve({rows:[]} as any),
    (can("accounting.mapping")||canSeeData)?query<Row>("select rentals_journal_id from accounting_configuration where id=1"):Promise.resolve({rows:[]} as any),
    (can("accounting.mapping")||canSeeData)?query<Row>(`
      select d.role_key,d.name,d.description,d.required_category,m.account_id,
             a.code as account_code,a.name as account_name
      from accounting_role_definition d
      left join accounting_mapping m on m.role_key=d.role_key
      left join account a on a.id=m.account_id
      where d.role_key=any($1::text[])
      order by case d.role_key
        when 'rent_expense' then 1 when 'prepaid_rent' then 2
        when 'rent_payable' then 3 else 4 end`,
      [["rent_expense","prepaid_rent","rent_payable","rent_deposit"]]):Promise.resolve({rows:[]} as any),
    (can("accounting.mapping")||canSeeData)?query<Row>(`
      select a.id,a.code,a.name,a.currency,t.category
      from account a join account_type t on t.id=a.account_type_id
      where a.status='active' and a.allow_posting=true
      order by a.code`):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>("select * from landlord order by name"):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>("select * from rental_agreement_balance order by start_on desc,created_at desc"):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>("select * from rent_schedule_balance order by rental_agreement_id,sequence"):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>(`
      select p.*,cb.display_name as payment_account_name,
        coalesce(json_agg(json_build_object(
          'scheduleId',s.id,'sequence',s.sequence,'periodStart',s.period_start,
          'periodEnd',s.period_end,'amount',pa.amount,'allocationType',pa.allocation_type
        ) order by s.sequence) filter (where pa.id is not null),'[]') as allocations
      from rent_payment p
      join cash_bank_account cb on cb.account_id=p.payment_account_id
      left join rent_payment_allocation pa on pa.rent_payment_id=p.id
      left join rent_schedule s on s.id=pa.rent_schedule_id
      group by p.id,cb.display_name
      order by p.paid_on desc,p.created_at desc`):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>(`
      select r.*,s.rental_agreement_id,s.sequence,s.period_start,s.period_end,a.agreement_number
      from rent_recognition r
      join rent_schedule s on s.id=r.rent_schedule_id
      join rental_agreement a on a.id=s.rental_agreement_id
      order by r.recognition_date desc,r.created_at desc`):Promise.resolve({rows:[]} as any),
    can("rental_documents.view")?query<Row>(`
      select ra.*,d.original_name,d.mime_type,d.size_bytes
      from rental_attachment ra
      join stored_document d on d.id=ra.document_id
      order by ra.attached_at desc`):Promise.resolve({rows:[]} as any),
    canSeeData?query<Row>(`
      select h.*,u.full_name as actor_name
      from rental_history h
      left join app_user u on u.id=h.actor_user_id
      order by h.occurred_at desc,h.id desc`):Promise.resolve({rows:[]} as any),
    (can("rentals.pay")||canSeeData)?query<Row>("select * from cash_bank_balance where is_active=true order by account_kind,display_name"):Promise.resolve({rows:[]} as any),
  ]);

  const journals=journalsResult.rows as Row[],config=(configResult.rows[0]??{}) as Row,roles=rolesResult.rows as Row[],accounts=accountsResult.rows as Row[];
  const landlords=landlordsResult.rows as Row[],agreements=agreementsResult.rows as Row[],schedules=schedulesResult.rows as Row[],payments=paymentsResult.rows as Row[];
  const recognitions=recognitionsResult.rows as Row[],attachments=attachmentsResult.rows as Row[],history=historyResult.rows as Row[],cashBank=cashBankResult.rows as Row[];
  const activeAgreements=agreements.filter((x)=>x.status==="active");
  const totalPrepaid=agreements.reduce((sum,x)=>sum+Number(x.prepaid_rent_balance??0),0);
  const totalPayable=agreements.reduce((sum,x)=>sum+Number(x.rent_payable_balance??0),0);
  const totalRecognized=agreements.reduce((sum,x)=>sum+Number(x.recognized_rent_expense??0),0);
  const setupComplete=Boolean(config.rentals_journal_id)&&roles.length===4&&roles.every((x)=>x.account_id);

  return <main className="app-shell">
    <header className="page-header">
      <div>
        <h1>Rentals</h1>
        <p className="muted">Rent agreements, landlords, and rent payments.</p>
      </div>
    </header>

    {error?<div className="notice error">{error}</div>:null}
    {success?<div className="notice success">{success}</div>:null}

    {canSeeData?<section className="status-grid">
      <article className="panel"><p className="eyebrow">Active agreements</p><h2>{activeAgreements.length}</h2><p className="muted">{agreements.length} total rental agreement{agreements.length===1?"":"s"}.</p></article>
      <article className="panel"><p className="eyebrow">Prepaid rent</p><h2>{money(totalPrepaid,currencySetting)}</h2><p className="muted">Paid rent not yet recognized as expense.</p></article>
      <article className="panel"><p className="eyebrow">Rent payable</p><h2>{money(totalPayable,currencySetting)}</h2><p className="muted">Recognized rent still owed to landlords.</p></article>
      <article className="panel"><p className="eyebrow">Recognized expense</p><h2>{money(totalRecognized,currencySetting)}</h2><p className="muted">Rent recognized across all current records.</p></article>
    </section>:null}

    <section className="panel section-block">
      <div className="section-heading">
        <div><p className="eyebrow">Accounting setup</p><h2>Rental posting configuration</h2><p className="muted">Rentals use the same double-entry engine, open periods and immutable posted journals as the rest of Montikids.</p></div>
        <span className="badge">{setupComplete?"Ready":"Setup required"}</span>
      </div>
      <div className="record-grid">
        <div><small>Rentals journal</small><strong>{journals.find((j)=>j.id===config.rentals_journal_id)?.name??"Not configured"}</strong></div>
        {roles.map((role)=><div key={role.role_key}><small>{role.name}</small><strong>{role.account_code?role.account_code+" · "+role.account_name:"Not configured"}</strong></div>)}
      </div>
      {can("accounting.mapping")?<div className="record-grid">
        <form action={configureRentalsJournalAction} className="compact-form">
          <label>Rentals journal<select name="journal_id" defaultValue={config.rentals_journal_id??""} required><option value="" disabled>Select active journal</option>{journals.map((j)=><option key={j.id} value={j.id}>{j.code} · {j.name}</option>)}</select></label>
          <button type="submit">Save journal</button>
        </form>
        {roles.map((role)=><form action={configureRentalMappingAction} className="compact-form" key={role.role_key}>
          <input type="hidden" name="role_key" value={role.role_key}/>
          <label>{role.name}<select name="account_id" defaultValue={role.account_id??""} required><option value="" disabled>Select {role.required_category} account</option>{accounts.filter((a)=>a.category===role.required_category).map((a)=><option key={a.id} value={a.id}>{a.code} · {a.name} · {a.currency}</option>)}</select></label>
          <small className="muted">{role.description}</small>
          <button type="submit" className="secondary">Save mapping</button>
        </form>)}
      </div>:null}
    </section>

    {canSeeData?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Landlords</p><h2>Landlord profiles</h2></div></div>
      {can("rentals.manage")?<form action={createLandlordAction} className="form-grid create-box">
        <label>Name<input name="name" required/></label><label>Contact<input name="contact_name"/></label>
        <label>Email<input name="email" type="email"/></label><label>Phone<input name="phone"/></label>
        <label>Tax number<input name="tax_number"/></label><label>Address<input name="address"/></label>
        <label className="span-2">Notes<input name="notes"/></label><button type="submit">Create landlord</button>
      </form>:null}
      <div className="table-wrap"><table><thead><tr><th>Landlord</th><th>Contact</th><th>Address</th><th>Status / maintenance</th></tr></thead><tbody>
        {landlords.map((l)=><tr key={l.id}><td><strong>{l.landlord_number} · {l.name}</strong><div className="muted">{l.tax_number||"No tax number"}</div></td><td>{[l.contact_name,l.phone,l.email].filter(Boolean).join(" · ")||"—"}</td><td>{l.address||"—"}</td><td>
          {can("rentals.manage")?<form action={updateLandlordAction} className="compact-form">
            <input type="hidden" name="landlord_id" value={l.id}/>
            <label>Name<input name="name" defaultValue={l.name} required/></label><label>Contact<input name="contact_name" defaultValue={l.contact_name??""}/></label>
            <label>Email<input name="email" type="email" defaultValue={l.email??""}/></label><label>Phone<input name="phone" defaultValue={l.phone??""}/></label>
            <label>Address<input name="address" defaultValue={l.address??""}/></label><label>Tax no.<input name="tax_number" defaultValue={l.tax_number??""}/></label>
            <label>Notes<input name="notes" defaultValue={l.notes??""}/></label><label>Status<select name="status" defaultValue={l.status}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
            <button type="submit" className="secondary">Update</button>
          </form>:<span className="badge">{l.status}</span>}
        </td></tr>)}
        {!landlords.length?<tr><td colSpan={4}>No landlords yet.</td></tr>:null}
      </tbody></table></div>
    </section>:null}

    {canSeeData?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Agreements</p><h2>Rental agreements & rent schedules</h2><p className="muted">Activate a draft to generate its recurring schedule. Activated financial terms stay immutable so accounting history cannot be rewritten.</p></div></div>
      {can("rentals.manage")?<form action={createRentalAgreementAction} className="form-grid create-box">
        <label>Landlord<select name="landlord_id" defaultValue="" required><option value="" disabled>Select landlord</option>{landlords.filter((l)=>l.status==="active").map((l)=><option key={l.id} value={l.id}>{l.landlord_number} · {l.name}</option>)}</select></label>
        <label>Property name<input name="property_name" required/></label><label className="span-2">Property address<input name="property_address" required/></label>
        <label>Start date<input type="date" name="start_on" defaultValue={today} required/></label><label>End date<input type="date" name="end_on" required/></label>
        <label>Recurring rent<input type="number" name="recurring_amount" min="0.01" step="0.01" required/></label><label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
        <label>Frequency<select name="frequency" defaultValue="monthly"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>
        <label>Due day<input type="number" name="due_day" min="1" max="31" defaultValue="1" required/></label>
        <label>Refundable deposit<input type="number" name="deposit_amount" min="0" step="0.01" defaultValue="0.00" required/></label><label>Reference<input name="reference"/></label>
        <label className="span-2">Notes<input name="notes"/></label><button type="submit">Create draft agreement</button>
      </form>:null}

      <div className="card-list">
        {agreements.map((a)=>{
          const agreementSchedules=schedules.filter((s)=>s.rental_agreement_id===a.id);
          const agreementPayments=payments.filter((p)=>p.rental_agreement_id===a.id);
          const agreementAttachments=attachments.filter((x)=>x.rental_agreement_id===a.id);
          const agreementHistory=history.filter((x)=>x.rental_agreement_id===a.id);
          const activeRecognitions=recognitions.filter((r)=>r.rental_agreement_id===a.id&&r.status==="posted");
          return <article className="subcard" key={a.id}>
            <div className="row-between">
              <div><strong>{a.agreement_number} · {a.property_name}</strong><div className="muted">{a.landlord_number} · {a.landlord_name} · {a.property_address}</div></div>
              <span className="badge">{a.status}</span>
            </div>
            <p>{iso(a.start_on)} → {iso(a.end_on)} · {title(a.frequency)} · {money(a.recurring_amount,a.currency)} per period · due day {a.due_day}</p>
            <div className="record-grid">
              <div><small>Scheduled rent</small><strong>{money(a.scheduled_rent,a.currency)}</strong></div>
              <div><small>Paid rent</small><strong>{money(a.paid_rent,a.currency)}</strong></div>
              <div><small>Recognized expense</small><strong>{money(a.recognized_rent_expense,a.currency)}</strong></div>
              <div><small>Prepaid rent</small><strong>{money(a.prepaid_rent_balance,a.currency)}</strong></div>
              <div><small>Rent payable</small><strong>{money(a.rent_payable_balance,a.currency)}</strong></div>
              <div><small>Deposit</small><strong>{money(a.deposit_paid,a.currency)} / {money(a.deposit_amount,a.currency)}</strong></div>
            </div>

            {a.status==="draft"&&can("rentals.manage")?<div className="record-grid">
              <form action={updateRentalAgreementAction} className="compact-form">
                <input type="hidden" name="rental_agreement_id" value={a.id}/>
                <label>Landlord<select name="landlord_id" defaultValue={a.landlord_id} required>{landlords.filter((l)=>l.status==="active"||l.id===a.landlord_id).map((l)=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
                <label>Property<input name="property_name" defaultValue={a.property_name} required/></label><label>Address<input name="property_address" defaultValue={a.property_address} required/></label>
                <label>Start<input type="date" name="start_on" defaultValue={iso(a.start_on)} required/></label><label>End<input type="date" name="end_on" defaultValue={iso(a.end_on)} required/></label>
                <label>Rent<input type="number" name="recurring_amount" min="0.01" step="0.01" defaultValue={a.recurring_amount} required/></label><label>Currency<input name="currency" maxLength={3} defaultValue={a.currency} required/></label>
                <label>Frequency<select name="frequency" defaultValue={a.frequency}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>
                <label>Due day<input type="number" name="due_day" min="1" max="31" defaultValue={a.due_day} required/></label><label>Deposit<input type="number" name="deposit_amount" min="0" step="0.01" defaultValue={a.deposit_amount} required/></label>
                <label>Reference<input name="reference" defaultValue={a.reference??""}/></label><label>Notes<input name="notes" defaultValue={a.notes??""}/></label>
                <button type="submit" className="secondary">Update draft</button>
              </form>
              <form action={activateRentalAgreementAction} className="compact-form"><input type="hidden" name="rental_agreement_id" value={a.id}/><p className="muted">Activation generates the full rent schedule and locks its financial terms.</p><button type="submit">Activate + generate schedule</button></form>
            </div>:null}

            {a.status==="active"&&can("rentals.manage")?<form action={endRentalAgreementAction} className="inline-form"><input type="hidden" name="rental_agreement_id" value={a.id}/><button type="submit" className="secondary">End agreement</button></form>:null}

            {["active","ended"].includes(a.status)&&can("rentals.pay")?<div className="record-grid">
              <form action={createRentPaymentAction} className="compact-form">
                <input type="hidden" name="rental_agreement_id" value={a.id}/>
                <label>Payment type<select name="payment_type" defaultValue="rent"><option value="rent">Rent</option>{Number(a.deposit_outstanding)>0?<option value="deposit">Refundable deposit</option>:null}</select></label>
                <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.filter((x)=>x.currency===a.currency).map((x)=><option key={x.account_id} value={x.account_id}>{x.display_name} · {money(x.balance,x.currency)}</option>)}</select></label>
                <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><input type="hidden" name="currency" value={a.currency}/>
                <label>Paid on<input name="paid_on" type="date" defaultValue={today} required/></label><label>Method<select name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
                <label>Cheque no.<input name="cheque_number"/></label><label>Cheque due<input type="date" name="cheque_due_on"/></label><label>Reference<input name="reference"/></label><label>Notes<input name="notes"/></label>
                <button type="submit">Post payment</button>
              </form>
              {can("rentals.post")?<form action={recognizeRentThroughAction} className="compact-form">
                <input type="hidden" name="rental_agreement_id" value={a.id}/>
                <label>Recognize rent through<input name="through_date" type="date" defaultValue={today} required/></label>
                <p className="muted">Only periods that have ended by this date are recognized. Prepaid portions become expense; unpaid portions become rent payable.</p>
                <button type="submit">Recognize ended periods</button>
              </form>:null}
            </div>:null}

            {can("rental_documents.manage")?<form action="/api/rental-attachments" method="post" encType="multipart/form-data" className="inline-form">
              <input type="hidden" name="rental_agreement_id" value={a.id}/><label>Document type<input name="document_type" placeholder="Lease / receipt / notice" required/></label><label>Notes<input name="notes"/></label><label>File<input name="file" type="file" required/></label><button type="submit" className="secondary">Upload attachment</button>
            </form>:null}
            {can("rental_documents.view")&&agreementAttachments.length?<div className="inline-form">{agreementAttachments.map((x)=><a key={x.id} className="button-link secondary-link" href={"/api/rental-attachments/"+x.id}>{x.document_type} · {x.original_name}</a>)}</div>:null}

            {agreementSchedules.length?<><h3>Rent schedule</h3><div className="table-wrap"><table><thead><tr><th>Period</th><th>Due</th><th>Scheduled</th><th>Paid</th><th>Expense</th><th>Prepaid</th><th>Payable</th><th>Status / reversal</th></tr></thead><tbody>
              {agreementSchedules.map((s)=><tr key={s.id}><td>#{s.sequence} · {iso(s.period_start)} → {iso(s.period_end)}</td><td>{iso(s.due_on)}</td><td>{money(s.amount,s.currency)}</td><td>{money(s.paid_amount,s.currency)}</td><td>{money(s.recognized_amount,s.currency)}</td><td>{money(s.prepaid_rent_balance,s.currency)}</td><td>{money(s.rent_payable_balance,s.currency)}</td><td>
                {s.rent_recognition_id?<><span className="badge">Recognized {iso(s.recognition_date)}</span>{can("rentals.post")?<form action={reverseRentRecognitionAction} className="compact-form"><input type="hidden" name="rent_recognition_id" value={s.rent_recognition_id}/><input type="date" name="reversal_date" defaultValue={today} required/><input name="reason" placeholder="Reversal reason" required/><button type="submit" className="secondary">Reverse recognition</button></form>:null}</>:<span className="badge">{Number(s.paid_amount)>0?"Prepaid / paid":"Scheduled"}</span>}
              </td></tr>)}
            </tbody></table></div></>:a.status==="draft"?<p className="muted">Activate the agreement to generate its rent schedule.</p>:null}

            {agreementPayments.length?<><h3>Payments & deposits</h3><div className="table-wrap"><table><thead><tr><th>Date</th><th>Payment</th><th>Type</th><th>Account</th><th>Amount</th><th>Allocation</th><th>Status / reversal</th></tr></thead><tbody>
              {agreementPayments.map((p)=><tr key={p.id}><td>{iso(p.paid_on)}</td><td>{p.rent_payment_number}<div className="muted">{p.reference||title(p.method)}</div></td><td>{title(p.payment_type)}</td><td>{p.payment_account_name}</td><td>{money(p.amount,p.currency)}</td><td>{p.payment_type==="deposit"?"Refundable deposit":(p.allocations as any[]).map((x)=>"#"+x.sequence+" "+money(x.amount,p.currency)+" "+x.allocationType).join(" · ")}</td><td><span className="badge">{p.status}</span>{p.status==="posted"&&can("rentals.pay")?<form action={reverseRentPaymentAction} className="compact-form"><input type="hidden" name="rent_payment_id" value={p.id}/><input type="date" name="reversal_date" defaultValue={today} required/><input name="reason" placeholder="Reversal reason" required/><button type="submit" className="secondary">Reverse payment</button></form>:null}</td></tr>)}
            </tbody></table></div></>:null}

            {activeRecognitions.length?<p className="muted">{activeRecognitions.length} active rent recognition entr{activeRecognitions.length===1?"y":"ies"} for this agreement.</p>:null}

            {agreementHistory.length?<><h3>Rent history</h3><div className="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>Summary</th><th>Actor</th></tr></thead><tbody>
              {agreementHistory.map((h)=><tr key={h.id}><td>{iso(h.event_date)}</td><td>{title(h.event_type)}</td><td>{h.summary}</td><td>{h.actor_name||"System"}</td></tr>)}
            </tbody></table></div></>:null}
          </article>;
        })}
        {!agreements.length?<p className="muted">No rental agreements yet.</p>:null}
      </div>
    </section>:null}
  </main>;
}
