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
import { FoodOverviewView } from "./views/overview";
import { FoodPlansView } from "./views/plans";
import { FoodPackagesView } from "./views/packages";
import { FoodPurchasesView } from "./views/purchases";
import { InventoryView } from "./views/inventory";

const DESCRIPTIONS: Record<string, string> = {
  overview: "Student plans, packages, food bills due and low stock at a glance.",
  plans: "Which child is on which food package.",
  packages: "Food items, prices, packages, food bills and food payments.",
  purchases: "Buy food stock: create the order, receive the delivery and post it.",
  inventory: "Ingredients, stock on hand, receipts, usage, waste and inventory accounting.",
};

export default async function FoodPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const auth = await requireUser();
  const params = flattenParams(await searchParams);
  const can = (permission: string) => auth.permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  const foodAccess = any(["food.view","food.manage","food.billing","food.payments"]);
  const inventoryAccess = any(["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"]);

  const views: HubView[] = [
    { key: "overview", label: "Overview", show: foodAccess || inventoryAccess },
    { key: "plans", label: "Student plans", show: any(["food.view","food.manage"]) },
    { key: "packages", label: "Packages & billing", show: foodAccess },
    { key: "purchases", label: "Purchases", show: any(["inventory.view","inventory.purchase","inventory.post","inventory.manage"]) },
    { key: "inventory", label: "Inventory", show: inventoryAccess },
  ].filter((view) => view.show);

  if (!views.length) redirect("/forbidden");
  const view = pickView(views, params.view);

  return (
    <main className="app-shell hub-shell">
      <HubHeader eyebrow="Food" title="Food" description={DESCRIPTIONS[view.key]} />
      <ViewSwitcher base="/food" views={views} active={view.key} label="Food sections" />
      <Notices error={params.error} success={params.success} />

      {view.key === "overview" ? <FoodOverviewView auth={auth} params={params} /> : null}
      {view.key === "plans" ? <FoodPlansView auth={auth} params={params} /> : null}
      {view.key === "packages" ? <FoodPackagesView auth={auth} params={params} /> : null}
      {view.key === "purchases" ? <FoodPurchasesView auth={auth} params={params} /> : null}
      {view.key === "inventory" ? <InventoryView auth={auth} params={params} /> : null}
    </main>
  );
}
