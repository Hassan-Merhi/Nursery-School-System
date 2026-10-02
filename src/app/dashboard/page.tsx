import type { ReactNode } from "react";
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
  if (!values.length) return <span className="home-empty-value">—</span>;
  return (
    <span className="money-stack">
      {values.map(([currency, amount]) => (
        <span key={currency}>{money(amount, currency)}</span>
      ))}
    </span>
  );
}

function MetricLink({
  href,
  label,
  children,
  emphasis = false,
}: {
  href: string;
  label: string;
  children: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <a className={`home-stat-item${emphasis ? " home-stat-item-emphasis" : ""}`} href={href}>
      <span className="home-stat-topline">
        <span className="home-stat-label">{label}</span>
        <span className="home-stat-arrow" aria-hidden="true">↗</span>
      </span>
      <strong className="home-stat-value">{children}</strong>
    </a>
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
    alertCountResult,
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
           order by due_on,supplier_invoice_number`,
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
    canAlerts
      ? query<Row>("select count(*)::int count from system_notification where status in ('open','snoozed')")
      : emptyRows(),
  ]);

  const activeStudents = Number(activeStudentsResult.rows[0]?.count ?? 0);
  const outstandingFees = currencyTotals(receivablesResult.rows, "balance_amount");
  const supplierDue = currencyTotals(payablesResult.rows, "balance_amount");
  const expectedFees = expectedResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const collectedFees = collectedResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const cash = currencyTotals(cashBankResult.rows.filter((row) => row.account_kind === "cash"), "balance");
  const bank = currencyTotals(cashBankResult.rows.filter((row) => row.account_kind === "bank"), "balance");
  const rentDue = rentDueResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const payrollDue = payrollDueResult.rows.map((row) => [String(row.currency), Number(row.amount)] as MoneyValue);
  const alertCount = Number(alertCountResult.rows[0]?.count ?? 0);

  const hasSchoolOverview = canStudents || canFees || canAlerts;
  const hasMoneyOverview = canCash || canSuppliers || canRent || canPayroll;

  return (
    <main className="app-shell dashboard-shell home-dashboard">
      <header className="home-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>Home</h1>
        </div>
        <div className="home-header-meta">
          <strong>{auth.fullName}</strong>
          <span>{today}</span>
        </div>
      </header>

      {hasSchoolOverview ? (
        <section className="home-overview-panel" aria-labelledby="school-overview-title">
          <div className="home-section-heading">
            <div>
              <p className="eyebrow">School</p>
              <h2 id="school-overview-title">At a glance</h2>
            </div>
          </div>
          <div className="home-stat-grid">
            {canStudents ? (
              <MetricLink href="/students" label="Active students">{activeStudents}</MetricLink>
            ) : null}
            {canFees ? (
              <MetricLink href="/billing" label="Expected"><MoneyStack values={expectedFees} /></MetricLink>
            ) : null}
            {canFees ? (
              <MetricLink href="/billing" label="Collected"><MoneyStack values={collectedFees} /></MetricLink>
            ) : null}
            {canFees ? (
              <MetricLink href="/billing" label="Outstanding" emphasis><MoneyStack values={outstandingFees} /></MetricLink>
            ) : null}
            {canAlerts ? (
              <MetricLink href="/notifications" label="Alerts" emphasis={alertCount > 0}>{alertCount}</MetricLink>
            ) : null}
          </div>
        </section>
      ) : null}

      {hasMoneyOverview ? (
        <section className="home-overview-panel" aria-labelledby="money-overview-title">
          <div className="home-section-heading">
            <div>
              <p className="eyebrow">Finance</p>
              <h2 id="money-overview-title">Money</h2>
            </div>
          </div>
          <div className="home-stat-grid home-stat-grid-secondary">
            {canCash ? (
              <MetricLink href="/money#cash-bank" label="Cash"><MoneyStack values={cash} /></MetricLink>
            ) : null}
            {canCash ? (
              <MetricLink href="/money#cash-bank" label="Bank"><MoneyStack values={bank} /></MetricLink>
            ) : null}
            {canSuppliers ? (
              <MetricLink href="/money#suppliers" label="Supplier bills"><MoneyStack values={supplierDue} /></MetricLink>
            ) : null}
            {canRent ? (
              <MetricLink href="/money#rent" label="Rent due"><MoneyStack values={rentDue} /></MetricLink>
            ) : null}
            {canPayroll ? (
              <MetricLink href="/staff" label="Payroll due"><MoneyStack values={payrollDue} /></MetricLink>
            ) : null}
          </div>
        </section>
      ) : null}

      {!hasSchoolOverview && !hasMoneyOverview ? (
        <section className="panel empty-state">
          <strong>Home</strong>
          <span>Use the menu to open the areas available to your account.</span>
        </section>
      ) : null}
    </main>
  );
}
