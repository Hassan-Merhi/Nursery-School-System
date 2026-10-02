export type UiProfileKind =
  | "administrator"
  | "accounting"
  | "reception"
  | "teacher"
  | "payroll"
  | "food"
  | "staff";

export type UiProfile = {
  kind: UiProfileKind;
  label: string;
  homeTitle: string;
  homeDescription: string;
  studentHref: string;
  studentLabel: string;
  moneyHref: string;
  moneyLabel: string;
  settingsLabel: string;
};

export function deriveUiProfile(permissions: string[], roles: string[] = []): UiProfile {
  const can = (permission: string) => permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  const roleNames = roles.map((role) => role.toLowerCase());

  const administrator =
    roleNames.includes("administrator") ||
    any(["users.manage", "roles.manage", "school_profile.manage", "settings.manage"]);

  const accounting = any([
    "accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping",
    "banking.reconcile","expenses.post","discounts.approve","reports.export",
  ]);

  const reception =
    !administrator &&
    !accounting &&
    any(["families.manage","students.manage","enrollments.manage","payments.manage"]);

  const payroll =
    !administrator &&
    !accounting &&
    !reception &&
    any(["payroll.manage","payroll.approve","payroll.lock","payroll.pay","salary_advances.manage"]);

  const teacher =
    !administrator &&
    !accounting &&
    !reception &&
    !payroll &&
    any(["students.view","classes.view","enrollments.view"]);

  const food =
    !administrator &&
    !accounting &&
    !reception &&
    !payroll &&
    !teacher &&
    any(["food.view","food.manage","inventory.view","inventory.manage","inventory.purchase"]);

  if (administrator) {
    return {
      kind: "administrator",
      label: "Administrator",
      homeTitle: "What needs attention today?",
      homeDescription: "School-wide operations, finance and administration.",
      studentHref: "/students",
      studentLabel: "Students",
      moneyHref: "/money",
      moneyLabel: "Money",
      settingsLabel: "Settings",
    };
  }

  if (accounting) {
    return {
      kind: "accounting",
      label: "Accounting workspace",
      homeTitle: "Finance today",
      homeDescription: "Receivables, payables, cash, bank, expenses and accounting controls.",
      studentHref: "/students",
      studentLabel: "Students",
      moneyHref: "/money",
      moneyLabel: "Money",
      settingsLabel: any(["settings.view","settings.manage","roles.view","users.view"]) ? "Settings" : "Account",
    };
  }

  if (reception) {
    return {
      kind: "reception",
      label: "Reception workspace",
      homeTitle: "Front desk today",
      homeDescription: "Student, enrollment, family and payment tasks for the school day.",
      studentHref: "/students",
      studentLabel: "Students",
      moneyHref: "/billing",
      moneyLabel: "Payments",
      settingsLabel: "Account",
    };
  }

  if (payroll) {
    return {
      kind: "payroll",
      label: "Payroll workspace",
      homeTitle: "Staff & payroll today",
      homeDescription: "Employee, salary, advance and payroll tasks.",
      studentHref: "/students",
      studentLabel: "Students",
      moneyHref: "/money",
      moneyLabel: "Money",
      settingsLabel: "Account",
    };
  }

  if (teacher) {
    return {
      kind: "teacher",
      label: "Teacher workspace",
      homeTitle: "Classroom today",
      homeDescription: "Class rosters and student information without financial administration.",
      studentHref: "/classroom",
      studentLabel: "Classroom",
      moneyHref: "/money",
      moneyLabel: "Money",
      settingsLabel: "Account",
    };
  }

  if (food) {
    return {
      kind: "food",
      label: "Food workspace",
      homeTitle: "Food operations today",
      homeDescription: "Student food plans, purchases, stock and low-stock attention.",
      studentHref: "/students",
      studentLabel: "Students",
      moneyHref: "/money",
      moneyLabel: "Money",
      settingsLabel: "Account",
    };
  }

  return {
    kind: "staff",
    label: "Staff workspace",
    homeTitle: "Today",
    homeDescription: "The tasks and records available to your account.",
    studentHref: "/students",
    studentLabel: "Students",
    moneyHref: "/money",
    moneyLabel: "Money",
    settingsLabel: "Account",
  };
}
