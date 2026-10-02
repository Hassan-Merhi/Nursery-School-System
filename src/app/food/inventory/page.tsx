import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
type Row=Record<string,any>;
function money(v:unknown,c="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:c,minimumFractionDigits:2}).format(n);}catch{return c+" "+n.toFixed(2);}}
function qty(v:unknown){return Number(v??0).toLocaleString("en-US",{maximumFractionDigits:3});}
export default async function FoodInventoryPage(){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"].some(can))redirect("/forbidden");
 const rows=(await query<Row>("select b.*,i.notes from ingredient_inventory_balance b join ingredient i on i.id=b.ingredient_id order by b.low_stock desc,b.status,b.name")).rows;
 const active=rows.filter(r=>r.status==="active"),low=active.filter(r=>r.low_stock),valuation=active.reduce((s,r)=>s+Number(r.inventory_value??0),0);
 const currency=active.find(r=>r.currency)?.currency??"USD";
 return <main className="app-shell food-workspace"><header className="topbar"><div><p className="eyebrow">Food · Inventory</p><h1>Inventory</h1><p className="muted">What is on hand, what it is worth, and which ingredients are running low.</p></div>{["inventory.manage","inventory.adjust","inventory.post"].some(can)?<Link className="button-link secondary-link" href="/inventory">Advanced inventory</Link>:null}</header><FoodNavigation/>
 <section className="money-summary-grid"><article className="panel"><p className="eyebrow">Ingredients</p><h2>{active.length}</h2><p className="muted">Active stock items.</p></article><article className="panel"><p className="eyebrow">Stock value</p><h2>{money(valuation,currency)}</h2><p className="muted">Moving-average inventory valuation.</p></article><article className="panel"><p className="eyebrow">Low stock</p><h2>{low.length}</h2><p className="muted">At or below reorder level.</p></article></section>
 <section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Stock on hand</p><h2>Ingredients</h2></div><Link className="button-link secondary-link" href="/food/alerts">Only low stock</Link></div><div className="responsive-card-table"><table><thead><tr><th>Ingredient</th><th>On hand</th><th>Reorder at</th><th>Average cost</th><th>Value</th><th>Status</th></tr></thead><tbody>{active.map(r=><tr key={r.ingredient_id}><td data-label="Ingredient"><strong>{r.code} · {r.name}</strong></td><td data-label="On hand">{qty(r.quantity_on_hand)} {r.unit_code}</td><td data-label="Reorder at">{qty(r.reorder_level)} {r.unit_code}</td><td data-label="Average cost">{money(r.average_unit_cost,r.currency)}</td><td data-label="Value">{money(r.inventory_value,r.currency)}</td><td data-label="Status">{r.low_stock?<span className="badge badge-warning">Low stock</span>:<span className="badge badge-success">OK</span>}</td></tr>)}{!active.length?<tr><td colSpan={6}><div className="empty-state"><strong>No inventory items</strong><span>Add ingredients from Advanced inventory.</span></div></td></tr>:null}</tbody></table></div></section></main>;
}