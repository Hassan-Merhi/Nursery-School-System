import { redirect } from "next/navigation";
import { requireUser } from "@/lib/security";
import {
  HubHeader,
  Notices,
  ViewSwitcher,
  flattenParams,
  pickView,
  type HubView,
  type SearchParams,
} from "@/components/hub";
import { EmployeesView } from "./views/employees";
import { PayrollView } from "./views/payroll";

const PEOPLE_PERMISSIONS = [
  "employees.view","employees.manage","payroll.view","payroll.manage",
  "payroll.approve","payroll.lock","payroll.pay","salary_advances.manage",
];

export default async function StaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const auth = await requireUser();
  const params = flattenParams(await searchParams);
  const can = (permission: string) => auth.permissions.includes(permission);
  const any = (items: string[]) => items.some(can);

  const views: HubView[] = [
    { key: "employees", label: "Employees", show: any(PEOPLE_PERMISSIONS) },
    { key: "payroll", label: "Payroll", show: any(PEOPLE_PERMISSIONS) || can("accounting.mapping") },
  ].filter((view) => view.show);

  if (!views.length) redirect("/forbidden");
  const view = pickView(views, params.view);

  return (
    <main className="app-shell hub-shell">
      <HubHeader
        eyebrow="Staff"
        title="Staff"
        description={view.key === "payroll"
          ? "Payroll runs, approvals, locking, payment, salary advances and payroll accounting setup."
          : "Employees, salaries, advances and the current payroll at a glance. Open an employee for details."}
      />
      <ViewSwitcher base="/staff" views={views} active={view.key} label="Staff sections" />
      <Notices error={params.error} success={params.success} />

      {view.key === "employees" ? <EmployeesView auth={auth} params={params} /> : null}
      {view.key === "payroll" ? <PayrollView auth={auth} params={params} /> : null}
    </main>
  );
}
