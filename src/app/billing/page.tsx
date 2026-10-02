import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";

type Row = Record<string, any>;
type MoneyValue = [string, number];

function money(value: unknown, currency = "USD") {
  const amount = Number(value ?? 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${currency} ${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
  }
}

function groupMoney(rows: Row[], field: string) {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const familyId = String(row.family_id);
    const currency = String(row.currency ?? "USD");
    const map = grouped.get(familyId) ?? new Map<string, number>();
    map.set(currency, (map.get(currency) ?? 0) + Number(row[field] ?? 0));
    grouped.set(familyId, map);
  }
  return grouped;
}

function valuesFor(map: Map<string, Map<string, number>>, familyId: string): MoneyValue[] {
  return [...(map.get(familyId)?.entries() ?? [])]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

function mergeValues(...sets: MoneyValue[][]): MoneyValue[] {
  const map = new Map<string, number>();
  for (const set of sets) {
    for (const [currency, amount] of set) map.set(currency, (map.get(currency) ?? 0) + amount);
  }
  return [...map.entries()].filter(([, amount]) => amount !== 0).sort(([a], [b]) => a.localeCompare(b));
}

function MoneyStack({ values }: { values: MoneyValue[] }) {
  if (!values.length) return <span>—</span>;
  return <span className="money-stack">{values.map(([currency, amount]) => <span key={currency}>{money(amount, currency)}</span>)}</span>;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const auth = await requireUser();
  const params = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  const canFamilyWorkflow = ["billing.view","billing.manage","payments.view","payments.manage"].some(can);
  const canAdvanced = ["billing.manage","discounts.view","discounts.manage","discounts.approve"].some(can);
  const canFoodBalance = ["food.view","food.manage","food.billing","food.payments"].some(can);
  if (!canFamilyWorkflow) {
    if (canAdvanced) redirect("/billing/admin");
    redirect("/forbidden");
  }

  const q = String(params.q ?? "").trim();
  const families = (
    await query<Row>(
      `select f.id,f.family_number,f.display_name,f.home_phone,
         count(s.id)::int student_count,
         count(s.id) filter (where s.status='active')::int active_student_count,
         (select concat_ws(' ',g.first_name,g.last_name)
            from family_guardian fg join guardian g on g.id=fg.guardian_id
            where fg.family_id=f.id order by fg.is_primary desc,g.last_name,g.first_name limit 1) primary_guardian,
         (select g.phone
            from family_guardian fg join guardian g on g.id=fg.guardian_id
            where fg.family_id=f.id order by fg.is_primary desc,g.last_name,g.first_name limit 1) primary_phone
       from family f
       left join student s on s.family_id=f.id
       where ($1='' or f.display_name ilike '%'||$1||'%' or f.family_number ilike '%'||$1||'%'
         or exists (
           select 1 from student sx
           where sx.family_id=f.id
             and (sx.student_number ilike '%'||$1||'%' or concat_ws(' ',sx.first_name,sx.last_name) ilike '%'||$1||'%')
         ))
       group by f.id
       order by f.display_name,f.family_number
       limit 100`,
      [q],
    )
  ).rows;

  const ids = families.map((family) => family.id);
  const [tuitionRows, foodRows, fundsRows] = ids.length ? await Promise.all([
    query<Row>(
      `select i.family_id,i.currency,sum(b.balance_amount)::numeric(14,2) amount
       from invoice i join invoice_balance b on b.id=i.id
       where i.family_id=any($1::uuid[]) and i.status in ('issued','partially_paid') and b.balance_amount>0
       group by i.family_id,i.currency`,
      [ids],
    ),
    canFoodBalance ? query<Row>(
      `select b.family_id,b.currency,sum(b.balance_amount)::numeric(14,2) amount
       from food_bill_balance b
       where b.family_id=any($1::uuid[]) and b.status in ('issued','partially_paid') and b.balance_amount>0
       group by b.family_id,b.currency`,
      [ids],
    ) : Promise.resolve({ rows: [] as Row[] }),
    query<Row>(
      `select p.family_id,p.currency,sum(p.unallocated_amount)::numeric(14,2) amount
       from payment_balance p
       where p.family_id=any($1::uuid[]) and p.status='posted' and p.unallocated_amount>0
       group by p.family_id,p.currency`,
      [ids],
    ),
  ]) : [{ rows: [] as Row[] }, { rows: [] as Row[] }, { rows: [] as Row[] }];

  const tuition = groupMoney(tuitionRows.rows, "amount");
  const food = groupMoney(foodRows.rows, "amount");
  const funds = groupMoney(fundsRows.rows, "amount");

  return (
    <main className="app-shell billing-simple-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Fees & payments</p>
          <h1>Start with the family</h1>
          <p className="muted">Find the family, review what they owe, record the payment, choose cash or bank, save, then issue the receipt. Allocations and accounting stay in the background.</p>
        </div>
        {canAdvanced ? <Link className="button-link secondary-link" href="/billing/admin">Advanced billing</Link> : null}
      </header>

      <section className="panel billing-family-finder">
        <form method="get" action="/billing" className="billing-search-form">
          <label>
            Find family or student
            <input name="q" defaultValue={q} placeholder="Family name, family number, student name or student number" autoFocus />
          </label>
          <button type="submit">Find family</button>
          {q ? <Link className="button-link secondary-link" href="/billing">Clear</Link> : null}
        </form>
      </section>

      <section className="billing-family-results">
        {families.map((family) => {
          const tuitionDue = valuesFor(tuition, family.id);
          const foodDue = valuesFor(food, family.id);
          const totalDue = mergeValues(tuitionDue, foodDue);
          const available = valuesFor(funds, family.id);
          return (
            <article className="family-payment-card" key={family.id}>
              <div className="family-payment-card-main">
                <div>
                  <p className="eyebrow">{family.family_number}</p>
                  <h2>{family.display_name}</h2>
                  <p className="muted">{family.primary_guardian ?? "No guardian"}{family.primary_phone ? ` · ${family.primary_phone}` : ""}</p>
                  <p className="muted">{family.student_count} child{Number(family.student_count) === 1 ? "" : "ren"} · {family.active_student_count} active</p>
                </div>
                <div className="family-payment-balance">
                  <small>Total due</small>
                  <strong><MoneyStack values={totalDue}/></strong>
                  {foodDue.length ? <span>Includes food: <MoneyStack values={foodDue}/></span> : null}
                  {available.length ? <span>Available credit: <MoneyStack values={available}/></span> : null}
                </div>
              </div>
              <Link className="button-link family-payment-open" href={`/students/families/${family.id}#billing`}>
                View balance & record payment
              </Link>
            </article>
          );
        })}
        {!families.length ? <section className="panel"><h2>No matching family</h2><p className="muted">Try a family name, family number, student name, or student number.</p></section> : null}
      </section>
    </main>
  );
}
