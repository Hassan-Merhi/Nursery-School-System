import Link from "next/link";

export function FoodNavigation() {
  return (
    <nav className="food-subnav no-print" aria-label="Food sections">
      <Link href="/food">Overview</Link>
      <Link href="/food/plans">Student plans</Link>
      <Link href="/food/packages">Packages</Link>
      <Link href="/food/purchases">Purchases</Link>
      <Link href="/food/inventory">Inventory</Link>
      <Link href="/food/alerts">Low-stock alerts</Link>
    </nav>
  );
}
