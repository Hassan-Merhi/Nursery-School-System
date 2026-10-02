import Link from "next/link";
import { deriveUiProfile } from "@/lib/ui-profile";
import { ThemeToggle } from "@/components/theme-toggle";

type Props = {
  permissions: string[];
  roles?: string[];
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

export function AppNavigation({ permissions, roles = [] }: Props) {
  const can = (permission: string) => permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  const profile = deriveUiProfile(permissions, roles);
  const canFood = any(groups.food);
  const canInventory = any(groups.inventory);
  const canReports = any(groups.reports);
  const canAnalytics = can("analytics.view");
  const canStaffOperations = any([
    "employees.view","employees.manage","payroll.manage","payroll.approve",
    "payroll.lock","payroll.pay","salary_advances.manage",
  ]);
  const canSettings = any([
    "school_profile.view","school_profile.manage","school_years.view","school_years.manage",
    "users.view","users.manage","roles.view","roles.manage","settings.view","settings.manage",
    "documents.view","documents.manage","audit.view",
  ]);

  const teacherMode = profile.kind === "teacher";
  const receptionMode = profile.kind === "reception";

  const items = [
    { href: "/dashboard", label: "Home", show: can("dashboard.view") },
    { href: profile.studentHref, label: profile.studentLabel, show: any(groups.students) },
    {
      href: receptionMode ? "/billing" : profile.moneyHref,
      label: receptionMode ? "Payments" : profile.moneyLabel,
      show: !teacherMode && any(groups.money),
    },
    { href: "/staff", label: "Staff", show: !teacherMode && canStaffOperations },
    { href: "/food", label: "Food", show: !teacherMode && !receptionMode && (canFood || canInventory) },
    { href: canReports ? "/reports" : "/analytics", label: "Reports", show: !teacherMode && (canReports || canAnalytics) },
    { href: "/settings", label: canSettings ? "Settings" : "Account", show: true },
  ].filter((item) => item.show);

  return (
    <div className="app-navigation-shell no-print">
      <nav className="app-navigation" aria-label="Main navigation">
        <div className="app-brand-group">
          <Link className="app-brand" href={can("dashboard.view") ? "/dashboard" : items[0]?.href ?? "/settings"} aria-label="Montikids home">
            <span className="app-brand-mark">M</span>
            <span>Montikids</span>
          </Link>
          <span className="app-role-pill">{profile.label}</span>
        </div>
        <div className="app-navigation-actions">
          <div className="app-navigation-links">
            {items.map((item) => (
              <Link key={item.href} href={item.href}>{item.label}</Link>
            ))}
          </div>
          <ThemeToggle />
        </div>
      </nav>
    </div>
  );
}
