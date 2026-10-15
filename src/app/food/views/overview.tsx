import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import type { ViewProps } from "@/components/hub";

type Row=Record<string,any>;
function money(value:unknown,currency="USD"){const n=Number(value??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number.isFinite(n)?n:0);}catch{return currency+" "+(Number.isFinite(n)?n:0).toFixed(2);}}

export async function FoodOverviewView({ auth }: ViewProps){
  const can=(p:string)=>auth.permissions.includes(p);
  const foodAccess=["food.view","food.manage","food.billing","food.payments"].some(can);
  const inventoryAccess=["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"].some(can);
  if(!foodAccess&&!inventoryAccess)redirect("/forbidden");

  const [kpiR,lowR,monthR]=await Promise.all([
    foodAccess?query<Row>(`select
      (select count(*)::int from student_food_selection where status='active') active_plans,
      (select count(*)::int from food_package where status='active') active_packages,
      (select count(*)::int from food_bill where status in ('issued','partially_paid')) open_bills,
      (select coalesce(sum(balance_amount),0)::numeric(14,2) from food_bill_balance where status in ('issued','partially_paid')) outstanding`)
      :Promise.resolve({rows:[{}] as Row[]}),
    inventoryAccess?query<Row>("select * from low_stock_alert order by quantity_on_hand-reorder_level,name"):Promise.resolve({rows:[] as Row[]}),
    inventoryAccess?query<Row>("select * from food_program_month_summary where month_start=date_trunc('month',current_date)::date order by currency"):Promise.resolve({rows:[] as Row[]}),
  ]);
  const kpi=kpiR.rows[0]??{},low=lowR.rows,month=monthR.rows;

  return <div className="hub-view food-workspace">
    <section className="money-summary-grid">
      {foodAccess?<article className="panel"><p className="eyebrow">Student plans</p><h2>{kpi.active_plans??0}</h2><p className="muted">Active food selections.</p></article>:null}
      {foodAccess?<article className="panel"><p className="eyebrow">Packages</p><h2>{kpi.active_packages??0}</h2><p className="muted">Active packages.</p></article>:null}
      {foodAccess?<article className="panel"><p className="eyebrow">Food bills due</p><h2>{money(kpi.outstanding)}</h2><p className="muted">{kpi.open_bills??0} open food bills.</p></article>:null}
      {inventoryAccess?<article className="panel"><p className="eyebrow">Low stock</p><h2>{low.length}</h2><p className="muted">Ingredients currently at or below reorder level.</p></article>:null}
    </section>

    {month.length?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">This month</p><h2>Food program snapshot</h2></div></div><div className="record-grid">{month.map((m)=><div key={m.currency}><small>{m.currency}</small><strong>{money(m.purchased_amount,m.currency)} purchased</strong><span className="muted">{money(m.food_income,m.currency)} income · {money(m.recognized_food_cost,m.currency)} cost</span></div>)}</div></section>:null}
    {low.length?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Needs attention</p><h2>Low stock now</h2></div>{can("inventory.purchase")?<Link className="button-link secondary-link" href="/food?view=purchases">Buy stock</Link>:null}</div><div className="money-list">{low.map((x)=><article className="money-list-row" key={x.ingredient_id}><div><strong>{x.code} · {x.name}</strong><small>{x.quantity_on_hand} {x.unit_code} on hand · reorder at {x.reorder_level}</small></div><span className="badge badge-warning">Low stock</span></article>)}</div></section>:null}
  </div>;
}
