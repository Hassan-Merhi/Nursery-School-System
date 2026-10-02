import { redirect } from "next/navigation";
import { requireUser } from "@/lib/security";

const sections = [
  {
    href: "/billing",
    title: "Fees & billing",
    description: "Tuition schedules, invoices, discounts, parent payments, credits and receipts.",
    permissions: ["billing.view","billing.manage","discounts.view","discounts.manage","discounts.approve","payments.view","payments.manage"],
  },
  {
    href: "/accounting",
    title: "Accounting",
    description: "Chart of accounts, journals, posting, periods, opening balances and mappings.",
    permissions: ["accounting.view","accounting.manage","accounting.post","accounting.period_lock","accounting.mapping"],
  },
  {
    href: "/operations",
    title: "Expenses, suppliers & banking",
    description: "Expenses, suppliers, payables, cash and bank accounts, transfers and reconciliation.",
    permissions: ["expenses.view","expenses.manage","expenses.approve","expenses.post","suppliers.view","suppliers.manage","banking.view","banking.manage","banking.reconcile","recurring_expenses.view","recurring_expenses.manage","refunds.manage"],
  },
  {
    href: "/rentals",
    title: "Rentals",
    description: "Landlords, agreements, rent schedules, deposits, payments, prepaid rent and rent payable.",
    permissions: ["rentals.view","rentals.manage","rentals.pay","rentals.post","rental_documents.view","rental_documents.manage","accounting.mapping"],
  },
];

export default async function MoneyPage() {
  const auth = await requireUser();
  const can = (permission: string) => auth.permissions.includes(permission);
  const visible = sections.filter((section) => section.permissions.some(can));
  if (!visible.length) redirect("/forbidden");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Money</p>
          <h1>Financial operations</h1>
          <p className="muted">Choose the area you need. Detailed accounting pages stay one level below the main menu.</p>
        </div>
      </header>

      <section className="section-card-grid">
        {visible.map((section) => (
          <a className="section-card" href={section.href} key={section.href}>
            <div>
              <p className="eyebrow">Money</p>
              <h2>{section.title}</h2>
              <p className="muted">{section.description}</p>
            </div>
            <span className="section-card-action">Open →</span>
          </a>
        ))}
      </section>
    </main>
  );
}
