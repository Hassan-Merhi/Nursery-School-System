import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function file(path) {
  return readFile(new URL("../" + path, import.meta.url), "utf8");
}

async function rolePermissions(name) {
  const result = await pool.query(
    `select r.name,r.is_system,
       coalesce(array_agg(rp.permission_key order by rp.permission_key)
         filter(where rp.permission_key is not null),'{}') permissions
     from role r left join role_permission rp on rp.role_id=r.id
     where lower(r.name)=lower($1)
     group by r.id`,
    [name],
  );
  assert.equal(result.rowCount, 1, `Missing role template: ${name}`);
  return result.rows[0];
}

function includesAll(actual, expected, label) {
  for (const permission of expected) {
    assert(actual.includes(permission), `${label} is missing ${permission}`);
  }
}

function excludesAll(actual, forbidden, label) {
  for (const permission of forbidden) {
    assert(!actual.includes(permission), `${label} must not include ${permission}`);
  }
}

try {
  const reception = await rolePermissions("Reception");
  const teacher = await rolePermissions("Teacher");
  const accounting = await rolePermissions("Accounting");
  const payroll = await rolePermissions("Payroll Manager");
  const food = await rolePermissions("Food Manager");

  assert.equal(reception.is_system, true);
  assert.equal(teacher.is_system, true);
  assert.equal(accounting.is_system, true);

  includesAll(reception.permissions, [
    "dashboard.view","families.manage","students.manage","enrollments.manage",
    "billing.view","payments.view","payments.manage",
  ], "Reception");
  excludesAll(reception.permissions, [
    "accounting.view","accounting.manage","expenses.manage","banking.manage",
    "payroll.view","payroll.manage","inventory.post",
  ], "Reception");

  includesAll(teacher.permissions, [
    "dashboard.view","students.view","classes.view","enrollments.view","student_history.view",
  ], "Teacher");
  excludesAll(teacher.permissions, [
    "families.manage","students.manage","enrollments.manage","billing.view","payments.view",
    "accounting.view","expenses.view","banking.view","payroll.view","food.view",
  ], "Teacher");

  includesAll(accounting.permissions, [
    "dashboard.view","billing.view","payments.manage","accounting.view","accounting.post",
    "accounting.mapping","expenses.manage","expenses.post","suppliers.manage",
    "banking.manage","banking.reconcile","reports.view",
  ], "Accounting");

  includesAll(payroll.permissions, [
    "dashboard.view","employees.view","employees.manage","payroll.view","payroll.manage",
    "payroll.approve","payroll.lock","payroll.pay","salary_advances.manage",
  ], "Payroll Manager");
  excludesAll(payroll.permissions, ["accounting.manage","expenses.manage","billing.manage"], "Payroll Manager");

  includesAll(food.permissions, [
    "dashboard.view","food.view","food.manage","inventory.view","inventory.purchase",
    "inventory.post","inventory.adjust",
  ], "Food Manager");

  const [
    navigation,
    dashboard,
    admissions,
    admissionAction,
    billing,
    familyHub,
    receipt,
    money,
    staff,
    foodPurchases,
    classroom,
    classroomDetail,
    studentDirectory,
  ] = await Promise.all([
    file("src/components/app-navigation.tsx"),
    file("src/app/dashboard/page.tsx"),
    file("src/app/students/admissions/page.tsx"),
    file("src/app/students/admissions/actions.ts"),
    file("src/app/billing/page.tsx"),
    file("src/app/students/families/[id]/page.tsx"),
    file("src/app/receipts/[id]/page.tsx"),
    file("src/app/money/page.tsx"),
    file("src/app/staff/page.tsx"),
    file("src/app/food/purchases/page.tsx"),
    file("src/app/classroom/page.tsx"),
    file("src/app/classroom/[id]/page.tsx"),
    file("src/app/students/page.tsx"),
  ]);

  assert(navigation.includes("deriveUiProfile"), "Main navigation must be permission-profile aware.");
  assert(navigation.includes('label: "Payments"') || navigation.includes('"Payments"'), "Reception payment navigation is missing.");
  assert(dashboard.includes("home-stat-grid") && dashboard.includes("View details"), "Simple dashboard overview cards are missing.");\n  assert(navigation.includes("mobile-navigation") && navigation.includes("mobile-menu-button"), "Mobile navigation menu is missing.");

  // Common task 1: enroll a child.
  assert(admissions.includes("Enroll a child"), "Guided enrollment page is missing.");
  assert(
    admissions.includes('guided-step-number">1') &&
    admissions.includes('guided-step-number">2') &&
    admissions.includes('guided-step-number">3'),
    "Enrollment steps are incomplete.",
  );
  assert(admissionAction.includes("guidedEnrollmentAction"), "Guided enrollment transaction is missing.");
  assert(studentDirectory.includes('href="/students/admissions"'), "Students page must expose guided enrollment.");

  // Common tasks 2, 3 and 7: tuition, receipt, outstanding balance.
  assert(billing.includes("Start with the family"), "Billing must start with family search.");
  assert(billing.includes("Total due"), "Billing family finder must show outstanding balance.");
  assert(familyHub.includes("Save payment & open receipt"), "Family payment must end at receipt.");
  assert(receipt.includes("PrintButton"), "Receipt must have a one-click print action.");

  // Common task 4: add expense.
  assert(money.includes("Record an expense"), "Money must expose the everyday expense task.");
  assert(money.includes('profile.kind === "reception"'), "Reception must not fall into generic Money controls.");

  // Common task 5: run payroll.
  assert(staff.includes("Continue payroll workflow"), "Staff must expose the current payroll continuation.");

  // Common task 6: buy food stock.
  for (const marker of ["Start a purchase","Build & place purchase orders","Receive deliveries","Post received stock"]) {
    assert(foodPurchases.includes(marker), `Food purchasing is missing step: ${marker}`);
  }

  // Teacher safety: classroom pages must not expose finance and old student hubs redirect teachers.
  const teacherSurface = classroom + classroomDetail;
  for (const forbidden of ["invoice_number","balance_amount","payment_account","accounting_mapping","salary_payable"]) {
    assert(!teacherSurface.includes(forbidden), `Teacher classroom surface leaked finance marker: ${forbidden}`);
  }
  assert(studentDirectory.includes('profile.kind === "teacher"'), "Teacher must be redirected away from full Students administration.");
  assert(familyHub.includes('profile.kind === "teacher"'), "Teacher must be blocked from family financial hub.");
  assert(classroom.includes('assigned.map((c)=>c.id)'), "Teacher roster must be scoped to assigned classes.");
  assert(classroomDetail.includes("student.lead_teacher") && classroomDetail.includes("auth.fullName"), "Teacher student detail must enforce lead-teacher assignment.");

  console.log("Phase 9–10 role and usability verification passed.");
} finally {
  await pool.end();
}
