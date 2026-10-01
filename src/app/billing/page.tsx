import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import {
  activateFeeScheduleAction,
  addInvoiceChargeAction,
  allocateCreditNoteAction,
  allocatePaymentAction,
  createCreditNoteAction,
  createFeeScheduleAction,
  generateTermInvoiceAction,
  issueInvoiceAction,
  recordPaymentAction,
  requestDiscountAction,
  reviewDiscountAction,
  reverseCreditNoteAction,
  reversePaymentAction,
  revokeDiscountAction,
  updateDiscountConfigurationAction,
  voidDraftInvoiceAction,
} from "./actions";

type BasicRow = Record<string, any>;

function moneyLabel(amount: unknown, currency = "USD") {
  const numeric = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(numeric) ? numeric : 0);
  } catch {
    return `${currency} ${(Number.isFinite(numeric) ? numeric : 0).toFixed(2)}`;
  }
}

function modeExplanation(mode: string) {
  if (mode === "additive") {
    return "Each percentage is calculated from the original nursery fee, then reductions are added. 50% + 10% = 60%.";
  }
  if (mode === "sequential") {
    return "Discounts apply by priority to the remaining balance. 50% followed by 10% gives an effective 55% reduction.";
  }
  return "Only the single largest monetary discount applies. A 50% teacher-child discount beats a 10% sibling discount.";
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  const allowed = [
    "billing.view",
    "billing.manage",
    "discounts.view",
    "discounts.manage",
    "discounts.approve",
    "payments.view",
    "payments.manage",
  ].some(can);
  if (!allowed) redirect("/forbidden");

  const today =
    (
      await query<{ today: string }>(
        "select (now() at time zone 'Asia/Beirut')::date::text as today",
      )
    ).rows[0]?.today ?? "";

  const currencySetting =
    (
      await query<{ currency: string | null }>(
        "select value #>> '{}' as currency from app_setting where key='currency'",
      )
    ).rows[0]?.currency ?? "USD";

  const configuration =
    can("discounts.view") || can("discounts.manage") || can("discounts.approve")
      ? (
          await query<{
            discount_combination_mode: string;
            max_discount_percent: string;
          }>(
            "select discount_combination_mode,max_discount_percent::text from billing_configuration where id=1",
          )
        ).rows[0]
      : null;

  const terms = (
    await query<{
      id: string;
      school_year_id: string;
      year_name: string;
      sequence: number;
      name: string;
      starts_on: string;
      ends_on: string;
    }>(
      `select t.id,t.school_year_id,y.name as year_name,t.sequence,t.name,
         t.starts_on::text,t.ends_on::text
       from school_term t
       join school_year y on y.id=t.school_year_id
       order by y.starts_on desc,t.sequence`,
    )
  ).rows;

  const students = (
    await query<{
      id: string;
      family_id: string;
      student_number: string;
      student_name: string;
      family_number: string;
      family_name: string;
    }>(
      `select s.id,s.family_id,s.student_number,
         concat_ws(' ',s.first_name,s.last_name) as student_name,
         f.family_number,f.display_name as family_name
       from student s
       join family f on f.id=s.family_id
       where s.status<>'graduated'
       order by f.display_name,s.first_name,s.last_name`,
    )
  ).rows;

  const families = (
    await query<{
      id: string;
      family_number: string;
      display_name: string;
    }>("select id,family_number,display_name from family order by display_name")
  ).rows;

  const feeSchedules =
    can("billing.view") || can("billing.manage")
      ? (
          await query<BasicRow>(
            `select fs.*,t.name as term_name,t.sequence,y.name as year_name
             from fee_schedule fs
             join school_term t on t.id=fs.term_id
             join school_year y on y.id=fs.school_year_id
             order by y.starts_on desc,t.sequence,fs.created_at desc`,
          )
        ).rows
      : [];

  const discountDefinitions =
    can("discounts.view") || can("discounts.manage") || can("discounts.approve")
      ? (
          await query<BasicRow>(
            `select id,code,name,system_key,discount_kind,default_value::text,
               default_priority,requires_approval,is_active
             from discount_definition
             where is_active=true
             order by default_priority,code`,
          )
        ).rows
      : [];

  const discounts =
    can("discounts.view") || can("discounts.manage") || can("discounts.approve")
      ? (
          await query<BasicRow>(
            `select e.*,s.student_number,
               concat_ws(' ',s.first_name,s.last_name) as student_name,
               t.name as term_name,t.sequence,y.name as year_name,
               requester.full_name as requested_by_name,
               reviewer.full_name as reviewed_by_name
             from student_discount_effective e
             join student s on s.id=e.student_id
             join school_term t on t.id=e.term_id
             join school_year y on y.id=e.school_year_id
             left join app_user requester on requester.id=e.requested_by
             left join app_user reviewer on reviewer.id=e.reviewed_by
             order by e.requested_at desc
             limit 200`,
          )
        ).rows
      : [];

  const discountHistory =
    can("discounts.view") || can("discounts.approve")
      ? (
          await query<BasicRow>(
            `select h.id,h.event_type,h.note,h.occurred_at,
               e.discount_name,s.student_number,
               concat_ws(' ',s.first_name,s.last_name) as student_name,
               u.full_name as actor_name
             from discount_history h
             join student_discount_effective e on e.id=h.student_discount_id
             join student s on s.id=e.student_id
             left join app_user u on u.id=h.actor_user_id
             order by h.occurred_at desc,h.id desc
             limit 100`,
          )
        ).rows
      : [];

  const invoices =
    can("billing.view") || can("billing.manage") || can("payments.view") || can("payments.manage")
      ? (
          await query<BasicRow>(
            `select i.*,b.paid_amount,b.credit_amount,b.balance_amount,
               s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
               f.family_number,f.display_name as family_name,
               t.name as term_name,t.sequence,y.name as year_name
             from invoice i
             join invoice_balance b on b.id=i.id
             join student s on s.id=i.student_id
             join family f on f.id=i.family_id
             join school_term t on t.id=i.term_id
             join school_year y on y.id=i.school_year_id
             order by i.created_at desc
             limit 200`,
          )
        ).rows
      : [];

  const invoiceLines =
    invoices.length
      ? (
          await query<BasicRow>(
            `select l.*
             from invoice_line l
             where l.invoice_id=any($1::uuid[])
             order by l.created_at,l.id`,
            [invoices.map((item) => item.id)],
          )
        ).rows
      : [];

  const lineDiscounts =
    invoiceLines.length
      ? (
          await query<BasicRow>(
            `select d.*
             from invoice_line_discount d
             where d.invoice_line_id=any($1::uuid[])
             order by d.application_order,d.id`,
            [invoiceLines.map((item) => item.id)],
          )
        ).rows
      : [];

  const payments =
    can("payments.view") || can("payments.manage")
      ? (
          await query<BasicRow>(
            `select p.*,f.family_number,f.display_name as family_name,
               s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name
             from payment_balance p
             join family f on f.id=p.family_id
             left join student s on s.id=p.student_id
             order by p.created_at desc
             limit 200`,
          )
        ).rows
      : [];

  const credits =
    can("billing.view") || can("billing.manage")
      ? (
          await query<BasicRow>(
            `select c.*,f.family_number,f.display_name as family_name,
               s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
               i.invoice_number
             from credit_note_balance c
             join family f on f.id=c.family_id
             left join student s on s.id=c.student_id
             left join invoice i on i.id=c.original_invoice_id
             order by c.created_at desc
             limit 200`,
          )
        ).rows
      : [];

  const familyLedger =
    can("billing.view") || can("payments.view")
      ? (
          await query<BasicRow>(
            `select l.*,f.family_number,f.display_name as family_name,
               s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name
             from family_ledger l
             join family f on f.id=l.family_id
             left join student s on s.id=l.student_id
             order by l.occurred_at desc
             limit 200`,
          )
        ).rows
      : [];

  const studentLedger =
    can("billing.view") || can("payments.view")
      ? (
          await query<BasicRow>(
            `select l.*,s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
               f.family_number
             from student_ledger l
             join student s on s.id=l.student_id
             join family f on f.id=l.family_id
             order by l.occurred_at desc
             limit 200`,
          )
        ).rows
      : [];

  const linesByInvoice = new Map<string, BasicRow[]>();
  for (const line of invoiceLines) {
    const list = linesByInvoice.get(line.invoice_id) ?? [];
    list.push(line);
    linesByInvoice.set(line.invoice_id, list);
  }
  const discountsByLine = new Map<string, BasicRow[]>();
  for (const item of lineDiscounts) {
    const list = discountsByLine.get(item.invoice_line_id) ?? [];
    list.push(item);
    discountsByLine.set(item.invoice_line_id, list);
  }

  const openInvoices = invoices.filter((item) =>
    ["issued", "partially_paid"].includes(item.status) && Number(item.balance_amount) > 0,
  );
  const outstanding = openInvoices.reduce((sum, item) => sum + Number(item.balance_amount), 0);
  const unappliedFunds = payments
    .filter((item) => item.status === "posted")
    .reduce((sum, item) => sum + Number(item.unallocated_amount), 0);
  const unappliedCredits = credits
    .filter((item) => item.status === "issued")
    .reduce((sum, item) => sum + Number(item.unallocated_amount), 0);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
          <h1>Fees, Discounts & Billing</h1>
          <p className="muted">
            Term fees, approved discounts, invoices, credits and payments use auditable snapshots.
          </p>
        </div>
        <div className="top-actions">
          <Link className="button-link secondary-link" href="/students">Families & students</Link>
          <Link className="button-link secondary-link" href="/dashboard">Foundation dashboard</Link>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <section className="status-grid">
        <article className="panel">
          <p className="eyebrow">Open receivables</p>
          <h2>{moneyLabel(outstanding, currencySetting)}</h2>
          <p className="muted">{openInvoices.length} issued invoice{openInvoices.length === 1 ? "" : "s"} with balance.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Family funds</p>
          <h2>{moneyLabel(unappliedFunds, currencySetting)}</h2>
          <p className="muted">Unapplied payments, including prepayments and overpayments.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Unused credits</p>
          <h2>{moneyLabel(unappliedCredits, currencySetting)}</h2>
          <p className="muted">Issued credit-note value still available to allocate.</p>
        </article>
      </section>

      {configuration && (can("discounts.view") || can("discounts.approve")) ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Explicit discount policy</p>
              <h2>How combined discounts behave</h2>
              <p className="muted">{modeExplanation(configuration.discount_combination_mode)}</p>
            </div>
            <span className="badge">{configuration.discount_combination_mode.replaceAll("_", " ")}</span>
          </div>
          <div className="notice">
            Teacher child + sibling on a 100.00 fee: best single = 50.00 discount, additive = 60.00,
            sequential = 55.00. Additional charges are never discounted automatically.
          </div>
          {can("discounts.approve") ? (
            <form action={updateDiscountConfigurationAction} className="form-grid create-box">
              <label>
                Combination rule
                <select name="discount_combination_mode" defaultValue={configuration.discount_combination_mode}>
                  <option value="best_single">Best single discount</option>
                  <option value="additive">Additive on original fee</option>
                  <option value="sequential">Sequential by priority</option>
                </select>
              </label>
              <label>
                Maximum total discount %
                <input
                  name="max_discount_percent"
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  defaultValue={configuration.max_discount_percent}
                  required
                />
              </label>
              <button type="submit">Save discount rule</button>
            </form>
          ) : null}
        </section>
      ) : null}

      {can("billing.view") || can("billing.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Standard nursery fee</p>
              <h2>Fee schedules by term</h2>
              <p className="muted">Only one schedule can be active for a term. Old schedules are retained for history.</p>
            </div>
          </div>
          {can("billing.manage") ? (
            <form action={createFeeScheduleAction} className="form-grid create-box">
              <label>
                Term
                <select name="term_id" defaultValue="" required>
                  <option value="" disabled>Select term</option>
                  {terms.map((term) => (
                    <option key={term.id} value={term.id}>
                      {term.year_name} · Term {term.sequence} · {term.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>Schedule name<input name="name" placeholder="2026–2027 Term 1 standard" required /></label>
              <label>Standard nursery fee<input name="standard_fee" type="number" min="0.01" step="0.01" required /></label>
              <label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required /></label>
              <button type="submit">Create draft schedule</button>
            </form>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Year / term</th><th>Schedule</th><th>Fee</th><th>Status</th><th /></tr></thead>
              <tbody>
                {feeSchedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.year_name} · T{schedule.sequence} · {schedule.term_name}</td>
                    <td>{schedule.name}</td>
                    <td>{moneyLabel(schedule.standard_fee, schedule.currency)}</td>
                    <td><span className="badge">{schedule.status}</span></td>
                    <td>
                      {can("billing.manage") && schedule.status === "draft" ? (
                        <form action={activateFeeScheduleAction}>
                          <input type="hidden" name="fee_schedule_id" value={schedule.id} />
                          <button type="submit" className="secondary">Activate</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {can("discounts.view") || can("discounts.manage") || can("discounts.approve") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Discount approvals</p>
              <h2>Student discounts</h2>
              <p className="muted">Sibling and teacher-child values are fixed system rules. Custom discounts may be percentage or fixed amount.</p>
            </div>
          </div>
          {can("discounts.manage") ? (
            <form action={requestDiscountAction} className="form-grid create-box">
              <label>
                Student
                <select name="student_id" defaultValue="" required>
                  <option value="" disabled>Select student</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.student_number} · {student.student_name} · {student.family_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Term
                <select name="term_id" defaultValue="" required>
                  <option value="" disabled>Select enrolled term</option>
                  {terms.map((term) => (
                    <option key={term.id} value={term.id}>{term.year_name} · T{term.sequence} · {term.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Discount
                <select name="discount_code" defaultValue="" required>
                  <option value="" disabled>Select discount</option>
                  {discountDefinitions.map((definition) => (
                    <option key={definition.id} value={definition.code}>
                      {definition.name}
                      {definition.system_key !== "custom"
                        ? ` · ${definition.discount_kind === "percentage" ? definition.default_value + "%" : moneyLabel(definition.default_value, currencySetting)}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>Eligibility / approval note<input name="eligibility_note" placeholder="Teacher name, sibling context, reason…" /></label>
              <label>Custom name<input name="custom_name" placeholder="Only for Custom" /></label>
              <label>
                Custom type
                <select name="custom_kind" defaultValue="percentage">
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </label>
              <label>Custom value<input name="custom_value" type="number" min="0.01" step="0.01" /></label>
              <label>Priority override<input name="priority" type="number" min="1" max="1000" placeholder="Optional" /></label>
              <button type="submit">Request discount</button>
            </form>
          ) : null}

          <div className="card-list">
            {discounts.map((discount) => (
              <article className="subcard" key={discount.id}>
                <div className="row-between">
                  <div>
                    <strong>{discount.student_number} · {discount.student_name}</strong>
                    <div className="muted">{discount.year_name} · {discount.term_name} · {discount.discount_name}</div>
                  </div>
                  <span className="badge">{discount.status}</span>
                </div>
                <p className="muted">
                  {discount.discount_kind === "percentage"
                    ? `${discount.discount_value}%`
                    : moneyLabel(discount.discount_value, currencySetting)}
                  {" · "}priority {discount.priority}
                  {discount.eligibility_note ? ` · ${discount.eligibility_note}` : ""}
                </p>
                {discount.status === "pending" && can("discounts.approve") ? (
                  <div className="record-grid">
                    <form action={reviewDiscountAction} className="inline-form compact-form">
                      <input type="hidden" name="discount_id" value={discount.id} />
                      <input type="hidden" name="decision" value="approved" />
                      <label>Review note<input name="review_note" /></label>
                      <button type="submit">Approve</button>
                    </form>
                    <form action={reviewDiscountAction} className="inline-form compact-form">
                      <input type="hidden" name="discount_id" value={discount.id} />
                      <input type="hidden" name="decision" value="rejected" />
                      <label>Reason<input name="review_note" required /></label>
                      <button type="submit" className="secondary">Reject</button>
                    </form>
                  </div>
                ) : null}
                {discount.status === "approved" && can("discounts.manage") ? (
                  <form action={revokeDiscountAction} className="inline-form compact-form">
                    <input type="hidden" name="discount_id" value={discount.id} />
                    <label>Revocation note<input name="note" required /></label>
                    <button type="submit" className="secondary">Revoke for future invoices</button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>

          {can("discounts.view") || can("discounts.approve") ? (
            <>
              <h3>Discount history</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Time</th><th>Student</th><th>Discount</th><th>Event</th><th>By</th><th>Note</th></tr></thead>
                  <tbody>
                    {discountHistory.map((item) => (
                      <tr key={item.id}>
                        <td>{new Date(item.occurred_at).toLocaleString("en-GB")}</td>
                        <td>{item.student_number} · {item.student_name}</td>
                        <td>{item.discount_name}</td>
                        <td><code>{item.event_type}</code></td>
                        <td>{item.actor_name ?? "System / unknown"}</td>
                        <td>{item.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {can("billing.view") || can("billing.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Term invoicing</p>
              <h2>Invoices & additional charges</h2>
              <p className="muted">Generate a draft from the active fee schedule. Approved discounts snapshot onto the nursery-fee line. Add charges before issuing.</p>
            </div>
          </div>
          {can("billing.manage") ? (
            <form action={generateTermInvoiceAction} className="form-grid create-box">
              <label>
                Student
                <select name="student_id" defaultValue="" required>
                  <option value="" disabled>Select student</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.student_number} · {student.student_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Term
                <select name="term_id" defaultValue="" required>
                  <option value="" disabled>Select term</option>
                  {terms.map((term) => (
                    <option key={term.id} value={term.id}>{term.year_name} · T{term.sequence} · {term.name}</option>
                  ))}
                </select>
              </label>
              <label className="span-2">Invoice note<textarea name="notes" /></label>
              <button type="submit">Generate draft invoice</button>
            </form>
          ) : null}

          <div className="card-list">
            {invoices.map((invoice) => {
              const lines = linesByInvoice.get(invoice.id) ?? [];
              return (
                <article className="subcard" key={invoice.id}>
                  <div className="row-between">
                    <div>
                      <strong>{invoice.invoice_number} · {invoice.student_name}</strong>
                      <div className="muted">
                        {invoice.family_number} · {invoice.year_name} · T{invoice.sequence} · {invoice.term_name}
                      </div>
                    </div>
                    <span className="badge">{invoice.status}</span>
                  </div>
                  <div className="record-grid">
                    <div><strong>Subtotal</strong><p>{moneyLabel(invoice.subtotal_amount, invoice.currency)}</p></div>
                    <div><strong>Discounts</strong><p>{moneyLabel(invoice.discount_amount, invoice.currency)}</p></div>
                    <div><strong>Total</strong><p>{moneyLabel(invoice.total_amount, invoice.currency)}</p></div>
                    <div><strong>Paid</strong><p>{moneyLabel(invoice.paid_amount, invoice.currency)}</p></div>
                    <div><strong>Credits</strong><p>{moneyLabel(invoice.credit_amount, invoice.currency)}</p></div>
                    <div><strong>Balance</strong><p>{moneyLabel(invoice.balance_amount, invoice.currency)}</p></div>
                  </div>
                  <p className="muted">Due {invoice.due_on}{invoice.issued_on ? ` · Issued ${invoice.issued_on}` : " · Draft not yet issued"}</p>

                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Line</th><th>Gross</th><th>Discount</th><th>Net</th><th>Applied rules</th></tr></thead>
                      <tbody>
                        {lines.map((line) => {
                          const snapshots = discountsByLine.get(line.id) ?? [];
                          return (
                            <tr key={line.id}>
                              <td>{line.description}</td>
                              <td>{moneyLabel(line.gross_amount, invoice.currency)}</td>
                              <td>{moneyLabel(line.discount_amount, invoice.currency)}</td>
                              <td>{moneyLabel(line.net_amount, invoice.currency)}</td>
                              <td>
                                {snapshots.length
                                  ? snapshots.map((snapshot) => (
                                      <div className="muted compact-text" key={snapshot.id}>
                                        {snapshot.discount_label}: {moneyLabel(snapshot.applied_amount, invoice.currency)}
                                        {" · "}{snapshot.combination_mode}
                                      </div>
                                    ))
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {can("billing.manage") && invoice.status === "draft" ? (
                    <div className="record-grid">
                      <form action={addInvoiceChargeAction} className="inline-form compact-form">
                        <input type="hidden" name="invoice_id" value={invoice.id} />
                        <label>Description<input name="description" placeholder="Materials, trip, late charge…" required /></label>
                        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
                        <button type="submit">Add charge</button>
                      </form>
                      <form action={issueInvoiceAction} className="compact-form">
                        <input type="hidden" name="invoice_id" value={invoice.id} />
                        <button type="submit">Issue invoice</button>
                      </form>
                      <form action={voidDraftInvoiceAction} className="inline-form compact-form">
                        <input type="hidden" name="invoice_id" value={invoice.id} />
                        <label>Void reason<input name="reason" required /></label>
                        <button type="submit" className="secondary">Void draft</button>
                      </form>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {can("payments.view") || can("payments.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Cash collection</p>
              <h2>Payments, prepayments & overpayments</h2>
              <p className="muted">A payment may be recorded without an invoice. Any unallocated amount stays available to the family instead of being lost.</p>
            </div>
          </div>
          {can("payments.manage") ? (
            <form action={recordPaymentAction} className="form-grid create-box">
              <label>
                Family
                <select name="family_id" defaultValue="" required>
                  <option value="" disabled>Select family</option>
                  {families.map((family) => (
                    <option key={family.id} value={family.id}>{family.family_number} · {family.display_name}</option>
                  ))}
                </select>
              </label>
              <label>
                Student (optional)
                <select name="student_id" defaultValue="">
                  <option value="">Family-level funds</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>{student.student_number} · {student.student_name}</option>
                  ))}
                </select>
              </label>
              <label>
                Apply to invoice (optional)
                <select name="invoice_id" defaultValue="">
                  <option value="">Leave unallocated</option>
                  {openInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number} · {invoice.student_name} · balance {moneyLabel(invoice.balance_amount, invoice.currency)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Payment type
                <select name="payment_kind" defaultValue="payment">
                  <option value="payment">Payment</option>
                  <option value="prepayment">Prepayment</option>
                </select>
              </label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Currency<input name="currency" maxLength={3} defaultValue={currencySetting} required /></label>
              <label>Date<input name="received_on" type="date" defaultValue={today} required /></label>
              <label>
                Method
                <select name="method" defaultValue="cash">
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="check">Check</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>Reference<input name="reference" /></label>
              <label>Notes<input name="notes" /></label>
              <button type="submit">Record payment</button>
            </form>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead><tr><th>Receipt</th><th>Family / student</th><th>Amount</th><th>Allocated</th><th>Available</th><th>Type</th><th>Status</th><th /></tr></thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.receipt_number}</td>
                    <td>{payment.family_number} · {payment.family_name}{payment.student_name ? ` · ${payment.student_name}` : ""}</td>
                    <td>{moneyLabel(payment.amount, payment.currency)}</td>
                    <td>{moneyLabel(payment.allocated_amount, payment.currency)}</td>
                    <td>{moneyLabel(payment.unallocated_amount, payment.currency)}</td>
                    <td>{payment.balance_type.replaceAll("_", " ")}</td>
                    <td><span className="badge">{payment.status}</span></td>
                    <td>
                      {can("payments.manage") && payment.status === "posted" ? (
                        <div className="compact-form">
                          {Number(payment.unallocated_amount) > 0 ? (
                            <form action={allocatePaymentAction} className="inline-form compact-form">
                              <input type="hidden" name="payment_id" value={payment.id} />
                              <label>
                                Invoice
                                <select name="invoice_id" defaultValue="" required>
                                  <option value="" disabled>Select open invoice</option>
                                  {openInvoices
                                    .filter((invoice) => invoice.family_id === payment.family_id)
                                    .filter((invoice) => !payment.student_id || invoice.student_id === payment.student_id)
                                    .map((invoice) => (
                                      <option key={invoice.id} value={invoice.id}>
                                        {invoice.invoice_number} · {invoice.student_name} · {moneyLabel(invoice.balance_amount, invoice.currency)}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max={payment.unallocated_amount} required /></label>
                              <button type="submit">Allocate</button>
                            </form>
                          ) : null}
                          <form action={reversePaymentAction} className="inline-form compact-form">
                            <input type="hidden" name="payment_id" value={payment.id} />
                            <label>Reversal reason<input name="reason" required /></label>
                            <button type="submit" className="secondary">Reverse</button>
                          </form>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {can("billing.view") || can("billing.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Credits & corrections</p>
              <h2>Credit notes and reversals</h2>
              <p className="muted">Issued invoices are not edited. Corrections use a credit note; reversing the credit restores affected invoice balances.</p>
            </div>
          </div>
          {can("billing.manage") ? (
            <form action={createCreditNoteAction} className="form-grid create-box">
              <label>
                Family
                <select name="family_id" defaultValue="" required>
                  <option value="" disabled>Select family</option>
                  {families.map((family) => (
                    <option key={family.id} value={family.id}>{family.family_number} · {family.display_name}</option>
                  ))}
                </select>
              </label>
              <label>
                Student (optional)
                <select name="student_id" defaultValue="">
                  <option value="">Family-level credit</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>{student.student_number} · {student.student_name}</option>
                  ))}
                </select>
              </label>
              <label>
                Original invoice (optional)
                <select name="invoice_id" defaultValue="">
                  <option value="">General family credit</option>
                  {invoices
                    .filter((invoice) => invoice.status !== "draft" && invoice.status !== "void")
                    .map((invoice) => (
                      <option key={invoice.id} value={invoice.id}>
                        {invoice.invoice_number} · {invoice.student_name} · balance {moneyLabel(invoice.balance_amount, invoice.currency)}
                      </option>
                    ))}
                </select>
              </label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Currency<input name="currency" maxLength={3} defaultValue={currencySetting} required /></label>
              <label>Date<input name="issued_on" type="date" defaultValue={today} required /></label>
              <label className="span-2">Reason<textarea name="reason" required /></label>
              <button type="submit">Issue credit note</button>
            </form>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead><tr><th>Credit note</th><th>Family / student</th><th>Original invoice</th><th>Amount</th><th>Available</th><th>Status</th><th /></tr></thead>
              <tbody>
                {credits.map((credit) => (
                  <tr key={credit.id}>
                    <td>{credit.credit_note_number}<div className="muted compact-text">{credit.reason}</div></td>
                    <td>{credit.family_number} · {credit.family_name}{credit.student_name ? ` · ${credit.student_name}` : ""}</td>
                    <td>{credit.invoice_number ?? "General credit"}</td>
                    <td>{moneyLabel(credit.amount, credit.currency)}</td>
                    <td>{moneyLabel(credit.unallocated_amount, credit.currency)}</td>
                    <td><span className="badge">{credit.status}</span></td>
                    <td>
                      {can("billing.manage") && credit.status === "issued" ? (
                        <div className="compact-form">
                          {Number(credit.unallocated_amount) > 0 ? (
                            <form action={allocateCreditNoteAction} className="inline-form compact-form">
                              <input type="hidden" name="credit_note_id" value={credit.id} />
                              <label>
                                Invoice
                                <select name="invoice_id" defaultValue="" required>
                                  <option value="" disabled>Select open invoice</option>
                                  {openInvoices
                                    .filter((invoice) => invoice.family_id === credit.family_id)
                                    .filter((invoice) => !credit.student_id || invoice.student_id === credit.student_id)
                                    .map((invoice) => (
                                      <option key={invoice.id} value={invoice.id}>
                                        {invoice.invoice_number} · {invoice.student_name} · {moneyLabel(invoice.balance_amount, invoice.currency)}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max={credit.unallocated_amount} required /></label>
                              <button type="submit">Allocate credit</button>
                            </form>
                          ) : null}
                          <form action={reverseCreditNoteAction} className="inline-form compact-form">
                            <input type="hidden" name="credit_note_id" value={credit.id} />
                            <label>Reversal reason<input name="reason" required /></label>
                            <button type="submit" className="secondary">Reverse credit</button>
                          </form>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {can("billing.view") || can("payments.view") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ledger</p>
              <h2>Family ledger</h2>
              <p className="muted">Invoices are debits. Posted payments and issued credit notes are credits.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Family</th><th>Student</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {familyLedger.map((entry, index) => (
                  <tr key={`${entry.entry_type}-${entry.source_id}-${index}`}>
                    <td>{entry.entry_date}</td>
                    <td>{entry.family_number} · {entry.family_name}</td>
                    <td>{entry.student_number ? `${entry.student_number} · ${entry.student_name}` : "Family-level"}</td>
                    <td>{entry.entry_type.replaceAll("_", " ")}</td>
                    <td>{entry.reference}</td>
                    <td>{entry.description}</td>
                    <td>{Number(entry.debit_amount) ? moneyLabel(entry.debit_amount, currencySetting) : "—"}</td>
                    <td>{Number(entry.credit_amount) ? moneyLabel(entry.credit_amount, currencySetting) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-heading">
            <div>
              <p className="eyebrow">Per child</p>
              <h2>Student ledger</h2>
              <p className="muted">Family-level funds appear here only once they are allocated to that child's invoice.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Student</th><th>Type</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {studentLedger.map((entry, index) => (
                  <tr key={`${entry.entry_type}-${entry.source_id}-${index}`}>
                    <td>{entry.entry_date}</td>
                    <td>{entry.student_number} · {entry.student_name}</td>
                    <td>{entry.entry_type.replaceAll("_", " ")}</td>
                    <td>{entry.reference}</td>
                    <td>{entry.description}</td>
                    <td>{Number(entry.debit_amount) ? moneyLabel(entry.debit_amount, currencySetting) : "—"}</td>
                    <td>{Number(entry.credit_amount) ? moneyLabel(entry.credit_amount, currencySetting) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel section-block">
        <p className="eyebrow">Milestone 3</p>
        <h2>Three-child manual balance test</h2>
        <p className="muted">
          With a 1,000.00 term fee: Child A normal = 1,000.00; Child B sibling 10% = 900.00;
          Child C custom fixed 150.00 = 850.00. CI verifies these exact balances plus combined-discount modes,
          partial payments, prepayments, overpayments, credit notes and reversals.
        </p>
      </section>
    </main>
  );
}
