import Link from "next/link";
import { Icon, type ExtraIcon } from "@/components/Icon";
import { NAV_GROUPS, canSee, type IconName } from "@/components/nav";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/security";

type QuickAction = { label: string; hint: string; href: string; icon: IconName | ExtraIcon; permissions: string[] };

// Section anchors match the ids PageSections derives from each page's headings.
const QUICK_ACTIONS: QuickAction[] = [
  { label: "Add a family", hint: "Parents and contact details", href: "/students#families-parents-and-emergency-contacts", icon: "users", permissions: ["families.manage"] },
  { label: "Add a child", hint: "New student in a family", href: "/students#students-and-sibling-relationships", icon: "plus", permissions: ["students.manage"] },
  { label: "Record a payment", hint: "Money received from parents", href: "/billing#payments-prepayments-and-overpayments", icon: "receipt", permissions: ["payments.manage"] },
  { label: "Create an invoice", hint: "Bill a family for a term", href: "/billing#invoices-and-additional-charges", icon: "receipt", permissions: ["billing.manage"] },
  { label: "Add an expense", hint: "Something the school paid for", href: "/operations#add-an-expense", icon: "wallet", permissions: ["expenses.manage"] },
  { label: "Food bills", hint: "Meals each child signed up for", href: "/food#food-bills", icon: "food", permissions: ["food.billing", "food.view"] },
  { label: "Run payroll", hint: "Monthly salaries and payslips", href: "/payroll#payroll-runs-approvals-locking-and-payment", icon: "briefcase", permissions: ["payroll.manage"] },
  { label: "See reports", hint: "Print or export", href: "/reports", icon: "chart", permissions: ["reports.view", "management.view"] },
];

type Stat = { label: string; value: string; hint: string; href: string; tone?: "warn" | "ok" };

async function count(sql: string) {
  return Number((await query<{ n: string }>(sql)).rows[0]?.n ?? 0);
}

export default async function HomePage() {
  const auth = await requirePermission("dashboard.view");
  const can = (permission: string) => auth.permissions.includes(permission);
  const firstName = auth.fullName.split(/\s+/)[0] || auth.fullName;

  const stats: Stat[] = [];
  if (can("students.view")) {
    const n = await count("select count(*) as n from student where status='active'");
    stats.push({ label: "Active children", value: String(n), hint: "Currently attending", href: "/students" });
  }
  if (can("families.view")) {
    const n = await count("select count(*) as n from family");
    stats.push({ label: "Families", value: String(n), hint: "On record", href: "/students" });
  }
  if (can("billing.view")) {
    const n = await count(
      "select count(*) as n from invoice where status in ('issued','partially_paid') and due_on < current_date",
    );
    stats.push({ label: "Overdue invoices", value: String(n), hint: n ? "Past their due date" : "Nothing overdue", href: "/billing", tone: n ? "warn" : "ok" });
  }
  if (can("notifications.view")) {
    const n = await count("select count(*) as n from system_notification where status='open'");
    stats.push({ label: "Open alerts", value: String(n), hint: n ? "Need your attention" : "All clear", href: "/notifications", tone: n ? "warn" : "ok" });
  }

  const alerts = can("notifications.view")
    ? (await query<{ id: string; title: string; message: string; severity: string; due_on: string | null }>(
        `select id,title,message,severity,due_on::text as due_on from system_notification
         where status='open'
         order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, due_on nulls last
         limit 5`,
      )).rows
    : [];

  const actions = QUICK_ACTIONS.filter((action) => action.permissions.some(can));
  const sections = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => item.href !== "/dashboard" && canSee(item, auth.permissions));

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Beirut",
  });

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>Hello, {firstName}</h1>
          <p className="muted">Here's what's happening at Montikids today.</p>
        </div>
      </header>

      {stats.length ? (
        <section className="stat-grid">
          {stats.map((stat) => (
            <Link key={stat.label} href={stat.href} className={"stat-card" + (stat.tone ? " " + stat.tone : "")}>
              <span className="stat-label">{stat.label}</span>
              <strong className="stat-value">{stat.value}</strong>
              <span className="stat-hint">{stat.hint}</span>
            </Link>
          ))}
        </section>
      ) : null}

      {actions.length ? (
        <section className="section-block">
          <h2 className="plain-heading">What do you want to do?</h2>
          <div className="action-grid">
            {actions.map((action) => (
              <Link key={action.label} href={action.href} className="action-card">
                <span className="action-icon"><Icon name={action.icon} size={22} /></span>
                <span>
                  <strong>{action.label}</strong>
                  <small>{action.hint}</small>
                </span>
                <Icon name="arrow" size={18} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {can("notifications.view") ? (
        <section className="panel section-block">
          <div className="row-between">
            <h2>Needs attention</h2>
            <Link href="/notifications">See all alerts</Link>
          </div>
          {alerts.length ? (
            <ul className="alert-list">
              {alerts.map((alert) => (
                <li key={alert.id} className={"alert-item " + alert.severity}>
                  <span className="alert-dot" aria-hidden="true" />
                  <span>
                    <strong>{alert.title}</strong>
                    <small>{alert.message}{alert.due_on ? ` · due ${alert.due_on}` : ""}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">Nothing needs your attention right now.</p>
          )}
        </section>
      ) : null}

      <section className="section-block">
        <h2 className="plain-heading">All sections</h2>
        <div className="module-grid">
          {sections.map((item) => (
            <Link key={item.href} href={item.href} className="module-card">
              <span className="action-icon"><Icon name={item.icon} size={22} /></span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
