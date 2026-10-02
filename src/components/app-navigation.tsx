import Link from "next/link";

type Props = {
  permissions: string[];
};

const groups = {
  students: [
    "families.view","families.manage","students.view","students.manage","classes.view","classes.manage",
    "enrollments.view","enrollments.manage","student_documents.view","student_documents.manage","student_history.view",
  ],
  money: [
    "billing.view","billing.manage","discounts.view","discounts.manage","discounts.approve","payments.view","payments.manage",
    "accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping",
    "expenses.view","expenses.manage","expenses.approve","expenses.post","suppliers.view","suppliers.manage",
    "banking.view","banking.manage","banking.reconcile","recurring_expenses.view","recurring_expenses.manage","refunds.manage",
    "rentals.view","rentals.manage","rentals.pay","rentals.post","rental_documents.view","rental_documents.manage",
  ],
  staff: [
    "employees.view","employees.manage","payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage",
  ],
  food: ["food.view","food.manage","food.billing","food.payments"],
  inventory: ["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"],
  reports: ["management.view","reports.view","reports.export","report_documents.view"],
};

export function AppNavigation({ permissions }: Props) {
  const can = (permission: string) => permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  const canFood = any(groups.food);
  const canInventory = any(groups.inventory);
  const canReports = any(groups.reports);
  const canAnalytics = can("analytics.view");

  const items = [
    { href: "/dashboard", label: "Home", show: can("dashboard.view") },
    { href: "/students", label: "Students", show: any(groups.students) },
    { href: "/money", label: "Money", show: any(groups.money) },
    { href: "/staff", label: "Staff", show: any(groups.staff) },
    { href: canFood ? "/food" : "/inventory", label: "Food", show: canFood || canInventory },
    { href: canReports ? "/reports" : "/analytics", label: "Reports", show: canReports || canAnalytics },
    { href: "/settings", label: "Settings", show: true },
  ].filter((item) => item.show);

  return (
    <div className="app-navigation-shell no-print">
      <nav className="app-navigation" aria-label="Main navigation">
        <Link className="app-brand" href={can("dashboard.view") ? "/dashboard" : "/settings"} aria-label="Montikids home">
          <span className="app-brand-mark">M</span>
          <span>Montikids</span>
        </Link>
        <div className="app-navigation-links">
          {items.map((item) => (
            <Link key={item.href} href={item.href}>{item.label}</Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
