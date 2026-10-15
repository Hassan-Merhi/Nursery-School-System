import { redirect } from "next/navigation";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";
import {
  HubHeader,
  Notices,
  ViewSwitcher,
  flattenParams,
  pickView,
  type HubView,
  type SearchParams,
} from "@/components/hub";
import { MoneyOverviewView } from "./views/overview";
import { PaymentsView } from "./views/payments";
import { FeesView } from "./views/fees";
import { SuppliersView } from "./views/suppliers";
import { RentView } from "./views/rent";
import { AccountingView } from "./views/accounting";

const DESCRIPTIONS: Record<string, string> = {
  overview: "Today's expenses, supplier bills, cash, bank and rent in one place.",
  payments: "Find the family, see what they owe, record the payment and print the receipt.",
  fees: "Term fee schedules, discounts, invoices, credit notes and family ledgers.",
  suppliers: "Expense approvals, supplier bills, bank accounts, refunds, recurring costs and reconciliation.",
  rent: "Landlords, rental agreements, rent schedules, payments and month-end recognition.",
  accounting: "Chart of accounts, periods, journals, ledger, trial balance and financial position.",
};

export default async function MoneyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const auth = await requireUser();
  const params = flattenParams(await searchParams);
  const profile = deriveUiProfile(auth.permissions, auth.roles);
  const can = (permission: string) => auth.permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  // Reception stays inside the simple family payment workflow only.
  const reception = profile.kind === "reception";

  const views: HubView[] = [
    {
      key: "overview",
      label: "Overview",
      show: !reception && any([
        "expenses.view","expenses.manage","expenses.approve","expenses.post",
        "suppliers.view","suppliers.manage","banking.view","banking.manage","banking.reconcile",
        "recurring_expenses.view","recurring_expenses.manage","refunds.manage",
        "rentals.view","rentals.manage","rentals.pay","rentals.post",
        "accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping",
      ]),
    },
    { key: "payments", label: "Payments", show: any(["billing.view","billing.manage","payments.view","payments.manage"]) },
    { key: "fees", label: "Fees & invoices", show: any(["billing.manage","discounts.view","discounts.manage","discounts.approve"]) },
    {
      key: "suppliers",
      label: "Expenses & suppliers",
      show: !reception && any([
        "expenses.view","expenses.manage","expenses.approve","expenses.post","suppliers.view","suppliers.manage",
        "banking.view","banking.manage","banking.reconcile","recurring_expenses.view","recurring_expenses.manage","refunds.manage",
      ]),
    },
    {
      key: "rent",
      label: "Rent",
      show: !reception && any(["rentals.view","rentals.manage","rentals.pay","rentals.post","rental_documents.view","rental_documents.manage","accounting.mapping"]),
    },
    {
      key: "accounting",
      label: "Accounting",
      show: !reception && any(["accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping"]),
    },
  ].filter((view) => view.show);

  if (!views.length) redirect("/forbidden");
  const view = pickView(views, params.view);

  return (
    <main className="app-shell hub-shell">
      <HubHeader
        eyebrow="Money"
        title={reception ? "Payments" : "Money"}
        description={DESCRIPTIONS[view.key]}
      />
      <ViewSwitcher base="/money" views={views} active={view.key} label="Money sections" />
      <Notices error={params.error} success={params.success} />

      {view.key === "overview" ? <MoneyOverviewView auth={auth} params={params} /> : null}
      {view.key === "payments" ? <PaymentsView auth={auth} params={params} /> : null}
      {view.key === "fees" ? <FeesView auth={auth} params={params} /> : null}
      {view.key === "suppliers" ? <SuppliersView auth={auth} params={params} /> : null}
      {view.key === "rent" ? <RentView auth={auth} params={params} /> : null}
      {view.key === "accounting" ? <AccountingView auth={auth} params={params} /> : null}
    </main>
  );
}
