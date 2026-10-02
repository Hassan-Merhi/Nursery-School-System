import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
import {
  quickAddPurchaseLineAction,
  quickCreatePurchaseOrderAction,
  quickCreateReceiptFromOrderAction,
  quickPlacePurchaseOrderAction,
  quickPostReceiptAction,
} from "./actions";

type Row=Record<string,any>;
function iso(v:unknown){return String(v??"").slice(0,10);}
function money(v:unknown,c="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:c,minimumFractionDigits:2}).format(n);}catch{return c+" "+n.toFixed(2);}}
function qty(v:unknown){return Number(v??0).toLocaleString("en-US",{maximumFractionDigits:3});}

export default async function FoodPurchasesPage({
  searchParams,
}:{
  searchParams:Promise<{error?:string;success?:string}>;
}){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["inventory.view","inventory.purchase","inventory.post","inventory.manage"].some(can))redirect("/forbidden");
 const {error,success}=await searchParams;
 const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today??new Date().toISOString().slice(0,10);
 const currency=(await query<{currency:string|null}>("select value #>> '{}' currency from app_setting where key='currency'")).rows[0]?.currency??"USD";
 const [ordersR,receiptsR,suppliersR,ingredientsR,linesR]=await Promise.all([
  query<Row>("select * from food_purchase_order_summary order by created_at desc limit 80"),
  query<Row>("select * from inventory_receipt_summary order by created_at desc limit 80"),
  can("inventory.purchase")?query<Row>("select id,supplier_number,name from supplier where status='active' order by name"):Promise.resolve({rows:[] as Row[]}),
  can("inventory.purchase")?query<Row>("select b.ingredient_id,b.code,b.name,b.unit_code,b.quantity_on_hand,b.average_unit_cost,b.currency from ingredient_inventory_balance b where b.status='active' order by b.name"):Promise.resolve({rows:[] as Row[]}),
  query<Row>("select * from food_purchase_order_line_progress order by ingredient_name"),
 ]);
 const orders=ordersR.rows,receipts=receiptsR.rows,suppliers=suppliersR.rows,ingredients=ingredientsR.rows,lines=linesR.rows;
 const open=orders.filter(o=>["draft","ordered","partially_received"].includes(o.status));
 const drafts=orders.filter(o=>o.status==="draft");
 const receiving=orders.filter(o=>["ordered","partially_received"].includes(o.status)&&Number(o.outstanding_amount??0)>0);
 const draftReceipts=receipts.filter(r=>r.status==="draft");
 return <main className="app-shell food-workspace">
  <header className="topbar"><div><p className="eyebrow">Food · Purchasing</p><h1>Buy food stock</h1><p className="muted">Create the purchase, add ingredients, place the order, receive the delivery, and post stock from one page.</p></div><Link className="button-link secondary-link" href="/inventory">Advanced inventory</Link></header>
  <FoodNavigation/>
  {error?<div className="notice error">{error}</div>:null}{success?<div className="notice success">{success}</div>:null}

  <section className="money-summary-grid">
   <article className="panel"><p className="eyebrow">Open orders</p><h2>{open.length}</h2><p className="muted">Draft, ordered or partially received.</p></article>
   <article className="panel"><p className="eyebrow">Awaiting delivery</p><h2>{receiving.length}</h2><p className="muted">Orders with stock still outstanding.</p></article>
   <article className="panel"><p className="eyebrow">Draft receipts</p><h2>{draftReceipts.length}</h2><p className="muted">Captured deliveries waiting to post.</p></article>
  </section>

  {can("inventory.purchase")?<section className="panel section-block">
   <div className="section-heading"><div><p className="eyebrow">Step 1</p><h2>Start a purchase</h2><p className="muted">Choose the supplier and expected delivery date. Add items after the draft is created.</p></div></div>
   <form action={quickCreatePurchaseOrderAction} className="simple-money-form">
    <label>Supplier<select name="supplier_id" defaultValue="" required><option value="" disabled>Select supplier</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.supplier_number} · {s.name}</option>)}</select></label>
    <label>Order date<input name="ordered_on" type="date" defaultValue={today} required/></label>
    <label>Expected delivery<input name="expected_on" type="date" min={today}/></label>
    <label>Currency<input name="currency" defaultValue={currency} maxLength={3} required/></label>
    <label className="span-2">Notes<input name="notes" placeholder="Optional supplier or delivery note"/></label>
    <button type="submit">Create purchase</button>
   </form>
  </section>:null}

  <section className="panel section-block">
   <div className="section-heading"><div><p className="eyebrow">Step 2</p><h2>Build & place purchase orders</h2></div></div>
   <div className="card-list">
    {drafts.map(o=>{const orderLines=lines.filter(l=>l.purchase_order_id===o.id);return <article className="subcard purchase-task-card" id={"order-"+o.id} key={o.id}>
     <div className="row-between"><div><strong>{o.order_number} · {o.supplier_name}</strong><div className="muted">Created {iso(o.ordered_on)}{o.expected_on?` · expected ${iso(o.expected_on)}`:""}</div></div><span className="badge">{o.status}</span></div>
     {orderLines.length?<div className="purchase-line-list">{orderLines.map(l=><div key={l.purchase_order_line_id}><span>{l.ingredient_name}</span><strong>{qty(l.quantity_ordered)} {l.unit_code} × {money(l.unit_cost,o.currency)} = {money(l.line_amount,o.currency)}</strong></div>)}</div>:<div className="empty-state compact-empty"><strong>No ingredients yet</strong><span>Add at least one ingredient before placing the order.</span></div>}
     {can("inventory.purchase")?<form action={quickAddPurchaseLineAction} className="inline-form compact-form">
      <input type="hidden" name="purchase_order_id" value={o.id}/>
      <label>Ingredient<select name="ingredient_id" defaultValue="" required><option value="" disabled>Select ingredient</option>{ingredients.map(i=><option key={i.ingredient_id} value={i.ingredient_id}>{i.name} · {qty(i.quantity_on_hand)} {i.unit_code} on hand</option>)}</select></label>
      <label>Quantity<input name="quantity_ordered" type="number" min="0.001" step="0.001" required/></label>
      <label>Unit cost<input name="unit_cost" type="number" min="0" step="0.0001" required/></label>
      <button type="submit" className="secondary">Add / update item</button>
     </form>:null}
     {can("inventory.purchase")&&orderLines.length?<form action={quickPlacePurchaseOrderAction} className="purchase-place-form"><input type="hidden" name="purchase_order_id" value={o.id}/><button type="submit">Place order</button></form>:null}
    </article>})}
    {!drafts.length?<div className="empty-state"><strong>No draft purchase orders</strong><span>Start a purchase above when food stock needs replenishment.</span></div>:null}
   </div>
  </section>

  <section className="panel section-block">
   <div className="section-heading"><div><p className="eyebrow">Step 3</p><h2>Receive deliveries</h2><p className="muted">This captures all quantities still outstanding on the selected order. Corrections stay in Advanced inventory.</p></div></div>
   <div className="card-list">{receiving.map(o=><article className="subcard" id={"order-"+o.id} key={o.id}>
    <div className="row-between"><div><strong>{o.order_number} · {o.supplier_name}</strong><div className="muted">{money(o.received_amount,o.currency)} received of {money(o.total_amount,o.currency)}</div></div><span className="badge">{o.status}</span></div>
    <div className="purchase-line-list">{lines.filter(l=>l.purchase_order_id===o.id&&Number(l.quantity_outstanding)>0).map(l=><div key={l.purchase_order_line_id}><span>{l.ingredient_name}</span><strong>{qty(l.quantity_outstanding)} {l.unit_code} outstanding</strong></div>)}</div>
    {can("inventory.purchase")?<form action={quickCreateReceiptFromOrderAction} className="inline-form compact-form"><input type="hidden" name="purchase_order_id" value={o.id}/><label>Received on<input name="received_on" type="date" defaultValue={today} required/></label><label>Notes<input name="notes" placeholder="Optional delivery note"/></label><button type="submit">Capture delivery</button></form>:null}
   </article>)}{!receiving.length?<div className="empty-state"><strong>No deliveries waiting</strong><span>Placed orders with outstanding stock will appear here.</span></div>:null}</div>
  </section>

  <section className="panel section-block" id="receipts">
   <div className="section-heading"><div><p className="eyebrow">Step 4</p><h2>Post received stock</h2><p className="muted">Posting updates inventory and creates the supplier payable automatically.</p></div></div>
   <div className="card-list">{draftReceipts.map(r=><article className="subcard" id={"receipt-"+r.id} key={r.id}><div className="row-between"><div><strong>{r.receipt_number} · {r.supplier_name}</strong><div className="muted">{iso(r.received_on)}{r.order_number?` · ${r.order_number}`:""}</div></div><strong>{money(r.total_amount,r.currency)}</strong></div>{can("inventory.post")?<form action={quickPostReceiptAction}><input type="hidden" name="inventory_receipt_id" value={r.id}/><button type="submit">Post stock & supplier payable</button></form>:<p className="muted">A user with inventory posting permission must post this receipt.</p>}</article>)}{!draftReceipts.length?<div className="empty-state"><strong>No receipts waiting to post</strong><span>Captured deliveries will appear here.</span></div>:null}</div>
  </section>

  <section className="panel section-block">
   <div className="section-heading"><div><p className="eyebrow">History</p><h2>Recent purchases & receipts</h2></div></div>
   <details className="hub-details"><summary>Purchase order history ({orders.length})</summary><div className="responsive-card-table"><table><thead><tr><th>Order</th><th>Supplier</th><th>Ordered</th><th>Total</th><th>Received</th><th>Status</th></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td data-label="Order">{o.order_number}</td><td data-label="Supplier">{o.supplier_name}</td><td data-label="Ordered">{iso(o.ordered_on)}</td><td data-label="Total">{money(o.total_amount,o.currency)}</td><td data-label="Received">{money(o.received_amount,o.currency)}</td><td data-label="Status"><span className="badge">{o.status}</span></td></tr>)}</tbody></table></div></details>
   <details className="hub-details"><summary>Receipt history ({receipts.length})</summary><div className="money-list">{receipts.slice(0,30).map(r=><article className="money-list-row" key={r.id}><div><strong>{r.receipt_number} · {r.supplier_name}</strong><small>{iso(r.received_on)}{r.order_number?` · ${r.order_number}`:""}</small></div><div><strong>{money(r.total_amount,r.currency)}</strong><span className="badge">{r.status}</span></div></article>)}</div></details>
  </section>
 </main>;
}
