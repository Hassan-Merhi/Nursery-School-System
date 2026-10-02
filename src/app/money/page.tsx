import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";
import {
  createCashBankTransactionAction,
  createExpenseAction,
  createSupplierAction,
  createSupplierInvoiceAction,
  paySupplierInvoiceAction,
} from "@/app/operations/actions";
import { createRentPaymentAction } from "@/app/rentals/actions";

type Row = Record<string, any>;
type MoneyValue = [string, number];

type MoneyModuleIconName = "expenses" | "suppliers" | "banking" | "rent" | "recurring";

function MoneyModuleIcon({ name }: { name: MoneyModuleIconName }) {
  if (name === "expenses") return <span className="money-module-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16M6 4h12v16H6z"/><path d="M9 11h6M9 15h4"/></svg></span>;
  if (name === "suppliers") return <span className="money-module-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20V8l8-4 8 4v12"/><path d="M8 20v-5h8v5M8 10h.01M12 10h.01M16 10h.01"/></svg></span>;
  if (name === "banking") return <span className="money-module-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 9 9-5 9 5"/><path d="M5 10h14M6 18h12M4 21h16"/><path d="M8 10v8M12 10v8M16 10v8"/></svg></span>;
  if (name === "rent") return <span className="money-module-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></svg></span>;
  return <span className="money-module-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.6-1L20 9M4 15l2.3 2a7 7 0 0 0 11.6-1"/></svg></span>;
}


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
function iso(value: unknown) { return String(value ?? "").slice(0, 10); }
function totals(rows: Row[], field: string): MoneyValue[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const currency = String(row.currency ?? "USD");
    map.set(currency, (map.get(currency) ?? 0) + Number(row[field] ?? 0));
  }
  return [...map.entries()].filter(([, amount]) => amount !== 0).sort(([a],[b]) => a.localeCompare(b));
}
function MoneyStack({ values }: { values: MoneyValue[] }) {
  return values.length
    ? <span className="money-stack">{values.map(([currency, amount]) => <span key={currency}>{money(amount, currency)}</span>)}</span>
    : <span>—</span>;
}

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const profile = deriveUiProfile(auth.permissions, auth.roles);
  if (profile.kind === "reception") redirect("/billing");
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  const permissions = [
    "billing.view","billing.manage","payments.view","payments.manage",
    "expenses.view","expenses.manage","expenses.approve","expenses.post",
    "suppliers.view","suppliers.manage","banking.view","banking.manage","banking.reconcile",
    "recurring_expenses.view","recurring_expenses.manage","refunds.manage",
    "rentals.view","rentals.manage","rentals.pay","rentals.post",
    "accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping",
  ];
  if (!permissions.some(can)) redirect("/forbidden");

  const canExpenses = ["expenses.view","expenses.manage","expenses.approve","expenses.post"].some(can);
  const canSuppliers = ["suppliers.view","suppliers.manage"].some(can);
  const canBanking = ["banking.view","banking.manage","banking.reconcile"].some(can);
  const canRent = ["rentals.view","rentals.manage","rentals.pay","rentals.post"].some(can);
  const canAccounting = ["accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping"].some(can);

  const empty = () => Promise.resolve({ rows: [] as Row[] });
  const [
    clockR, currencyR, cashR, suppliersR, expenseAccountsR, postingAccountsR,
    expensesR, supplierInvoicesR, rentR, recurringR, transactionsR,
  ] = await Promise.all([
    query<Row>("select (now() at time zone 'Asia/Beirut')::date::text today"),
    query<Row>("select value #>> '{}' currency from app_setting where key='currency'"),
    (canBanking || can("expenses.manage") || can("suppliers.manage") || can("rentals.pay"))
      ? query<Row>("select * from cash_bank_balance where is_active=true order by account_kind,display_name")
      : empty(),
    (canSuppliers || can("expenses.manage"))
      ? query<Row>("select * from supplier where status='active' order by name")
      : empty(),
    can("expenses.manage") || can("suppliers.manage")
      ? query<Row>("select a.id,a.code,a.name,a.currency from account a join account_type t on t.id=a.account_type_id where t.category='expense' and a.status='active' and a.allow_posting=true order by a.code")
      : empty(),
    can("banking.manage")
      ? query<Row>("select a.id,a.code,a.name,a.currency,t.category from account a join account_type t on t.id=a.account_type_id where a.status='active' and a.allow_posting=true order by a.code")
      : empty(),
    canExpenses
      ? query<Row>("select e.*,s.name supplier_name,ea.name expense_name,pa.name payment_name from expense e left join supplier s on s.id=e.supplier_id join account ea on ea.id=e.expense_account_id join account pa on pa.id=e.payment_account_id order by e.incurred_on desc,e.created_at desc limit 40")
      : empty(),
    (canSuppliers || can("expenses.approve") || can("expenses.post"))
      ? query<Row>("select b.*,s.name supplier_name,a.name expense_name from supplier_invoice_balance b join supplier s on s.id=b.supplier_id join account a on a.id=b.expense_account_id where b.status not in ('reversed') order by b.due_on,b.created_at desc limit 60")
      : empty(),
    canRent
      ? query<Row>(
          `select s.rental_agreement_id,s.due_on,s.currency,
             greatest(s.amount-coalesce(s.paid_amount,0),0)::numeric(14,2) amount_due,
             a.agreement_number,a.property_name,a.status agreement_status
           from rent_schedule_balance s
           join rental_agreement a on a.id=s.rental_agreement_id
           where a.status in ('active','ended')
             and greatest(s.amount-coalesce(s.paid_amount,0),0)>0
             and s.due_on<=($1::date + interval '60 days')
           order by s.due_on,a.agreement_number limit 40`,
          [(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today ?? new Date().toISOString().slice(0,10)],
        )
      : empty(),
    (can("recurring_expenses.view") || can("recurring_expenses.manage"))
      ? query<Row>("select r.*,c.name category_name,s.name supplier_name from recurring_expense r join recurring_expense_category c on c.category_key=r.category_key left join supplier s on s.id=r.supplier_id where r.status='active' order by r.next_due_on limit 20")
      : empty(),
    canBanking
      ? query<Row>("select t.*,a.name account_name,c.name contra_name from cash_bank_transaction t join account a on a.id=t.account_id join account c on c.id=t.contra_account_id order by t.transaction_date desc,t.created_at desc limit 20")
      : empty(),
  ]);

  const today = clockR.rows[0]?.today ?? new Date().toISOString().slice(0,10);
  const currencySetting = currencyR.rows[0]?.currency ?? "USD";
  const cashBank = cashR.rows;
  const suppliers = suppliersR.rows;
  const expenseAccounts = expenseAccountsR.rows;
  const postingAccounts = postingAccountsR.rows;
  const expenses = expensesR.rows;
  const supplierInvoices = supplierInvoicesR.rows;
  const rentDue = rentR.rows;
  const recurring = recurringR.rows;
  const transactions = transactionsR.rows;
  const openSupplierBills = supplierInvoices.filter((row) => Number(row.balance_amount) > 0 && ["posted","partially_paid","approved","draft"].includes(row.status));
  const payableBills = supplierInvoices.filter((row) => Number(row.balance_amount) > 0 && ["posted","partially_paid"].includes(row.status));
  const overdueBills = payableBills.filter((row) => iso(row.due_on) < today);
  const pendingExpenses = expenses.filter((row) => ["pending","approved"].includes(row.status));
  const overdueRent = rentDue.filter((row) => iso(row.due_on) < today);


  return (
    <main className="app-shell money-modern-shell">
      <header className="money-modern-header">
        <div>
          <p className="eyebrow">Money</p>
          <h1>Money</h1>
          <p className="muted">Expenses, suppliers, cash, bank and rent.</p>
        </div>
        <details className="money-tools-menu no-print">
          <summary>More</summary>
          <div>
            {(canExpenses || canSuppliers || canBanking) ? <Link href="/operations">Advanced operations</Link> : null}
            {canRent ? <Link href="/rentals">Rental agreements</Link> : null}
            {canAccounting ? <Link href="/accounting">Accounting</Link> : null}
          </div>
        </details>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <section className="money-modern-summary" aria-label="Money overview">
        {canBanking ? <a href="#cash-bank"><span>Cash & bank</span><strong><MoneyStack values={totals(cashBank,"balance")} /></strong></a> : null}
        {canExpenses ? <a href="#expenses"><span>Pending expenses</span><strong>{pendingExpenses.length}</strong></a> : null}
        {canSuppliers ? <a href="#suppliers"><span>Supplier bills</span><strong><MoneyStack values={totals(payableBills,"balance_amount")} /></strong></a> : null}
        {canRent ? <a href="#rent"><span>Rent due</span><strong><MoneyStack values={totals(rentDue,"amount_due")} /></strong></a> : null}
      </section>

      <nav className="money-modern-nav no-print" aria-label="Money sections">
        {canExpenses ? <a href="#expenses">Expenses</a> : null}
        {canSuppliers ? <a href="#suppliers">Suppliers</a> : null}
        {canBanking ? <a href="#cash-bank">Cash & bank</a> : null}
        {canRent ? <a href="#rent">Rent</a> : null}
        {(can("billing.view") || can("payments.view")) ? <Link href="/billing">Family payments</Link> : null}
      </nav>

      <div className="money-module-list">
        {canExpenses ? (
          <details className="money-module" id="expenses" open>
            <summary>
              <span className="money-module-title"><MoneyModuleIcon name="expenses" /><span><strong>Expenses</strong><small>Record spending and see recent expenses</small></span></span>
              <span className="money-module-side"><span className="money-module-value">{pendingExpenses.length} pending</span><span className="money-module-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="money-module-body">
              {can("expenses.manage") ? (
                <details className="money-action-card">
                  <summary>Record an expense</summary>
                  <form action={createExpenseAction} className="money-modern-form">
                    <input type="hidden" name="return_to" value="/money"/>
                    <input type="hidden" name="submit_mode" value="submit"/>
                    <label>Supplier <small>optional</small><select name="supplier_id" defaultValue=""><option value="">No supplier</option>{suppliers.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                    <label>Expense type<select name="expense_account_id" defaultValue="" required><option value="" disabled>Select expense type</option>{expenseAccounts.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                    <label>Paid from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
                    <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label>
                    <label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
                    <label>Date<input name="incurred_on" type="date" defaultValue={today} required/></label>
                    <label>Method<select name="payment_method" defaultValue="cash"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
                    <label>Reference <small>optional</small><input name="reference"/></label>
                    <label className="money-form-wide">Notes <small>optional</small><input name="notes"/></label>
                    <button type="submit">Save expense</button>
                  </form>
                </details>
              ) : null}

              {(can("expenses.approve") || can("expenses.post")) ? <Link className="money-inline-link" href="/operations#expenses">Approval & posting →</Link> : null}

              <div className="money-modern-list">
                {expenses.slice(0,10).map((e)=><article className="money-modern-row" key={e.id}>
                  <div><strong>{e.expense_name}</strong><small>{iso(e.incurred_on)}{e.supplier_name ? " · " + e.supplier_name : ""}</small></div>
                  <div><strong>{money(e.amount,e.currency)}</strong><span className="badge">{e.status}</span></div>
                </article>)}
                {!expenses.length ? <div className="money-modern-empty">No expenses yet.</div> : null}
              </div>
            </div>
          </details>
        ) : null}

        {canSuppliers ? (
          <details className="money-module" id="suppliers">
            <summary>
              <span className="money-module-title"><MoneyModuleIcon name="suppliers" /><span><strong>Suppliers</strong><small>Bills, balances and payments</small></span></span>
              <span className="money-module-side"><span className="money-module-value">{openSupplierBills.length} open</span><span className="money-module-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="money-module-body">
              {can("suppliers.manage") ? (
                <div className="money-action-grid">
                  <details className="money-action-card">
                    <summary>Add supplier</summary>
                    <form action={createSupplierAction} className="money-modern-form money-modern-form-single">
                      <input type="hidden" name="return_to" value="/money"/>
                      <label>Name<input name="name" required/></label>
                      <label>Contact<input name="contact_name"/></label>
                      <label>Phone<input name="phone"/></label>
                      <label>Email<input name="email" type="email"/></label>
                      <label>Payment terms<input name="payment_terms_days" type="number" min="0" defaultValue="0"/></label>
                      <button type="submit">Add supplier</button>
                    </form>
                  </details>
                  <details className="money-action-card">
                    <summary>Add supplier bill</summary>
                    <form action={createSupplierInvoiceAction} className="money-modern-form">
                      <input type="hidden" name="return_to" value="/money"/>
                      <label>Supplier<select name="supplier_id" defaultValue="" required><option value="" disabled>Select supplier</option>{suppliers.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                      <label>Expense type<select name="expense_account_id" defaultValue="" required><option value="" disabled>Select expense type</option>{expenseAccounts.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                      <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label>
                      <label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
                      <label>Invoice date<input name="invoice_date" type="date" defaultValue={today} required/></label>
                      <label>Due date<input name="due_on" type="date" defaultValue={today} required/></label>
                      <label>Reference<input name="supplier_reference"/></label>
                      <label>Notes<input name="notes"/></label>
                      <button type="submit">Save bill</button>
                    </form>
                  </details>
                </div>
              ) : null}

              <Link className="money-inline-link" href="/operations#suppliers">Supplier statements & corrections →</Link>

              <div className="money-modern-list">
                {openSupplierBills.map((bill)=><article className="money-modern-row money-modern-row-stack" key={bill.id}>
                  <div className="money-modern-row-head">
                    <div><strong>{bill.supplier_name}</strong><small>{bill.supplier_invoice_number} · due {iso(bill.due_on)}</small></div>
                    <div><strong>{money(bill.balance_amount,bill.currency)}</strong><span className="badge">{bill.status}</span></div>
                  </div>
                  {can("suppliers.manage") && ["posted","partially_paid"].includes(bill.status) && Number(bill.balance_amount)>0 ? (
                    <details className="money-inline-action">
                      <summary>Pay bill</summary>
                      <form action={paySupplierInvoiceAction} className="money-modern-form">
                        <input type="hidden" name="return_to" value="/money"/>
                        <input type="hidden" name="supplier_invoice_id" value={bill.id}/>
                        <input type="hidden" name="currency" value={bill.currency}/>
                        <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.filter((a)=>a.currency===bill.currency).map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
                        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max={bill.balance_amount} defaultValue={bill.balance_amount} required/></label>
                        <label>Date<input name="paid_on" type="date" defaultValue={today} required/></label>
                        <label>Method<select name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
                        <label>Reference<input name="reference"/></label>
                        <button type="submit">Pay bill</button>
                      </form>
                    </details>
                  ) : null}
                </article>)}
                {!openSupplierBills.length ? <div className="money-modern-empty">No open supplier bills.</div> : null}
              </div>
            </div>
          </details>
        ) : null}

        {canBanking ? (
          <details className="money-module" id="cash-bank">
            <summary>
              <span className="money-module-title"><MoneyModuleIcon name="banking" /><span><strong>Cash & bank</strong><small>Balances and transfers</small></span></span>
              <span className="money-module-side"><span className="money-module-value"><MoneyStack values={totals(cashBank,"balance")} /></span><span className="money-module-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="money-module-body">
              <div className="money-account-strip">
                {cashBank.map((a)=><div key={a.account_id}><span>{a.display_name}</span><strong>{money(a.balance,a.currency)}</strong></div>)}
                {!cashBank.length ? <div className="money-modern-empty">No active cash or bank accounts.</div> : null}
              </div>

              {can("banking.manage") ? (
                <details className="money-action-card money-action-single">
                  <summary>Move money</summary>
                  <form action={createCashBankTransactionAction} className="money-modern-form">
                    <input type="hidden" name="return_to" value="/money"/>
                    <label>Action<select name="transaction_kind" defaultValue="transfer"><option value="transfer">Transfer</option><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label>
                    <label>Cash/bank account<select name="account_id" defaultValue="" required><option value="" disabled>Select account</option>{cashBank.map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {a.currency}</option>)}</select></label>
                    <label>Other account<select name="contra_account_id" defaultValue="" required><option value="" disabled>Select destination / source</option>{postingAccounts.map((a)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>
                    <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label>
                    <label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
                    <label>Date<input name="transaction_date" type="date" defaultValue={today} required/></label>
                    <label>Reference<input name="reference"/></label>
                    <label>Notes<input name="notes"/></label>
                    <button type="submit">Post movement</button>
                  </form>
                </details>
              ) : null}

              {can("banking.reconcile") ? <Link className="money-inline-link" href="/operations">Reconciliation →</Link> : null}

              {transactions.length ? (
                <details className="money-history">
                  <summary>Recent activity ({transactions.length})</summary>
                  <div className="responsive-card-table money-modern-table">
                    <table>
                      <thead><tr><th>Date</th><th>Type</th><th>Accounts</th><th>Amount</th></tr></thead>
                      <tbody>{transactions.map((t)=><tr key={t.id}><td data-label="Date">{iso(t.transaction_date)}</td><td data-label="Type">{t.transaction_kind}</td><td data-label="Accounts">{t.account_name} ↔ {t.contra_name}</td><td data-label="Amount">{money(t.amount,t.currency)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        ) : null}

        {canRent ? (
          <details className="money-module" id="rent">
            <summary>
              <span className="money-module-title"><MoneyModuleIcon name="rent" /><span><strong>Rent</strong><small>Upcoming and overdue rent</small></span></span>
              <span className="money-module-side"><span className="money-module-value">{rentDue.length} due</span><span className="money-module-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="money-module-body">
              <Link className="money-inline-link" href="/rentals">Rental agreements →</Link>
              <div className="money-modern-list">
                {rentDue.map((r)=><article className="money-modern-row money-modern-row-stack" key={r.rental_agreement_id + "-" + r.due_on}>
                  <div className="money-modern-row-head"><div><strong>{r.property_name}</strong><small>{r.agreement_number} · due {iso(r.due_on)}</small></div><strong>{money(r.amount_due,r.currency)}</strong></div>
                  {can("rentals.pay") ? (
                    <details className="money-inline-action">
                      <summary>Pay rent</summary>
                      <form action={createRentPaymentAction} className="money-modern-form">
                        <input type="hidden" name="return_to" value="/money"/>
                        <input type="hidden" name="rental_agreement_id" value={r.rental_agreement_id}/>
                        <input type="hidden" name="payment_type" value="rent"/>
                        <input type="hidden" name="currency" value={r.currency}/>
                        <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.filter((a)=>a.currency===r.currency).map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
                        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" defaultValue={r.amount_due} required/></label>
                        <label>Date<input name="paid_on" type="date" defaultValue={today} required/></label>
                        <label>Method<select name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
                        <label>Reference<input name="reference"/></label>
                        <button type="submit">Pay rent</button>
                      </form>
                    </details>
                  ) : null}
                </article>)}
                {!rentDue.length ? <div className="money-modern-empty">No unpaid rent due in the next 60 days.</div> : null}
              </div>
            </div>
          </details>
        ) : null}

        {recurring.length ? (
          <details className="money-module" id="recurring">
            <summary>
              <span className="money-module-title"><MoneyModuleIcon name="recurring" /><span><strong>Recurring expenses</strong><small>Upcoming repeating costs</small></span></span>
              <span className="money-module-side"><span className="money-module-value">{recurring.length}</span><span className="money-module-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="money-module-body">
              <Link className="money-inline-link" href="/operations">Manage recurring expenses →</Link>
              <div className="money-modern-list">{recurring.map((r)=><article className="money-modern-row" key={r.id}><div><strong>{r.name}</strong><small>{r.category_name}{r.supplier_name ? " · " + r.supplier_name : ""} · next {iso(r.next_due_on)}</small></div><strong>{money(r.amount,r.currency)}</strong></article>)}</div>
            </div>
          </details>
        ) : null}
      </div>
    </main>
  );
}
