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
  if (!values.length) return <span>—</span>;
  return (
    <span className="money-stack">
      {values.map(([currency, amount]) => (
        <span key={currency}>{money(amount, currency)}</span>
      ))}
    </span>
  );
}

function OverviewCard({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a className="home-stat-card" href={href}>
      <span className="home-stat-label">{label}</span>
      <strong className="home-stat-value">{children}</strong>
      <span className="home-stat-open">View details <span aria-hidden="true">→</span></span>
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
        <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
        <h1>Home</h1>
        <p className="muted">{today} · {auth.fullName}</p>
      </header>

      {hasSchoolOverview ? (
        <section className="home-section" aria-labelledby="school-overview-title">
          <div className="home-section-heading">
            <h2 id="school-overview-title">School overview</h2>
          </div>
          <div className="home-stat-grid">
            {canStudents ? (
              <OverviewCard href="/students" label="Active students">{activeStudents}</OverviewCard>
            ) : null}
            {canFees ? (
              <OverviewCard href="/billing" label="Expected this month"><MoneyStack values={expectedFees} /></OverviewCard>
            ) : null}
            {canFees ? (
              <OverviewCard href="/billing" label="Collected this month"><MoneyStack values={collectedFees} /></OverviewCard>
            ) : null}
            {canFees ? (
              <OverviewCard href="/billing" label="Outstanding fees"><MoneyStack values={outstandingFees} /></OverviewCard>
            ) : null}
            {canAlerts ? (
              <OverviewCard href="/notifications" label="Open alerts">{alertCount}</OverviewCard>
            ) : null}
          </div>
        </section>
      ) : null}

      {hasMoneyOverview ? (
        <section className="home-section" aria-labelledby="money-overview-title">
          <div className="home-section-heading">
            <h2 id="money-overview-title">Money overview</h2>
          </div>
          <div className="home-stat-grid">
            {canCash ? (
              <OverviewCard href="/money#cash-bank" label="Cash"><MoneyStack values={cash} /></OverviewCard>
            ) : null}
            {canCash ? (
              <OverviewCard href="/money#cash-bank" label="Bank"><MoneyStack values={bank} /></OverviewCard>
            ) : null}
            {canSuppliers ? (
              <OverviewCard href="/money#suppliers" label="Supplier bills due"><MoneyStack values={supplierDue} /></OverviewCard>
            ) : null}
            {canRent ? (
              <OverviewCard href="/money#rent" label="Rent due"><MoneyStack values={rentDue} /></OverviewCard>
            ) : null}
            {canPayroll ? (
              <OverviewCard href="/staff" label="Payroll due"><MoneyStack values={payrollDue} /></OverviewCard>
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
