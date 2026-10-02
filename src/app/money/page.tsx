import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
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
    <main className="app-shell money-workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">Money</p>
          <h1>Everyday financial operations</h1>
          <p className="muted">Expenses, suppliers, cash/bank and rent in one working screen. Detailed ledgers and accounting stay in advanced tools.</p>
        </div>
        <div className="top-actions">
          {(canExpenses || canSuppliers || canBanking) ? <Link className="button-link secondary-link" href="/operations">Advanced operations</Link> : null}
          {canRent ? <Link className="button-link secondary-link" href="/rentals">Rental agreements</Link> : null}
          {canAccounting ? <Link className="button-link secondary-link" href="/accounting">Accounting</Link> : null}
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <nav className="family-hub-nav no-print" aria-label="Money sections">
        {canExpenses ? <a href="#expenses">Expenses</a> : null}
        {canSuppliers ? <a href="#suppliers">Suppliers</a> : null}
        {canBanking ? <a href="#cash-bank">Cash & bank</a> : null}
        {canRent ? <a href="#rent">Rent</a> : null}
        {(can("billing.view") || can("payments.view")) ? <Link href="/billing">Family payments</Link> : null}
      </nav>

      <section className="money-summary-grid">
        {canBanking ? <article className="panel"><p className="eyebrow">Cash & bank</p><h2><MoneyStack values={totals(cashBank,"balance")}/></h2><p className="muted">{cashBank.length} active account{cashBank.length===1?"":"s"}.</p></article> : null}
        {canExpenses ? <article className="panel"><p className="eyebrow">Expense approvals</p><h2>{pendingExpenses.length}</h2><p className="muted">Pending or approved expenses waiting for completion.</p></article> : null}
        {canSuppliers ? <article className="panel"><p className="eyebrow">Supplier payables</p><h2><MoneyStack values={totals(payableBills,"balance_amount")}/></h2><p className="muted">{overdueBills.length} overdue supplier bill{overdueBills.length===1?"":"s"}.</p></article> : null}
        {canRent ? <article className="panel"><p className="eyebrow">Rent due</p><h2><MoneyStack values={totals(rentDue,"amount_due")}/></h2><p className="muted">{overdueRent.length} overdue schedule{overdueRent.length===1?"":"s"}.</p></article> : null}
      </section>

      {canExpenses ? <section className="panel section-block" id="expenses">
        <div className="section-heading"><div><p className="eyebrow">Expenses</p><h2>Record an expense</h2><p className="muted">Normal staff only choose what was spent, how much, and which cash/bank account paid it.</p></div>{can("expenses.approve") || can("expenses.post") ? <Link className="button-link secondary-link" href="/operations#expenses">Approval & posting</Link> : null}</div>
        {can("expenses.manage") ? <form action={createExpenseAction} className="simple-money-form">
          <input type="hidden" name="return_to" value="/money"/>
          <input type="hidden" name="submit_mode" value="submit"/>
          <label>Supplier (optional)<select name="supplier_id" defaultValue=""><option value="">No supplier</option>{suppliers.map((s)=><option key={s.id} value={s.id}>{s.supplier_number} · {s.name}</option>)}</select></label>
          <label>Expense type<select name="expense_account_id" defaultValue="" required><option value="" disabled>Select expense type</option>{expenseAccounts.map((a)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>
          <label>Paid from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label>
          <label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
          <label>Date<input name="incurred_on" type="date" defaultValue={today} required/></label>
          <label>Method<select name="payment_method" defaultValue="cash"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
          <label>Reference<input name="reference"/></label>
          <label className="span-2">Notes<input name="notes"/></label>
          <button type="submit">Save expense</button>
        </form> : null}
        <div className="money-list">
          {expenses.slice(0,12).map((e)=><article className="money-list-row" key={e.id}><div><strong>{e.expense_number} · {e.expense_name}</strong><small>{iso(e.incurred_on)}{e.supplier_name?` · ${e.supplier_name}`:""} · {e.payment_name}</small></div><div><strong>{money(e.amount,e.currency)}</strong><span className="badge">{e.status}</span></div></article>)}
          {!expenses.length ? <p className="muted">No expenses yet.</p> : null}
        </div>
      </section> : null}

      {canSuppliers ? <section className="panel section-block" id="suppliers">
        <div className="section-heading"><div><p className="eyebrow">Suppliers</p><h2>Bills & payments</h2><p className="muted">Create supplier records and bills here; pay posted bills from the same screen.</p></div><Link className="button-link secondary-link" href="/operations#suppliers">Supplier statements & corrections</Link></div>
        {can("suppliers.manage") ? <div className="money-two-column">
          <form action={createSupplierAction} className="compact-form money-action-box">
            <input type="hidden" name="return_to" value="/money"/>
            <h3>New supplier</h3>
            <label>Name<input name="name" required/></label><label>Contact<input name="contact_name"/></label><label>Phone<input name="phone"/></label><label>Email<input name="email" type="email"/></label><label>Payment terms (days)<input name="payment_terms_days" type="number" min="0" defaultValue="0"/></label><button type="submit">Add supplier</button>
          </form>
          <form action={createSupplierInvoiceAction} className="compact-form money-action-box">
            <input type="hidden" name="return_to" value="/money"/>
            <h3>New supplier bill</h3>
            <label>Supplier<select name="supplier_id" defaultValue="" required><option value="" disabled>Select supplier</option>{suppliers.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>Expense type<select name="expense_account_id" defaultValue="" required><option value="" disabled>Select expense type</option>{expenseAccounts.map((a)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label>
            <label>Invoice date<input name="invoice_date" type="date" defaultValue={today} required/></label><label>Due date<input name="due_on" type="date" defaultValue={today} required/></label>
            <label>Supplier reference<input name="supplier_reference"/></label><label>Notes<input name="notes"/></label><button type="submit">Save supplier bill</button>
          </form>
        </div> : null}
        <div className="card-list">
          {openSupplierBills.map((bill)=><article className="subcard" key={bill.id}>
            <div className="row-between"><div><strong>{bill.supplier_name} · {bill.supplier_invoice_number}</strong><div className="muted">Invoice {iso(bill.invoice_date)} · due {iso(bill.due_on)}</div></div><span className="badge">{bill.status}</span></div>
            <div className="record-grid"><div><small>Original</small><strong>{money(bill.amount,bill.currency)}</strong></div><div><small>Balance</small><strong>{money(bill.balance_amount,bill.currency)}</strong></div><div><small>Expense</small><strong>{bill.expense_name}</strong></div></div>
            {can("suppliers.manage") && ["posted","partially_paid"].includes(bill.status) && Number(bill.balance_amount)>0 ? <form action={paySupplierInvoiceAction} className="inline-form compact-form">
              <input type="hidden" name="return_to" value="/money"/><input type="hidden" name="supplier_invoice_id" value={bill.id}/><input type="hidden" name="currency" value={bill.currency}/>
              <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.filter((a)=>a.currency===bill.currency).map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max={bill.balance_amount} defaultValue={bill.balance_amount} required/></label>
              <label>Date<input name="paid_on" type="date" defaultValue={today} required/></label><label>Method<select name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label>
              <label>Reference<input name="reference"/></label><button type="submit">Pay bill</button>
            </form> : null}
          </article>)}
          {!openSupplierBills.length ? <p className="muted">No open supplier bills.</p> : null}
        </div>
      </section> : null}

      {canBanking ? <section className="panel section-block" id="cash-bank">
        <div className="section-heading"><div><p className="eyebrow">Cash & bank</p><h2>Balances & money movement</h2></div>{can("banking.reconcile") ? <Link className="button-link secondary-link" href="/operations">Reconciliation</Link> : null}</div>
        <div className="cash-bank-grid">{cashBank.map((a)=><div className="cash-bank-total" key={a.account_id}><span>{a.account_kind} · {a.display_name}</span><strong>{money(a.balance,a.currency)}</strong></div>)}</div>
        {can("banking.manage") ? <form action={createCashBankTransactionAction} className="simple-money-form">
          <input type="hidden" name="return_to" value="/money"/>
          <label>Action<select name="transaction_kind" defaultValue="transfer"><option value="transfer">Transfer</option><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label>
          <label>Cash/bank account<select name="account_id" defaultValue="" required><option value="" disabled>Select account</option>{cashBank.map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {a.currency}</option>)}</select></label>
          <label>Other account<select name="contra_account_id" defaultValue="" required><option value="" disabled>Select destination / source</option>{postingAccounts.map((a)=><option key={a.id} value={a.id}>{a.code} · {a.name} · {a.category}</option>)}</select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label><label>Currency<input name="currency" defaultValue={currencySetting} maxLength={3} required/></label><label>Date<input name="transaction_date" type="date" defaultValue={today} required/></label>
          <label>Reference<input name="reference"/></label><label>Notes<input name="notes"/></label><button type="submit">Post money movement</button>
        </form> : null}
        {transactions.length ? <details className="hub-details"><summary>Recent cash/bank activity ({transactions.length})</summary><div className="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Accounts</th><th>Amount</th></tr></thead><tbody>{transactions.map((t)=><tr key={t.id}><td>{iso(t.transaction_date)}</td><td>{t.transaction_number}</td><td>{t.transaction_kind}</td><td>{t.account_name} ↔ {t.contra_name}</td><td>{money(t.amount,t.currency)}</td></tr>)}</tbody></table></div></details> : null}
      </section> : null}

      {canRent ? <section className="panel section-block" id="rent">
        <div className="section-heading"><div><p className="eyebrow">Rent</p><h2>Upcoming & overdue rent</h2><p className="muted">Pay scheduled rent here. Agreements, deposits, recognition and reversals remain under Rental agreements.</p></div><Link className="button-link secondary-link" href="/rentals">Rental agreements</Link></div>
        <div className="card-list">
          {rentDue.map((r)=><article className="subcard" key={`${r.rental_agreement_id}-${r.due_on}`}>
            <div className="row-between"><div><strong>{r.property_name}</strong><div className="muted">{r.agreement_number} · due {iso(r.due_on)}</div></div><strong>{money(r.amount_due,r.currency)}</strong></div>
            {can("rentals.pay") ? <form action={createRentPaymentAction} className="inline-form compact-form">
              <input type="hidden" name="return_to" value="/money"/><input type="hidden" name="rental_agreement_id" value={r.rental_agreement_id}/><input type="hidden" name="payment_type" value="rent"/><input type="hidden" name="currency" value={r.currency}/>
              <label>Pay from<select name="payment_account_id" defaultValue="" required><option value="" disabled>Select cash/bank</option>{cashBank.filter((a)=>a.currency===r.currency).map((a)=><option key={a.account_id} value={a.account_id}>{a.display_name} · {money(a.balance,a.currency)}</option>)}</select></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" defaultValue={r.amount_due} required/></label><label>Date<input name="paid_on" type="date" defaultValue={today} required/></label>
              <label>Method<select name="method" defaultValue="bank_transfer"><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="check">Cheque</option><option value="other">Other</option></select></label><label>Reference<input name="reference"/></label><button type="submit">Pay rent</button>
            </form> : null}
          </article>)}
          {!rentDue.length ? <p className="muted">No unpaid rent due within the next 60 days.</p> : null}
        </div>
      </section> : null}

      {recurring.length ? <section className="panel section-block">
        <div className="section-heading"><div><p className="eyebrow">Recurring</p><h2>Upcoming repeating expenses</h2></div><Link className="button-link secondary-link" href="/operations">Manage recurring expenses</Link></div>
        <div className="money-list">{recurring.map((r)=><article className="money-list-row" key={r.id}><div><strong>{r.name}</strong><small>{r.category_name}{r.supplier_name?` · ${r.supplier_name}`:""} · next {iso(r.next_due_on)}</small></div><strong>{money(r.amount,r.currency)}</strong></article>)}</div>
      </section> : null}
    </main>
  );
}
