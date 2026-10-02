import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
type Row=Record<string,any>;
function iso(v:unknown){return String(v??"").slice(0,10);}
function money(v:unknown,c="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:c,minimumFractionDigits:2}).format(n);}catch{return c+" "+n.toFixed(2);}}
export default async function FoodPurchasesPage(){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["inventory.view","inventory.purchase","inventory.post","inventory.manage"].some(can))redirect("/forbidden");
 const [ordersR,receiptsR]=(await Promise.all([
  query<Row>("select * from food_purchase_order_summary order by created_at desc limit 80"),
  query<Row>("select * from inventory_receipt_summary order by created_at desc limit 80"),
 ]));
 const orders=ordersR.rows,receipts=receiptsR.rows,open=orders.filter(o=>["draft","ordered","partially_received"].includes(o.status));
 return <main className="app-shell food-workspace"><header className="topbar"><div><p className="eyebrow">Food · Purchasing</p><h1>Food purchases</h1><p className="muted">Purchase orders and received stock without inventory-accounting setup on the screen.</p></div>{can("inventory.purchase")?<Link className="button-link secondary-link" href="/inventory">Create / receive purchase</Link>:null}</header><FoodNavigation/>
 <section className="money-summary-grid"><article className="panel"><p className="eyebrow">Open orders</p><h2>{open.length}</h2><p className="muted">Draft, ordered or partially received.</p></article><article className="panel"><p className="eyebrow">Recent receipts</p><h2>{receipts.length}</h2><p className="muted">Latest stock receiving records.</p></article></section>
 <section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Orders</p><h2>Purchase orders</h2></div></div><div className="responsive-card-table"><table><thead><tr><th>Order</th><th>Supplier</th><th>Ordered</th><th>Expected</th><th>Total</th><th>Received</th><th>Status</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td data-label="Order"><strong>{o.order_number}</strong></td><td data-label="Supplier">{o.supplier_name}</td><td data-label="Ordered">{iso(o.ordered_on)}</td><td data-label="Expected">{o.expected_on?iso(o.expected_on):"—"}</td><td data-label="Total">{money(o.total_amount,o.currency)}</td><td data-label="Received">{money(o.received_amount,o.currency)}</td><td data-label="Status"><span className="badge">{o.status}</span></td></tr>)}{!orders.length?<tr><td colSpan={7}><div className="empty-state"><strong>No purchase orders</strong><span>Create one from Advanced inventory.</span></div></td></tr>:null}</tbody></table></div></section>
 <section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Receiving</p><h2>Recent stock receipts</h2></div></div><div className="money-list">{receipts.slice(0,20).map(r=><article className="money-list-row" key={r.id}><div><strong>{r.receipt_number} · {r.supplier_name}</strong><small>{iso(r.received_on)}{r.order_number?` · ${r.order_number}`:""}</small></div><div><strong>{money(r.total_amount,r.currency)}</strong><span className="badge">{r.status}</span></div></article>)}{!receipts.length?<div className="empty-state"><strong>No stock receipts</strong><span>Received purchases will appear here.</span></div>:null}</div></section></main>;
}