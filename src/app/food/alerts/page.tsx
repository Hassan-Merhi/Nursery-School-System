import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
type Row=Record<string,any>;
function qty(v:unknown){return Number(v??0).toLocaleString("en-US",{maximumFractionDigits:3});}
export default async function FoodAlertsPage(){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"].some(can))redirect("/forbidden");
 const rows=(await query<Row>("select * from low_stock_alert order by quantity_on_hand-reorder_level,name")).rows;
 return <main className="app-shell food-workspace"><header className="topbar"><div><p className="eyebrow">Food · Alerts</p><h1>Low-stock alerts</h1><p className="muted">Only ingredients that need attention. No accounting or movement history unless you open Advanced inventory.</p></div>{can("inventory.purchase")?<Link className="button-link" href="/food/purchases">Open purchases</Link>:null}</header><FoodNavigation/>
 {rows.length?<section className="low-stock-grid">{rows.map(r=><article className="low-stock-card" key={r.ingredient_id}><div className="row-between"><div><p className="eyebrow">{r.code}</p><h2>{r.name}</h2></div><span className="badge badge-warning">Low</span></div><div className="stock-meter"><span style={{width:`${Math.max(0,Math.min(100,Number(r.reorder_level)>0?Number(r.quantity_on_hand)/Number(r.reorder_level)*100:0))}%`}}/></div><p><strong>{qty(r.quantity_on_hand)} {r.unit_code}</strong> on hand</p><p className="muted">Reorder level: {qty(r.reorder_level)} {r.unit_code}</p></article>)}</section>:<section className="panel empty-state success-empty"><strong>No low-stock alerts</strong><span>All active ingredients are currently above their reorder levels.</span></section>}
 </main>;
}