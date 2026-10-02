import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { createEnrollmentAction, withdrawEnrollmentAction } from "../../actions";
import { recordFamilyPaymentAction } from "@/app/billing/actions";
import { createFoodSelectionAction, closeFoodSelectionAction } from "@/app/food/actions";

type Row = Record<string, any>;
type MoneyValue = [string, number];

function money(value: unknown, currency = "USD") {
  const amount = Number(value ?? 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${currency} ${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
  }
}

function totals(rows: Row[], field: string): MoneyValue[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const currency = String(row.currency ?? "USD");
    map.set(currency, (map.get(currency) ?? 0) + Number(row[field] ?? 0));
  }
  return [...map.entries()].filter(([, amount]) => amount !== 0).sort(([a], [b]) => a.localeCompare(b));
}

function mergeTotals(...sets: MoneyValue[][]): MoneyValue[] {
  const map = new Map<string, number>();
  for (const set of sets) {
    for (const [currency, amount] of set) map.set(currency, (map.get(currency) ?? 0) + amount);
  }
  return [...map.entries()].filter(([, amount]) => amount !== 0).sort(([a], [b]) => a.localeCompare(b));
}

function MoneyStack({ values }: { values: MoneyValue[] }) {
  if (!values.length) return <span>—</span>;
  return <span className="money-stack">{values.map(([currency, amount]) => <span key={currency}>{money(amount, currency)}</span>)}</span>;
}

function iso(value: unknown) {
  return String(value ?? "").slice(0, 10);
}

export default async function FamilyHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const { id } = await params;
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  const allowed = [
    "families.view","families.manage","students.view","students.manage",
    "enrollments.view","enrollments.manage","student_documents.view","student_documents.manage",
    "student_history.view","billing.view","billing.manage","payments.view","payments.manage",
    "food.view","food.manage","food.billing","food.payments",
  ].some(can);
  if (!allowed) redirect("/forbidden");

  const familyResult = await query<Row>(
    "select id,family_number,display_name,home_phone,address,notes from family where id=$1",
    [id],
  );
  const family = familyResult.rows[0];
  if (!family) notFound();

  const canFinancial = ["billing.view","billing.manage","payments.view","payments.manage"].some(can);
  const canFood = ["food.view","food.manage","food.billing","food.payments"].some(can);
  const canEnrollment = can("enrollments.view") || can("enrollments.manage");
  const canDocs = can("student_documents.view") || can("student_documents.manage");
  const canHistory = can("student_history.view");
  const canContacts = can("families.view") || can("families.manage");

  const empty = () => Promise.resolve({ rows: [] as Row[] });
  const [
    clockResult,
    guardiansResult,
    emergencyResult,
    studentsResult,
    enrollmentsResult,
    yearsResult,
    classesResult,
    invoicesResult,
    paymentsResult,
    ledgerResult,
    foodSelectionsResult,
    foodBillsResult,
    foodPaymentsResult,
    documentsResult,
    historyResult,
    cashBankResult,
  ] = await Promise.all([
    query<Row>("select (now() at time zone 'Asia/Beirut')::date::text today"),
    canContacts ? query<Row>(
      `select g.id,g.first_name,g.last_name,g.phone,g.alternate_phone,g.email,g.occupation,
         fg.relationship,fg.is_primary,fg.has_legal_custody,fg.pickup_authorized
       from family_guardian fg join guardian g on g.id=fg.guardian_id
       where fg.family_id=$1 order by fg.is_primary desc,g.last_name,g.first_name`,
      [id],
    ) : empty(),
    canContacts ? query<Row>(
      `select ec.*,concat_ws(' ',s.first_name,s.last_name) student_name
       from emergency_contact ec left join student s on s.id=ec.student_id
       where ec.family_id=$1 order by ec.priority,ec.full_name`,
      [id],
    ) : empty(),
    query<Row>(
      `select id,student_number,first_name,last_name,preferred_name,date_of_birth::text,
         status,admission_date::text,exit_date::text
       from student where family_id=$1 order by last_name,first_name`,
      [id],
    ),
    canEnrollment ? query<Row>(
      `select e.id,e.student_id,e.status,e.enrolled_on::text,e.starts_on::text,
         e.withdrawal_on::text,e.withdrawal_reason,y.id school_year_id,y.name school_year_name,
         c.id class_id,c.name class_name,
         coalesce((
           select json_agg(json_build_object(
             'id',te.id,'term_id',t.id,'name',t.name,'sequence',t.sequence,
             'status',te.status,'starts_on',te.starts_on::text,'ends_on',te.ends_on::text
           ) order by t.sequence)
           from student_term_enrollment te join school_term t on t.id=te.term_id
           where te.enrollment_id=e.id
         ),'[]'::json) terms
       from student_enrollment e
       join school_year y on y.id=e.school_year_id
       join school_class c on c.id=e.class_id
       join student s on s.id=e.student_id
       where s.family_id=$1
       order by y.starts_on desc,e.created_at desc`,
      [id],
    ) : empty(),
    can("enrollments.manage") ? query<Row>(
      `select y.id,y.name,y.status,y.starts_on::text,y.ends_on::text,
         coalesce(json_agg(json_build_object(
           'id',t.id,'sequence',t.sequence,'name',t.name,'status',t.status,
           'starts_on',t.starts_on::text,'ends_on',t.ends_on::text
         ) order by t.sequence) filter (where t.id is not null),'[]'::json) terms
       from school_year y left join school_term t on t.school_year_id=y.id
       where y.status<>'closed'
       group by y.id order by y.starts_on desc`,
    ) : empty(),
    can("enrollments.manage") ? query<Row>(
      `select c.id,c.school_year_id,c.name,c.room,c.capacity,c.status,
         (select count(*)::int from student_enrollment e where e.class_id=c.id and e.status='enrolled') enrolled_count
       from school_class c join school_year y on y.id=c.school_year_id
       where c.status<>'archived' and y.status<>'closed'
       order by y.starts_on desc,c.name`,
    ) : empty(),
    canFinancial ? query<Row>(
      `select i.id,i.student_id,i.invoice_number,i.issued_on::text,i.due_on::text,i.currency,
         i.total_amount,i.status,b.paid_amount,b.credit_amount,b.balance_amount,
         concat_ws(' ',s.first_name,s.last_name) student_name,t.name term_name,y.name year_name
       from invoice i join invoice_balance b on b.id=i.id
       join student s on s.id=i.student_id
       join school_term t on t.id=i.term_id join school_year y on y.id=i.school_year_id
       where i.family_id=$1 order by i.created_at desc`,
      [id],
    ) : empty(),
    (can("payments.view") || can("payments.manage")) ? query<Row>(
      `select p.*,a.name payment_account_name
       from payment_balance p left join account a on a.id=p.payment_account_id
       where p.family_id=$1 order by p.created_at desc limit 100`,
      [id],
    ) : empty(),
    (can("billing.view") || can("payments.view")) ? query<Row>(
      `select l.*,concat_ws(' ',s.first_name,s.last_name) student_name,s.student_number
       from family_ledger l left join student s on s.id=l.student_id
       where l.family_id=$1 order by l.occurred_at desc limit 150`,
      [id],
    ) : empty(),
    canFood ? query<Row>(
      `select fs.*,s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,
         p.code package_code,p.name package_name,p.package_kind,t.name term_name,y.name year_name
       from student_food_selection fs join student s on s.id=fs.student_id
       join food_package p on p.id=fs.food_package_id join school_term t on t.id=fs.term_id
       join school_year y on y.id=fs.school_year_id
       where fs.family_id=$1 order by fs.created_at desc`,
      [id],
    ) : empty(),
    canFood ? query<Row>(
      `select b.*,s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,
         p.code package_code,p.name package_name,p.package_kind
       from food_bill_balance b join student s on s.id=b.student_id
       join food_package p on p.id=b.food_package_id
       where b.family_id=$1 order by b.created_at desc`,
      [id],
    ) : empty(),
    canFood ? query<Row>(
      `select a.id,a.amount,a.allocated_on,p.id payment_id,p.receipt_number,p.received_on,
         p.status payment_status,b.bill_number,b.currency,s.student_number,
         concat_ws(' ',s.first_name,s.last_name) student_name
       from food_payment_allocation a join payment p on p.id=a.payment_id
       join food_bill b on b.id=a.food_bill_id join student s on s.id=b.student_id
       where b.family_id=$1 order by a.created_at desc limit 100`,
      [id],
    ) : empty(),
    canDocs ? query<Row>(
      `select sd.id,sd.student_id,sd.document_type,sd.notes,sd.created_at,
         d.original_name,d.mime_type,d.size_bytes,s.student_number,
         concat_ws(' ',s.first_name,s.last_name) student_name
       from student_document sd join stored_document d on d.id=sd.document_id
       join student s on s.id=sd.student_id
       where s.family_id=$1 order by sd.created_at desc`,
      [id],
    ) : empty(),
    canHistory ? query<Row>(
      `select h.id,h.student_id,h.event_type,h.event_date::text,h.summary,h.occurred_at,
         u.full_name actor_name,s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name
       from student_history h join student s on s.id=h.student_id
       left join app_user u on u.id=h.actor_user_id
       where s.family_id=$1 order by h.occurred_at desc,h.id desc limit 200`,
      [id],
    ) : empty(),
    can("payments.manage") ? query<Row>(
      `select c.account_id,c.account_kind,c.display_name,a.code,a.currency,b.balance
       from cash_bank_account c join account a on a.id=c.account_id
       join cash_bank_balance b on b.account_id=c.account_id
       where c.is_active=true and a.status='active' and a.allow_posting=true
       order by c.account_kind,c.display_name`,
    ) : empty(),
  ]);

  const today = clockResult.rows[0]?.today ?? new Date().toISOString().slice(0, 10);
  const guardians = guardiansResult.rows;
  const emergencyContacts = emergencyResult.rows;
  const students = studentsResult.rows;
  const enrollments = enrollmentsResult.rows;
  const years = yearsResult.rows;
  const classes = classesResult.rows;
  const invoices = invoicesResult.rows;
  const payments = paymentsResult.rows;
  const familyLedger = ledgerResult.rows;
  const foodSelections = foodSelectionsResult.rows;
  const foodBills = foodBillsResult.rows;
  const foodPayments = foodPaymentsResult.rows;
  const documents = documentsResult.rows;
  const history = historyResult.rows;
  const cashBank = cashBankResult.rows;
  const foodPackages = can("food.manage") ? (await query<Row>(
    `select p.id,p.code,p.name,p.package_kind,p.package_price,p.currency,
       p.available_from::text,p.available_to::text,t.name term_name,y.name year_name
     from food_package p join school_term t on t.id=p.term_id join school_year y on y.id=p.school_year_id
     where p.status='active' and t.status<>'closed' and y.status<>'closed'
     order by y.starts_on desc,t.sequence,p.name`
  )).rows : [];

  const tuitionOpen = invoices.filter((row) => ["issued","partially_paid"].includes(row.status) && Number(row.balance_amount) > 0);
  const foodOpen = foodBills.filter((row) => ["issued","partially_paid"].includes(row.status) && Number(row.balance_amount) > 0);
  const tuitionDue = totals(tuitionOpen, "balance_amount");
  const foodDue = totals(foodOpen, "balance_amount");
  const totalDue = mergeTotals(tuitionDue, foodDue);
  const availableFunds = totals(payments.filter((row) => row.status === "posted"), "unallocated_amount");
  const returnTo = `/students/families/${id}`;

  return (
    <main className="app-shell family-hub-shell">
      <header className="family-hub-header">
        <div>
          <p className="eyebrow">Family hub</p>
          <h1>{family.display_name}</h1>
          <p className="muted">{family.family_number}{family.home_phone ? ` · ${family.home_phone}` : ""}</p>
        </div>
        <div className="top-actions">
          <Link className="button-link secondary-link" href="/students">All families</Link>
          {can("billing.manage") || can("payments.manage") ? <Link className="button-link secondary-link" href="/billing/admin">Billing setup</Link> : null}
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <nav className="family-hub-nav no-print" aria-label="Family record sections">
        <a href="#overview">Overview</a>
        {canEnrollment ? <a href="#enrollment">Enrollment</a> : null}
        {canFinancial ? <a href="#billing">Balance & payments</a> : null}
        {canFood ? <a href="#food">Food</a> : null}
        {canDocs ? <a href="#documents">Documents</a> : null}
        {canHistory ? <a href="#history">History</a> : null}
      </nav>

      <section className="family-summary-grid" id="overview">
        <article className="panel">
          <p className="eyebrow">Children</p>
          <h2>{students.length}</h2>
          <p className="muted">{students.filter((student) => student.status === "active").length} active.</p>
        </article>
        {canFinancial || canFood ? <article className="panel">
          <p className="eyebrow">Total due</p>
          <h2><MoneyStack values={totalDue}/></h2>
          <p className="muted">Tuition and food balances, kept separated by currency.</p>
        </article> : null}
        {canFinancial ? <article className="panel">
          <p className="eyebrow">Available family funds</p>
          <h2><MoneyStack values={availableFunds}/></h2>
          <p className="muted">Unallocated payment value available as family credit.</p>
        </article> : null}
        <article className="panel">
          <p className="eyebrow">Primary contact</p>
          <h2>{guardians.find((guardian) => guardian.is_primary)?.first_name ?? "—"} {guardians.find((guardian) => guardian.is_primary)?.last_name ?? ""}</h2>
          <p className="muted">{guardians.find((guardian) => guardian.is_primary)?.phone ?? "No primary guardian recorded."}</p>
        </article>
      </section>

      <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Family</p><h2>Contacts & children</h2></div></div>
        {family.address ? <p>{family.address}</p> : null}
        <div className="family-contact-grid">
          <div>
            <h3>Parents / guardians</h3>
            {guardians.length ? guardians.map((guardian) => (
              <div className="family-contact-item" key={guardian.id}>
                <strong>{guardian.first_name} {guardian.last_name}</strong>
                <span>{guardian.relationship}{guardian.is_primary ? " · Primary" : ""}</span>
                <small>{guardian.phone}{guardian.email ? ` · ${guardian.email}` : ""}</small>
              </div>
            )) : <p className="muted">No guardians recorded.</p>}
          </div>
          <div>
            <h3>Emergency contacts</h3>
            {emergencyContacts.length ? emergencyContacts.map((contact) => (
              <div className="family-contact-item" key={contact.id}>
                <strong>#{contact.priority} {contact.full_name}</strong>
                <span>{contact.relationship}{contact.student_name ? ` · ${contact.student_name}` : " · Whole family"}</span>
                <small>{contact.phone}</small>
              </div>
            )) : <p className="muted">No emergency contacts recorded.</p>}
          </div>
        </div>

        <div className="student-hub-grid">
          {students.map((student) => {
            const studentEnrollments = enrollments.filter((row) => row.student_id === student.id);
            const studentInvoices = invoices.filter((row) => row.student_id === student.id);
            const studentFoodBills = foodBills.filter((row) => row.student_id === student.id);
            const studentDocs = documents.filter((row) => row.student_id === student.id);
            const studentDue = mergeTotals(
              totals(studentInvoices.filter((row) => Number(row.balance_amount) > 0), "balance_amount"),
              totals(studentFoodBills.filter((row) => Number(row.balance_amount) > 0), "balance_amount"),
            );
            return (
              <article className="student-hub-card" id={`student-${student.id}`} key={student.id}>
                <div className="row-between">
                  <div><h3>{student.first_name} {student.last_name}</h3><p className="muted">{student.student_number} · born {student.date_of_birth}</p></div>
                  <span className="badge">{student.status}</span>
                </div>
                <div className="student-hub-stats">
                  <span><small>Balance</small><strong><MoneyStack values={studentDue}/></strong></span>
                  <span><small>Enrollments</small><strong>{studentEnrollments.length}</strong></span>
                  <span><small>Documents</small><strong>{studentDocs.length}</strong></span>
                </div>
                <div className="chips">
                  {studentEnrollments.filter((row) => row.status === "enrolled").map((row) => <span className="chip" key={row.id}>{row.school_year_name} · {row.class_name}</span>)}
                  {!studentEnrollments.some((row) => row.status === "enrolled") ? <span className="chip">No open enrollment</span> : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {canEnrollment ? <section className="panel section-block" id="enrollment">
        <div className="section-heading"><div><p className="eyebrow">Enrollment</p><h2>Enrollment from the family record</h2><p className="muted">Create or withdraw enrollment here; history stays attached to the child.</p></div></div>

        {can("enrollments.manage") ? <div className="card-list">
          {students.filter((student) => student.status !== "graduated").map((student) => (
            <details className="hub-details" key={student.id}>
              <summary>Enroll {student.first_name} {student.last_name}</summary>
              {years.map((year) => {
                const yearClasses = classes.filter((item) => item.school_year_id === year.id);
                const terms = (year.terms ?? []) as Row[];
                if (!yearClasses.length || !terms.some((term) => term.status !== "closed")) return null;
                const defaultStart = today >= year.starts_on && today <= year.ends_on ? today : year.starts_on;
                return (
                  <form action={createEnrollmentAction} className="form-grid hub-action-form" key={year.id}>
                    <input type="hidden" name="student_id" value={student.id}/>
                    <input type="hidden" name="school_year_id" value={year.id}/>
                    <input type="hidden" name="return_to" value={returnTo}/>
                    <div className="span-2"><strong>{year.name}</strong><p className="muted compact-text">{year.starts_on} → {year.ends_on}</p></div>
                    <label>Class<select name="class_id" defaultValue="" required><option value="" disabled>Select class</option>{yearClasses.map((item) => <option key={item.id} value={item.id}>{item.name}{item.room ? ` · ${item.room}` : ""} · {item.enrolled_count}{item.capacity ? `/${item.capacity}` : ""}</option>)}</select></label>
                    <label>Starts on<input type="date" name="starts_on" defaultValue={defaultStart} min={year.starts_on} max={year.ends_on} required/></label>
                    <fieldset className="span-2"><legend>Terms</legend><div className="check-grid">{terms.map((term) => <label className="check" key={term.id}><input type="checkbox" name="term_id" value={term.id} disabled={term.status === "closed"}/>{term.name} · {term.starts_on} → {term.ends_on}{term.status === "closed" ? " · closed" : ""}</label>)}</div></fieldset>
                    <label className="span-2">Notes<input name="notes"/></label>
                    <button type="submit">Enroll student</button>
                  </form>
                );
              })}
            </details>
          ))}
        </div> : null}

        <div className="card-list">
          {enrollments.map((enrollment) => (
            <article className="subcard" key={enrollment.id}>
              <div className="row-between"><div><strong>{students.find((student) => student.id === enrollment.student_id)?.first_name} {students.find((student) => student.id === enrollment.student_id)?.last_name}</strong><div className="muted">{enrollment.school_year_name} · {enrollment.class_name} · starts {enrollment.starts_on}</div></div><span className="badge">{enrollment.status}</span></div>
              <div className="chips">{(enrollment.terms as Row[]).map((term) => <span className="chip" key={term.id}>{term.name} · {term.status}</span>)}</div>
              {enrollment.withdrawal_reason ? <p className="muted">Withdrawal: {enrollment.withdrawal_on} · {enrollment.withdrawal_reason}</p> : null}
              {can("enrollments.manage") && enrollment.status === "enrolled" ? (
                <form action={withdrawEnrollmentAction} className="inline-form compact-form">
                  <input type="hidden" name="enrollment_id" value={enrollment.id}/>
                  <input type="hidden" name="return_to" value={returnTo}/>
                  <label>Withdrawal date<input type="date" name="withdrawal_on" min={enrollment.starts_on} required/></label>
                  <label>Reason<input name="withdrawal_reason" required/></label>
                  <button className="secondary" type="submit">Record withdrawal</button>
                </form>
              ) : null}
            </article>
          ))}
          {!enrollments.length ? <p className="muted">No enrollment history yet.</p> : null}
        </div>
      </section> : null}

      {canFinancial ? <section className="panel section-block" id="billing">
        <div className="section-heading">
          <div><p className="eyebrow">Balance & payments</p><h2>Family account</h2><p className="muted">Payments automatically clear the oldest open tuition invoices first, then food bills when you have food-payment permission. Any excess stays available as family credit.</p></div>
        </div>

        <div className="family-financial-summary">
          <div><small>Tuition due</small><strong><MoneyStack values={tuitionDue}/></strong></div>
          {canFood ? <div><small>Food due</small><strong><MoneyStack values={foodDue}/></strong></div> : null}
          <div><small>Available funds</small><strong><MoneyStack values={availableFunds}/></strong></div>
        </div>

        {can("payments.manage") ? <form action={recordFamilyPaymentAction} className="simple-payment-form">
          <input type="hidden" name="family_id" value={id}/>
          <div className="simple-payment-step"><span>1</span><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required autoFocus/></label></div>
          <div className="simple-payment-step"><span>2</span><label>Receive into<select name="payment_account_id" defaultValue="" required><option value="" disabled>Choose cash or bank</option>{cashBank.map((account) => <option key={account.account_id} value={account.account_id}>{account.display_name} · {account.account_kind} · {account.currency} · balance {money(account.balance, account.currency)}</option>)}</select></label></div>
          <div className="simple-payment-step"><span>3</span><label>Method<select name="method" defaultValue="cash"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label></div>
          <div className="simple-payment-step"><span>4</span><label>Date<input name="received_on" type="date" defaultValue={today} required/></label></div>
          <details className="span-2"><summary>Optional payment details</summary><div className="form-grid hub-action-form"><label>Reference<input name="reference"/></label><label>Notes<input name="notes"/></label><label>Cheque number<input name="cheque_number"/></label><label>Cheque due date<input type="date" name="cheque_due_on"/></label></div></details>
          <button type="submit">Save payment & open receipt</button>
        </form> : null}

        <h3>Invoices</h3>
        <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Student</th><th>Term</th><th>Due</th><th>Total</th><th>Paid / credit</th><th>Balance</th><th>Status</th></tr></thead><tbody>
          {invoices.map((invoice) => <tr key={invoice.id}><td>{invoice.invoice_number}<small>{invoice.issued_on ? `Issued ${invoice.issued_on}` : "Draft"}</small></td><td>{invoice.student_name}</td><td>{invoice.year_name} · {invoice.term_name}</td><td>{invoice.due_on ?? "—"}</td><td>{money(invoice.total_amount, invoice.currency)}</td><td>{money(invoice.paid_amount, invoice.currency)} / {money(invoice.credit_amount, invoice.currency)}</td><td><strong>{money(invoice.balance_amount, invoice.currency)}</strong></td><td><span className="badge">{invoice.status}</span></td></tr>)}
          {!invoices.length ? <tr><td colSpan={8}>No invoices yet.</td></tr> : null}
        </tbody></table></div>

        <h3>Payments & receipts</h3>
        <div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Date</th><th>Account</th><th>Amount</th><th>Allocated</th><th>Available</th><th>Status</th></tr></thead><tbody>
          {payments.map((payment) => <tr key={payment.id}><td><Link href={`/receipts/${payment.id}`}>{payment.receipt_number}</Link></td><td>{iso(payment.received_on)}</td><td>{payment.payment_account_name ?? "Mapped payment asset"}</td><td>{money(payment.amount,payment.currency)}</td><td>{money(payment.allocated_amount,payment.currency)}</td><td>{money(payment.unallocated_amount,payment.currency)}</td><td><span className="badge">{payment.status}</span></td></tr>)}
          {!payments.length ? <tr><td colSpan={7}>No payments yet.</td></tr> : null}
        </tbody></table></div>

        {(can("billing.view") || can("payments.view")) ? <details className="hub-details"><summary>Account ledger</summary><div className="table-wrap"><table><thead><tr><th>Date</th><th>Student</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{familyLedger.map((entry,index) => <tr key={`${entry.entry_type}-${entry.source_id}-${index}`}><td>{entry.entry_date}</td><td>{entry.student_number ? `${entry.student_number} · ${entry.student_name}` : "Family-level"}</td><td>{String(entry.entry_type).replaceAll("_"," ")}</td><td>{entry.reference}</td><td>{entry.description}</td><td>{Number(entry.debit_amount) ? money(entry.debit_amount,entry.currency ?? "USD") : "—"}</td><td>{Number(entry.credit_amount) ? money(entry.credit_amount,entry.currency ?? "USD") : "—"}</td></tr>)}</tbody></table></div></details> : null}
      </section> : null}

      {canFood ? <section className="panel section-block" id="food">
        <div className="section-heading"><div><p className="eyebrow">Food</p><h2>Food packages & billing</h2><p className="muted">Food activity is visible beside the student account, not hidden in a separate workflow.</p></div>{can("food.manage") ? <Link className="button-link secondary-link" href="/food">Manage food packages</Link> : null}</div>
        {can("food.manage") && foodPackages.length ? <div className="student-document-forms">
          {students.filter((student) => student.status !== "graduated").map((student) => (
            <form action={createFoodSelectionAction} className="form-grid create-box" key={student.id}>
              <input type="hidden" name="student_id" value={student.id}/>
              <input type="hidden" name="return_to" value={returnTo}/>
              <div className="span-2"><strong>Add food package for {student.first_name} {student.last_name}</strong></div>
              <label className="span-2">Package<select name="food_package_id" defaultValue="" required><option value="" disabled>Select active package</option>{foodPackages.map((pack) => <option key={pack.id} value={pack.id}>{pack.year_name} · {pack.term_name} · {pack.code} · {pack.name} · {money(pack.package_price,pack.currency)}</option>)}</select></label>
              <label>Quantity<input name="quantity" defaultValue="1" inputMode="decimal" required/></label>
              <label>Starts on<input name="starts_on" type="date" defaultValue={today} required/></label>
              <label>Ends on<input name="ends_on" type="date" required/></label>
              <label>Notes<input name="notes"/></label>
              <button type="submit">Add food selection</button>
            </form>
          ))}
        </div> : null}
        <div className="card-list">
          {foodSelections.map((selection) => <article className="subcard" key={selection.id}><div className="row-between"><div><strong>{selection.student_number} · {selection.student_name}</strong><div className="muted">{selection.package_code} · {selection.package_name} · {selection.package_kind}</div></div><span className="badge">{selection.status}</span></div><p className="muted">{iso(selection.starts_on)} → {iso(selection.ends_on)} · {money(selection.unit_price,selection.currency)} × {selection.quantity}</p>{can("food.manage") && selection.status==="active" ? <form action={closeFoodSelectionAction} className="inline-form compact-form"><input type="hidden" name="student_food_selection_id" value={selection.id}/><input type="hidden" name="return_to" value={returnTo}/><button className="secondary" name="status" value="ended">End selection</button><button className="secondary" name="status" value="cancelled">Cancel selection</button></form> : null}</article>)}
          {!foodSelections.length ? <p className="muted">No food selections for this family.</p> : null}
        </div>
        <div className="table-wrap"><table><thead><tr><th>Bill</th><th>Student</th><th>Package</th><th>Period</th><th>Total</th><th>Paid / credit</th><th>Balance</th><th>Status</th></tr></thead><tbody>{foodBills.map((bill) => <tr key={bill.id}><td>{bill.bill_number}</td><td>{bill.student_number} · {bill.student_name}</td><td>{bill.package_code} · {bill.package_name}</td><td>{iso(bill.period_start)} → {iso(bill.period_end)}</td><td>{money(bill.total_amount,bill.currency)}</td><td>{money(bill.paid_amount,bill.currency)} / {money(bill.credit_amount,bill.currency)}</td><td><strong>{money(bill.balance_amount,bill.currency)}</strong></td><td><span className="badge">{bill.status}</span></td></tr>)}{!foodBills.length ? <tr><td colSpan={8}>No food bills.</td></tr> : null}</tbody></table></div>
        {foodPayments.length ? <details className="hub-details"><summary>Food payment allocations ({foodPayments.length})</summary><div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Student</th><th>Bill</th><th>Date</th><th>Applied</th></tr></thead><tbody>{foodPayments.map((payment) => <tr key={payment.id}><td><Link href={`/receipts/${payment.payment_id}`}>{payment.receipt_number}</Link></td><td>{payment.student_number} · {payment.student_name}</td><td>{payment.bill_number}</td><td>{iso(payment.allocated_on)}</td><td>{money(payment.amount,payment.currency)}</td></tr>)}</tbody></table></div></details> : null}
      </section> : null}

      {canDocs ? <section className="panel section-block" id="documents">
        <div className="section-heading"><div><p className="eyebrow">Documents</p><h2>Student documents</h2></div></div>
        {can("student_documents.manage") ? <div className="student-document-forms">{students.map((student) => <form action="/api/student-documents" method="post" encType="multipart/form-data" className="form-grid create-box" key={student.id}><input type="hidden" name="student_id" value={student.id}/><input type="hidden" name="return_to" value={returnTo}/><div className="span-2"><strong>{student.first_name} {student.last_name}</strong><p className="muted compact-text">{student.student_number}</p></div><label>Document type<input name="document_type" placeholder="Birth certificate, ID, consent…" required/></label><label>File<input type="file" name="file" required/></label><label className="span-2">Notes<input name="notes"/></label><button type="submit">Upload document</button></form>)}</div> : null}
        {can("student_documents.view") ? <div className="table-wrap"><table><thead><tr><th>Student</th><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th/></tr></thead><tbody>{documents.map((document) => <tr key={document.id}><td>{document.student_number} · {document.student_name}</td><td>{document.document_type}</td><td>{document.original_name}</td><td>{Math.ceil(Number(document.size_bytes)/1024)} KB</td><td>{new Date(document.created_at).toLocaleString("en-GB")}</td><td><a href={`/api/student-documents/${document.id}`}>Open</a></td></tr>)}{!documents.length ? <tr><td colSpan={6}>No documents yet.</td></tr> : null}</tbody></table></div> : null}
      </section> : null}

      {canHistory ? <section className="panel section-block" id="history">
        <div className="section-heading"><div><p className="eyebrow">Permanent history</p><h2>Student history</h2><p className="muted">Enrollment, withdrawal, status and document events remain attached to each child.</p></div></div>
        <div className="history-timeline">{history.map((item) => <article className="history-event" key={item.id}><div><strong>{item.event_date} · {item.student_number} · {item.student_name}</strong><span className="badge">{String(item.event_type).replaceAll("_"," ")}</span></div><p>{item.summary}</p><small>{item.actor_name ?? "System / unknown"}</small></article>)}{!history.length ? <p className="muted">No history events yet.</p> : null}</div>
      </section> : null}
    </main>
  );
}
