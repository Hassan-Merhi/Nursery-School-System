export type IconName =
  | "home" | "users" | "receipt" | "food" | "box" | "wallet" | "building"
  | "briefcase" | "book" | "chart" | "trend" | "bell" | "settings";

export type NavItem = {
  href: string;
  label: string;
  hint: string;
  icon: IconName;
  permissions: string[];
};

export type NavGroup = { label: string; items: NavItem[] };

// Single source of truth for the app's navigation. Items are hidden when the
// signed-in user holds none of the listed permissions (empty = everyone).
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Daily work",
    items: [
      { href: "/dashboard", label: "Home", hint: "Today at a glance", icon: "home", permissions: [] },
      { href: "/students", label: "Students & families", hint: "Children, parents, classes", icon: "users", permissions: ["families.view","families.manage","students.view","students.manage","classes.view","classes.manage","enrollments.view","enrollments.manage","student_documents.view","student_documents.manage","student_history.view"] },
      { href: "/billing", label: "Fees & payments", hint: "Invoices, discounts, receipts", icon: "receipt", permissions: ["billing.view","billing.manage","discounts.view","discounts.manage","discounts.approve","payments.view","payments.manage"] },
      { href: "/food", label: "Food", hint: "Meal plans and food bills", icon: "food", permissions: ["food.view","food.manage","food.billing","food.payments"] },
      { href: "/notifications", label: "Alerts", hint: "Things that need attention", icon: "bell", permissions: ["notifications.view","notifications.manage","notifications.run"] },
    ],
  },
  {
    label: "Money & staff",
    items: [
      { href: "/operations", label: "Expenses & bank", hint: "Suppliers, expenses, cash", icon: "wallet", permissions: ["expenses.view","expenses.manage","expenses.approve","expenses.post","suppliers.view","suppliers.manage","banking.view","banking.manage","banking.reconcile","recurring_expenses.view","recurring_expenses.manage","refunds.manage"] },
      { href: "/payroll", label: "Staff & payroll", hint: "Employees, salaries, payslips", icon: "briefcase", permissions: ["employees.view","employees.manage","payroll.view","payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage"] },
      { href: "/inventory", label: "Kitchen stock", hint: "Ingredients and purchases", icon: "box", permissions: ["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"] },
      { href: "/rentals", label: "Rentals", hint: "Rent agreements and payments", icon: "building", permissions: ["rentals.view","rentals.manage","rentals.pay","rentals.post","rental_documents.view","rental_documents.manage"] },
      { href: "/accounting", label: "Accounting", hint: "Ledger and journals", icon: "book", permissions: ["accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping"] },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/reports", label: "Reports", hint: "Statements and exports", icon: "chart", permissions: ["management.view","reports.view","reports.export","report_documents.view"] },
      { href: "/analytics", label: "Trends", hint: "Charts over time", icon: "trend", permissions: ["analytics.view"] },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/settings", label: "Settings", hint: "School, users, your password", icon: "settings", permissions: [] },
    ],
  },
];

export function canSee(item: NavItem, permissions: string[]) {
  return item.permissions.length === 0 || item.permissions.some((p) => permissions.includes(p));
}

export function visibleNav(permissions: string[]): NavGroup[] {
  return NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => canSee(item, permissions)) }))
    .filter((group) => group.items.length > 0);
}
