import { query } from "@/lib/db";
import { requirePermission } from "@/lib/security";

type Row = Record<string, any>;
type MoneyValue = [string, number];

function money(amount: number, currency: string) {
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

function currencyTotals(rows: Row[], field: string): MoneyValue[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = String(row.currency ?? "USD");
    totals.set(currency, (totals.get(currency) ?? 0) + Number(row[field] ?? 0));
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function MoneyStack({ values }: { values: MoneyValue[] }) {
  if (!values.length) return <span>—</span>;
  return (
    <span className="money-stack">
      {values.map(([currency, amount]) => (
        <span key={currency}>{money(amount, currency)}</span>
      ))}
    </span>
  );
}

export default async function DashboardPage() {
  const auth = await requirePermission("dashboard.view");
  const can = (permission: string) => auth.permissions.includes(permission);
  const any = (permissions: string[]) => permissions.some(can);

  const canStudents = any([
    "students.view","students.manage","families.view","families.manage",
    "enrollments.view","enrollments.manage","management.view","reports.view",
  ]);
  const canFees = any([
    "billing.view","billing.manage","payments.view","payments.manage",
    "management.view","reports.view",
  ]);
  const canSuppliers = any([
    "suppliers.view","suppliers.manage","expenses.view","expenses.manage",
    "management.view","reports.view",
  ]);
  const canCash = any([
    "banking.view","banking.manage","accounting.view","accounting.manage",
    "management.view","reports.view",
  ]);
  const canRent = any([
    "rentals.view","rentals.manage","rentals.pay","rentals.post",
    "management.view","reports.view",
  ]);
  const canPayroll = any([
    "payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay",
    "management.view","reports.view",
  ]);
  const canAlerts = can("notifications.view");

  const clock = (
    await query<{ today: string; month_start: string; month_end: string }>(
      `select
         (now() at time zone sp.timezone)::date::text today,
         date_trunc('month',now() at time zone sp.timezone)::date::text month_start,
         (date_trunc('month',now() at time zone sp.timezone)+interval '1 month - 1 day')::date::text month_end
       from school_profile sp where sp.id=1`,
    )
  ).rows[0];

  const today = clock?.today ?? new Date().toISOString().slice(0, 10);
  const monthStart = clock?.month_start ?? today.slice(0, 8) + "01";
  const monthEnd = clock?.month_end ?? today;

  const emptyRows = () => Promise.resolve({ rows: [] as Row[] });

  const [
    activeStudentsResult,
    receivablesResult,
    expectedResult,
    collectedResult,
    payablesResult,
    cashBankResult,
    rentDueResult,
    payrollDueResult,
    upcomingRentResult,
    upcomingPayrollResult,
    alertCountResult,
    alertsResult,
  ] = await Promise.all([
    canStudents
      ? query<Row>("select report_active_student_count($1::date) as count", [today])
      : emptyRows(),
    canFees
      ? query<Row>(
          "select * from report_receivables($1::date) where balance_amount<>0 order by due_on,invoice_number",
          [today],
        )
      : emptyRows(),
    canFees
      ? query<Row>(
          `select currency,coalesce(sum(total_amount),0)::numeric(14,2)::text amount
           from invoice
           where due_on between $1::date and $2::date and status not in ('draft','void')
           group by currency order by currency`,
          [monthStart, monthEnd],
        )
      : emptyRows(),
    canFees
      ? query<Row>(
          `select p.currency,coalesce(sum(pa.amount),0)::numeric(14,2)::text amount
           from payment p
           join payment_allocation pa on pa.payment_id=p.id
           where p.received_on between $1::date and $2::date
             and pa.allocated_on<=$2::date
             and (p.status='posted' or p.reversed_at::date>$2::date)
           group by p.currency order by p.currency`,
          [monthStart, today],
        )
      : emptyRows(),
    canSuppliers
      ? query<Row>(
          `select * from report_payables($1::date)
           where balance_amount<>0 and due_on<=$1::date
           order by due_on,supplier_invoice_number limit 50`,
          [today],
        )
      : emptyRows(),
    canCash
      ? query<Row>("select * from report_cash_bank_balances($1::date) order by account_kind,display_name", [today])
      : emptyRows(),
    canRent
      ? query<Row>(
          `select b.currency,b.normal_balance::numeric(14,2)::text amount
           from accounting_mapping m
           join report_account_balances($1::date) b on b.account_id=m.account_id
           where m.role_key='rent_payable'`,
          [today],
        )
      : emptyRows(),
    canPayroll
      ? query<Row>(
          `select b.currency,b.normal_balance::numeric(14,2)::text amount
           from accounting_mapping m
           join report_account_balances($1::date) b on b.account_id=m.account_id
           where m.role_key in ('salary_payable','payroll_payable')`,
          [today],
        )
      : emptyRows(),
    canRent
      ? query<Row>(
          `select s.due_on,s.currency,
             greatest(s.amount-coalesce(s.paid_amount,0),0)::numeric(14,2)::text amount_due,
             a.agreement_number,a.property_name
           from rent_schedule_balance s
           join rental_agreement a on a.id=s.rental_agreement_id
           where s.due_on between $1::date and ($1::date + interval '30 days')
             and greatest(s.amount-coalesce(s.paid_amount,0),0)>0
           order by s.due_on,a.agreement_number limit 5`,
          [today],
        )
      : emptyRows(),
    canPayroll
      ? query<Row>(
          `select run_number,pay_date,currency,net_pay,status
           from payroll_run_summary
           where pay_date between $1::date and ($1::date + interval '30 days')
             and status in ('draft','pending','approved','locked')
           order by pay_date,run_number limit 5`,
          [today],
        )
      : emptyRows(),
    canAlerts
      ? query<Row>("select count(*)::int count from system_notification where status in ('open','snoozed')")
      : emptyRows(),
    canAlerts
      ? query<Row>(
          `select id,title,message,due_on,severity,status
           from system_notification
           where status in ('open','snoozed')
           order by case severity when 'critical' then 1 when 'warning' then 2 else 3 end,
                    due_on nulls last,created_at desc
           limit 6`,
        )
      : emptyRows(),
  ]);

  const activeStudents = Number(activeStudentsResult.rows[0]?.count ?? 0);
  const receivables = receivablesResult.rows;
  const payables = payablesResult.rows;
  const cashBank = cashBankResult.rows;
  const outstandingFees = currencyTotals(receivables, "balance_amount");
  const supplierDue = currencyTotals(payables, "balance_amount");
  const expectedFees = expectedResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const collectedFees = collectedResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const cash = currencyTotals(cashBank.filter((row) => row.account_kind === "cash"), "balance");
  const bank = currencyTotals(cashBank.filter((row) => row.account_kind === "bank"), "balance");
  const rentDue = rentDueResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const payrollDue = payrollDueResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const overdueFees = receivables.filter((row) => String(row.due_on ?? "").slice(0, 10) < today).length;
  const overdueSupplierBills = payables.filter((row) => String(row.due_on ?? "").slice(0, 10) < today).length;
  const alertCount = Number(alertCountResult.rows[0]?.count ?? 0);
  const attentionVisible = canFees || canSuppliers || canRent || canPayroll || canAlerts;

  return (
    <main className="app-shell dashboard-shell">
      <header className="dashboard-hero">
        <div>
          <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
          <h1>What needs attention today?</h1>
          <p className="muted">
            {today} · Signed in as {auth.fullName}. This page shows live operational totals allowed by your role.
          </p>
        </div>
      </header>

      {attentionVisible ? (
        <section className="attention-grid" aria-label="Items needing attention">
          {canFees ? (
            <a className="attention-card" href="/billing">
              <p className="eyebrow">Outstanding fees</p>
              <h2><MoneyStack values={outstandingFees} /></h2>
              <p className="muted">{overdueFees} overdue invoice{overdueFees === 1 ? "" : "s"}.</p>
            </a>
          ) : null}
          {canSuppliers ? (
            <a className="attention-card" href="/operations">
              <p className="eyebrow">Payments due</p>
              <h2><MoneyStack values={supplierDue} /></h2>
              <p className="muted">{overdueSupplierBills} overdue supplier bill{overdueSupplierBills === 1 ? "" : "s"}.</p>
            </a>
          ) : null}
          {canRent ? (
            <a className="attention-card" href="/rentals">
              <p className="eyebrow">Rent due</p>
              <h2><MoneyStack values={rentDue} /></h2>
              <p className="muted">{upcomingRentResult.rows.length} rent payment{upcomingRentResult.rows.length === 1 ? "" : "s"} in the next 30 days.</p>
            </a>
          ) : null}
          {canPayroll ? (
            <a className="attention-card" href="/payroll">
              <p className="eyebrow">Payroll due</p>
              <h2><MoneyStack values={payrollDue} /></h2>
              <p className="muted">{upcomingPayrollResult.rows.length} payroll run{upcomingPayrollResult.rows.length === 1 ? "" : "s"} in the next 30 days.</p>
            </a>
          ) : null}
          {canAlerts ? (
            <a className="attention-card" href="/notifications">
              <p className="eyebrow">Alerts</p>
              <h2>{alertCount}</h2>
              <p className="muted">Open or snoozed operational alerts.</p>
            </a>
          ) : null}
        </section>
      ) : (
        <section className="panel section-block">
          <h2>No operational summaries are available for this role.</h2>
          <p className="muted">Use the sections in the main menu for the areas you are permitted to access.</p>
        </section>
      )}

      <section className="dashboard-kpis">
        {canStudents ? (
          <article className="panel">
            <p className="eyebrow">Active students</p>
            <h2 className="metric-value">{activeStudents}</h2>
            <p className="muted">Current active enrollment.</p>
          </article>
        ) : null}
        {canFees ? (
          <article className="panel">
            <p className="eyebrow">Fees expected this month</p>
            <h2 className="metric-value"><MoneyStack values={expectedFees} /></h2>
            <p className="muted">Issued, non-void invoices due this month.</p>
          </article>
        ) : null}
        {canFees ? (
          <article className="panel">
            <p className="eyebrow">Collected this month</p>
            <h2 className="metric-value"><MoneyStack values={collectedFees} /></h2>
            <p className="muted">Payments allocated to tuition this month.</p>
          </article>
        ) : null}
        {canAlerts ? (
          <article className="panel">
            <p className="eyebrow">Open alerts</p>
            <h2 className="metric-value">{alertCount}</h2>
            <p className="muted">Notifications currently needing review.</p>
          </article>
        ) : null}
      </section>

      {canCash ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Cash position</p>
              <h2>Cash & bank</h2>
            </div>
            <a className="button-link secondary-link" href="/operations">Open banking</a>
          </div>
          <div className="cash-bank-grid">
            <div className="cash-bank-total">
              <span>Cash</span>
              <strong><MoneyStack values={cash} /></strong>
            </div>
            <div className="cash-bank-total">
              <span>Bank</span>
              <strong><MoneyStack values={bank} /></strong>
            </div>
          </div>
          {cashBank.length ? (
            <div className="table-wrap compact-dashboard-table">
              <table>
                <thead><tr><th>Account</th><th>Type</th><th>Currency</th><th>Balance</th></tr></thead>
                <tbody>
                  {cashBank.map((row) => (
                    <tr key={row.account_id}>
                      <td>{row.display_name}</td>
                      <td>{row.account_kind}</td>
                      <td>{row.currency}</td>
                      <td>{money(Number(row.balance ?? 0), String(row.currency ?? "USD"))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No active cash or bank accounts.</p>}
        </section>
      ) : null}

      {(canRent || canPayroll) ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Next 30 days</p>
              <h2>Upcoming payroll & rent</h2>
            </div>
          </div>
          <div className="upcoming-grid">
            {canRent ? (
              <div>
                <h3>Rent</h3>
                {upcomingRentResult.rows.length ? (
                  <div className="card-list">
                    {upcomingRentResult.rows.map((row, index) => (
                      <a className="dashboard-list-item" href="/rentals" key={row.agreement_number + ":" + index}>
                        <span><strong>{row.property_name}</strong><small>{row.agreement_number} · due {String(row.due_on).slice(0, 10)}</small></span>
                        <strong>{money(Number(row.amount_due), String(row.currency))}</strong>
                      </a>
                    ))}
                  </div>
                ) : <p className="muted">No unpaid rent schedules due in the next 30 days.</p>}
              </div>
            ) : null}
            {canPayroll ? (
              <div>
                <h3>Payroll</h3>
                {upcomingPayrollResult.rows.length ? (
                  <div className="card-list">
                    {upcomingPayrollResult.rows.map((row) => (
                      <a className="dashboard-list-item" href="/payroll" key={row.run_number}>
                        <span><strong>{row.run_number}</strong><small>Pay date {String(row.pay_date).slice(0, 10)} · {row.status}</small></span>
                        <strong>{money(Number(row.net_pay), String(row.currency))}</strong>
                      </a>
                    ))}
                  </div>
                ) : <p className="muted">No payroll runs scheduled in the next 30 days.</p>}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {canAlerts ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Alerts</p>
              <h2>Needs review</h2>
            </div>
            <a className="button-link secondary-link" href="/notifications">Open notification center</a>
          </div>
          {alertsResult.rows.length ? (
            <div className="card-list">
              {alertsResult.rows.map((alert) => (
                <a className="dashboard-list-item" href="/notifications" key={alert.id}>
                  <span>
                    <strong>{alert.title}</strong>
                    <small>{alert.message}</small>
                  </span>
                  <span className="badge">{alert.severity}</span>
                </a>
              ))}
            </div>
          ) : <p className="muted">No open alerts. Nothing needs review here right now.</p>}
        </section>
      ) : null}
    </main>
  );
}
