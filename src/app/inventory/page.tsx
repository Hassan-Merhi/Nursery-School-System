import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import {
  addInventoryReceiptLineAction,
  addPurchaseOrderLineAction,
  cancelPurchaseOrderAction,
  configureInventoryMappingAction,
  createIngredientAction,
  createInventoryUnitAction,
  createInventoryReceiptAction,
  createPurchaseOrderAction,
  orderPurchaseOrderAction,
  postInventoryReceiptAction,
  recordInventoryAdjustmentAction,
  removeInventoryReceiptLineAction,
  removePurchaseOrderLineAction,
  reverseInventoryAdjustmentAction,
  reverseInventoryReceiptAction,
  setIngredientStatusAction,
  updateIngredientReorderLevelAction,
} from "./actions";

function money(value:unknown,currency="USD"){
  const n=Number(value??0);
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2}).format(n);}
  catch{return currency+" "+n.toFixed(2);}
}
function number(value:unknown,decimals=3){return Number(value??0).toLocaleString("en-US",{maximumFractionDigits:decimals});}
function dateText(value:unknown){return value?String(value).slice(0,10):"—";}

export default async function InventoryPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const auth=await requireUser();
  const can=(p:string)=>auth.permissions.includes(p);
  if(!["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"].some(can))redirect("/forbidden");
  const {error,success}=await searchParams;
  const today=new Date().toISOString().slice(0,10);

  const units=(await query<any>("select * from inventory_unit where is_active=true order by name")).rows;
  const ingredients=(await query<any>("select b.*,i.notes from ingredient_inventory_balance b join ingredient i on i.id=b.ingredient_id order by b.status,b.low_stock desc,b.name")).rows;
  const lowStock=(await query<any>("select * from low_stock_alert order by quantity_on_hand-reorder_level,name")).rows;
  const suppliers=(await query<any>("select id,supplier_number,name,payment_terms_days from supplier where status='active' order by name")).rows;
  const accounts=(await query<any>("select a.id,a.code,a.name,a.currency,t.category from account a join account_type t on t.id=a.account_type_id where a.status='active' and a.allow_posting=true and t.category in ('asset','expense') order by t.category,a.code")).rows;
  const mappings=(await query<any>("select d.role_key,d.name,d.required_category,m.account_id,a.code,a.name as account_name,a.currency from accounting_role_definition d left join accounting_mapping m on m.role_key=d.role_key left join account a on a.id=m.account_id where d.role_key in ('inventory_asset','food_program_expense') order by d.role_key")).rows;
  const inventoryCurrency=mappings.find((x:any)=>x.role_key==="inventory_asset")?.currency||"USD";

  const purchaseOrders=(await query<any>(`select p.*,
    coalesce((select json_agg(json_build_object(
      'line_id',pr.purchase_order_line_id,'ingredient_id',pr.ingredient_id,'ingredient_code',i.code,'ingredient_name',i.name,
      'unit_code',u.code,'quantity_ordered',pr.quantity_ordered,'quantity_received',pr.quantity_received,
      'quantity_outstanding',pr.quantity_outstanding,'unit_cost',pr.unit_cost,'line_amount',pr.line_amount
    ) order by i.name)
    from food_purchase_order_line_progress pr
    join ingredient i on i.id=pr.ingredient_id join inventory_unit u on u.id=i.unit_id
    where pr.purchase_order_id=p.id),'[]'::json) as lines
    from food_purchase_order_summary p order by p.created_at desc limit 100`)).rows;

  const receipts=(await query<any>(`select r.*,
    coalesce((select json_agg(json_build_object(
      'ingredient_id',rl.ingredient_id,'ingredient_code',i.code,'ingredient_name',i.name,'unit_code',u.code,
      'quantity_received',rl.quantity_received,'unit_cost',rl.unit_cost,'line_amount',rl.line_amount
    ) order by i.name)
    from inventory_receipt_line rl join ingredient i on i.id=rl.ingredient_id join inventory_unit u on u.id=i.unit_id
    where rl.inventory_receipt_id=r.id),'[]'::json) as lines
    from inventory_receipt_summary r order by r.created_at desc limit 100`)).rows;

  const adjustments=(await query<any>(`select a.*,i.code as ingredient_code,i.name as ingredient_name,u.code as unit_code
    from inventory_adjustment a join ingredient i on i.id=a.ingredient_id join inventory_unit u on u.id=i.unit_id
    order by a.created_at desc limit 100`)).rows;
  const movements=(await query<any>("select * from inventory_movement_report order by occurred_on desc,created_at desc limit 100")).rows;
  const monthRows=(await query<any>("select * from food_program_month_summary where month_start=date_trunc('month',current_date)::date order by currency")).rows;
  const month=monthRows.find((x:any)=>x.currency===inventoryCurrency)??monthRows[0]??{currency:inventoryCurrency,purchased_amount:0,usage_cost:0,waste_cost:0,spoilage_cost:0,recognized_food_cost:0,food_income:0,rough_food_margin:0};
  const valuation=ingredients.reduce((sum:number,x:any)=>sum+Number(x.inventory_value||0),0);
  const draftOrders=purchaseOrders.filter((x:any)=>x.status==="draft");
  const receivableOrders=purchaseOrders.filter((x:any)=>["ordered","partially_received"].includes(x.status));
  const draftReceipts=receipts.filter((x:any)=>x.status==="draft");

  return <main className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">Advanced inventory</p><h1>Inventory controls & purchasing</h1><p className="muted">Stock setup, receiving, posting, adjustments and accounting mappings. Routine food work starts in Food.</p></div>
      <div className="top-actions"><Link className="button-link secondary-link" href="/food">Back to Food</Link><Link className="button-link secondary-link" href="/food">Food billing</Link><Link className="button-link secondary-link" href="/operations">Suppliers</Link><Link className="button-link secondary-link" href="/accounting">Accounting</Link></div>
    </header>

    {error?<div className="notice error">{error}</div>:null}
    {success?<div className="notice success">{success}</div>:null}

    <section className="status-grid">
      <article className="panel"><p className="eyebrow">Bought this month</p><h2>{money(month.purchased_amount,month.currency)}</h2><p className="muted">Posted ingredient receipts.</p></article>
      <article className="panel"><p className="eyebrow">Stock on hand</p><h2>{money(valuation,inventoryCurrency)}</h2><p className="muted">Moving-average inventory valuation.</p></article>
      <article className="panel"><p className="eyebrow">Food packages earned</p><h2>{money(month.food_income,month.currency)}</h2><p className="muted">Issued food bills this month.</p></article>
      <article className="panel"><p className="eyebrow">Food program cost</p><h2>{money(month.recognized_food_cost,month.currency)}</h2><p className="muted">Usage + waste + spoilage + net corrections.</p></article>
      <article className="panel"><p className="eyebrow">Rough margin</p><h2>{money(month.rough_food_margin,month.currency)}</h2><p className="muted">Food billing income less recognized stock cost.</p></article>
      <article className="panel"><p className="eyebrow">Low stock</p><h2>{lowStock.length}</h2><p className="muted">Ingredients at or below their reorder level.</p></article>
    </section>

    {can("accounting.mapping")?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Accounting setup</p><h2>Inventory mappings</h2></div></div>
      <p className="muted">Purchases debit Inventory Asset and credit Accounts Payable. Usage, waste and spoilage debit Food Program Expense and credit Inventory Asset.</p>
      <div className="split-grid">{mappings.map((m:any)=><form action={configureInventoryMappingAction} className="form-grid" key={m.role_key}><h3 className="span-2">{m.name}</h3><input type="hidden" name="role_key" value={m.role_key}/><label className="span-2">{m.required_category} account<select name="account_id" required defaultValue={m.account_id||""}><option value="" disabled>Select account</option>{accounts.filter((x:any)=>x.category===m.required_category).map((x:any)=><option key={x.id} value={x.id}>{x.code} · {x.name} · {x.currency}</option>)}</select></label><button type="submit">Save mapping</button><small className="span-2">Current: {m.account_code?`${m.account_code} · ${m.account_name} · ${m.currency}`:"Not configured"}</small></form>)}</div>
    </section>:null}

    {(can("inventory.view")||can("inventory.manage"))?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Ingredients</p><h2>Stock master & valuation</h2></div><span className="badge">{ingredients.length} ingredients</span></div>
      {can("inventory.manage")?<div className="split-grid"><form action={createInventoryUnitAction} className="form-grid"><h3 className="span-2">Add stock unit</h3><label>Code<input name="code" placeholder="BAG" maxLength={12} required/></label><label>Name<input name="name" placeholder="Bag" required/></label><label>Decimal places<input name="decimal_places" type="number" min={0} max={6} defaultValue={0} required/></label><button type="submit">Create unit</button></form><form action={createIngredientAction} className="form-grid"><h3 className="span-2">Add ingredient</h3><label>Code<input name="code" placeholder="RICE" required/></label><label>Name<input name="name" placeholder="Rice" required/></label><label>Base unit<select name="unit_id" required defaultValue=""><option value="" disabled>Select unit</option>{units.map((u:any)=><option key={u.id} value={u.id}>{u.code} · {u.name}</option>)}</select></label><label>Low-stock level<input name="reorder_level" defaultValue="0" inputMode="decimal" required/></label><label className="span-2">Notes<input name="notes"/></label><button type="submit">Create ingredient</button></form></div>:null}
      <p className="muted">Active units: {units.map((u:any)=>u.code+" · "+u.name).join(", ")}</p>
      <div className="table-wrap"><table><thead><tr><th>Ingredient</th><th>Unit</th><th>On hand</th><th>Avg cost</th><th>Value</th><th>Reorder level</th><th>Status</th><th>Action</th></tr></thead><tbody>{ingredients.map((i:any)=><tr key={i.ingredient_id}><td><strong>{i.code} · {i.name}</strong><small>{i.notes||""}</small></td><td>{i.unit_code}</td><td>{number(i.quantity_on_hand)}</td><td>{money(i.average_unit_cost,inventoryCurrency)}</td><td>{money(i.inventory_value,inventoryCurrency)}</td><td>{can("inventory.manage")?<form action={updateIngredientReorderLevelAction} className="compact-form"><input type="hidden" name="ingredient_id" value={i.ingredient_id}/><input name="reorder_level" defaultValue={String(i.reorder_level)} inputMode="decimal" aria-label={"Low-stock level for "+i.name}/><button className="secondary">Save</button>{i.low_stock?<small>LOW STOCK</small>:null}</form>:<>{number(i.reorder_level)}{i.low_stock?<small>LOW STOCK</small>:null}</>}</td><td><span className="badge">{i.status}</span></td><td>{can("inventory.manage")?<form action={setIngredientStatusAction} className="compact-form"><input type="hidden" name="ingredient_id" value={i.ingredient_id}/><button className="secondary" name="status" value={i.status==="active"?"inactive":"active"}>{i.status==="active"?"Deactivate":"Activate"}</button></form>:null}</td></tr>)}{!ingredients.length?<tr><td colSpan={8}>No ingredients yet.</td></tr>:null}</tbody></table></div>
    </section>:null}

    {can("inventory.view")&&lowStock.length?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Alerts</p><h2>Low stock</h2></div><span className="badge">{lowStock.length}</span></div><div className="table-wrap"><table><thead><tr><th>Ingredient</th><th>On hand</th><th>Reorder level</th><th>Shortfall to threshold</th></tr></thead><tbody>{lowStock.map((i:any)=><tr key={i.ingredient_id}><td>{i.code} · {i.name}</td><td>{number(i.quantity_on_hand)} {i.unit_code}</td><td>{number(i.reorder_level)} {i.unit_code}</td><td>{number(Math.max(0,Number(i.reorder_level)-Number(i.quantity_on_hand)))} {i.unit_code}</td></tr>)}</tbody></table></div></section>:null}

    {(can("inventory.view")||can("inventory.purchase"))?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Purchasing</p><h2>Food purchase orders</h2></div></div>
      {can("inventory.purchase")?<div className="split-grid">
        <form action={createPurchaseOrderAction} className="form-grid"><h3 className="span-2">Create purchase order</h3><label>Supplier<select name="supplier_id" required defaultValue=""><option value="" disabled>Select supplier</option>{suppliers.map((s:any)=><option key={s.id} value={s.id}>{s.supplier_number} · {s.name}</option>)}</select></label><label>Currency<input name="currency" defaultValue={inventoryCurrency} maxLength={3} required/></label><label>Order date<input name="ordered_on" type="date" defaultValue={today} required/></label><label>Expected on<input name="expected_on" type="date"/></label><label className="span-2">Notes<input name="notes"/></label><button type="submit">Create draft PO</button></form>
        <form action={addPurchaseOrderLineAction} className="form-grid"><h3 className="span-2">Add / update PO line</h3><label className="span-2">Draft PO<select name="purchase_order_id" required defaultValue=""><option value="" disabled>Select PO</option>{draftOrders.map((p:any)=><option key={p.id} value={p.id}>{p.order_number} · {p.supplier_name}</option>)}</select></label><label>Ingredient<select name="ingredient_id" required defaultValue=""><option value="" disabled>Select ingredient</option>{ingredients.filter((x:any)=>x.status==="active").map((i:any)=><option key={i.ingredient_id} value={i.ingredient_id}>{i.code} · {i.name} · {i.unit_code}</option>)}</select></label><label>Quantity<input name="quantity_ordered" inputMode="decimal" required/></label><label>Unit cost<input name="unit_cost" inputMode="decimal" required/></label><button type="submit">Save line</button></form>
      </div>:null}
      <div className="table-wrap"><table><thead><tr><th>PO</th><th>Supplier</th><th>Dates</th><th>Lines</th><th>Total</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead><tbody>{purchaseOrders.map((p:any)=><tr key={p.id}><td><strong>{p.order_number}</strong><small>{p.notes||""}</small></td><td>{p.supplier_number} · {p.supplier_name}</td><td>{dateText(p.ordered_on)}<small>Expected {dateText(p.expected_on)}</small></td><td>{(p.lines as any[]).map((l:any)=><div key={l.line_id}>{number(l.quantity_ordered)} {l.unit_code} × {l.ingredient_name} @ {money(l.unit_cost,p.currency)}{can("inventory.purchase")&&p.status==="draft"?<form action={removePurchaseOrderLineAction} className="compact-form"><input type="hidden" name="purchase_order_id" value={p.id}/><button className="secondary" name="ingredient_id" value={l.ingredient_id}>Remove</button></form>:null}</div>)}</td><td>{money(p.order_total,p.currency)}</td><td>{number(p.received_quantity)} / {number(p.ordered_quantity)}</td><td><span className="badge">{p.status}</span></td><td>{can("inventory.purchase")&&p.status==="draft"?<form action={orderPurchaseOrderAction} className="compact-form"><button name="purchase_order_id" value={p.id}>Mark ordered</button></form>:null}{can("inventory.purchase")&&!["received","cancelled"].includes(p.status)?<form action={cancelPurchaseOrderAction} className="compact-form"><input type="hidden" name="purchase_order_id" value={p.id}/><input name="reason" placeholder="Cancellation reason" required/><button className="secondary">Cancel</button></form>:null}</td></tr>)}{!purchaseOrders.length?<tr><td colSpan={8}>No food purchase orders yet.</td></tr>:null}</tbody></table></div>
    </section>:null}

    {(can("inventory.view")||can("inventory.purchase")||can("inventory.post"))?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Receiving</p><h2>Stock received</h2></div></div>
      {can("inventory.purchase")?<div className="split-grid">
        <form action={createInventoryReceiptAction} className="form-grid"><h3 className="span-2">Create stock receipt</h3><label>Supplier<select name="supplier_id" required defaultValue=""><option value="" disabled>Select supplier</option>{suppliers.map((s:any)=><option key={s.id} value={s.id}>{s.supplier_number} · {s.name}</option>)}</select></label><label>Purchase order<select name="purchase_order_id" defaultValue=""><option value="">No PO</option>{receivableOrders.map((p:any)=><option key={p.id} value={p.id}>{p.order_number} · {p.supplier_name}</option>)}</select></label><label>Received on<input name="received_on" type="date" defaultValue={today} required/></label><label>Currency<input name="currency" defaultValue={inventoryCurrency} maxLength={3} required/></label><label>Supplier reference<input name="supplier_reference"/></label><label>Notes<input name="notes"/></label><button type="submit">Create draft receipt</button></form>
        <form action={addInventoryReceiptLineAction} className="form-grid"><h3 className="span-2">Add / update receipt line</h3><label className="span-2">Draft receipt<select name="inventory_receipt_id" required defaultValue=""><option value="" disabled>Select receipt</option>{draftReceipts.map((r:any)=><option key={r.id} value={r.id}>{r.receipt_number} · {r.supplier_name}</option>)}</select></label><label>Ingredient<select name="ingredient_id" required defaultValue=""><option value="" disabled>Select ingredient</option>{ingredients.filter((x:any)=>x.status==="active").map((i:any)=><option key={i.ingredient_id} value={i.ingredient_id}>{i.code} · {i.name} · {i.unit_code}</option>)}</select></label><label>Quantity received<input name="quantity_received" inputMode="decimal" required/></label><label>Unit cost<input name="unit_cost" inputMode="decimal" required/></label><button type="submit">Save line</button></form>
      </div>:null}
      <div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Supplier / PO</th><th>Date</th><th>Lines</th><th>Total</th><th>Supplier payable</th><th>Status</th><th>Actions</th></tr></thead><tbody>{receipts.map((r:any)=><tr key={r.id}><td><strong>{r.receipt_number}</strong><small>{r.supplier_reference||r.notes||""}</small></td><td>{r.supplier_number} · {r.supplier_name}<small>{r.order_number?`PO ${r.order_number}`:"No PO"}</small></td><td>{dateText(r.received_on)}</td><td>{(r.lines as any[]).map((l:any)=><div key={l.ingredient_id}>{number(l.quantity_received)} {l.unit_code} × {l.ingredient_name} @ {money(l.unit_cost,r.currency)}{can("inventory.purchase")&&r.status==="draft"?<form action={removeInventoryReceiptLineAction} className="compact-form"><input type="hidden" name="inventory_receipt_id" value={r.id}/><button className="secondary" name="ingredient_id" value={l.ingredient_id}>Remove</button></form>:null}</div>)}</td><td>{money(r.receipt_total,r.currency)}</td><td>{r.supplier_invoice_number?<>{r.supplier_invoice_number}<small>{r.supplier_invoice_status}</small></>:"—"}</td><td><span className="badge">{r.status}</span></td><td>{can("inventory.post")&&r.status==="draft"?<form action={postInventoryReceiptAction} className="compact-form"><button name="inventory_receipt_id" value={r.id}>Post receipt</button></form>:null}{can("inventory.post")&&r.status==="posted"?<form action={reverseInventoryReceiptAction} className="compact-form"><input type="hidden" name="inventory_receipt_id" value={r.id}/><input name="reversal_date" type="date" defaultValue={today} required/><input name="reason" placeholder="Reversal reason" required/><button className="secondary">Reverse</button></form>:null}</td></tr>)}{!receipts.length?<tr><td colSpan={8}>No stock receipts yet.</td></tr>:null}</tbody></table></div>
    </section>:null}

    {(can("inventory.view")||can("inventory.adjust"))?<section className="panel section-block">
      <div className="section-heading"><div><p className="eyebrow">Usage & waste</p><h2>Stock adjustments</h2></div></div>
      {can("inventory.adjust")?<form action={recordInventoryAdjustmentAction} className="form-grid"><label>Ingredient<select name="ingredient_id" required defaultValue=""><option value="" disabled>Select ingredient</option>{ingredients.filter((x:any)=>x.status==="active").map((i:any)=><option key={i.ingredient_id} value={i.ingredient_id}>{i.code} · {i.name} · on hand {number(i.quantity_on_hand)} {i.unit_code}</option>)}</select></label><label>Type<select name="adjustment_kind" defaultValue="usage"><option value="usage">Kitchen usage</option><option value="waste">Waste</option><option value="spoilage">Spoilage</option><option value="correction_in">Stock correction in</option><option value="correction_out">Stock correction out</option></select></label><label>Quantity<input name="quantity" inputMode="decimal" required/></label><label>Date<input name="occurred_on" type="date" defaultValue={today} required/></label><label>Currency<input name="currency" defaultValue={inventoryCurrency} maxLength={3} required/></label><label>Unit cost for correction-in only<input name="unit_cost_override" inputMode="decimal" placeholder="Optional unless stock is zero"/></label><label className="span-2">Reason<input name="reason" placeholder="Lunch preparation / expired milk / stock count" required/></label><label className="span-2">Notes<input name="notes"/></label><button type="submit">Post stock adjustment</button></form>:null}
      <div className="table-wrap"><table><thead><tr><th>Adjustment</th><th>Ingredient</th><th>Date</th><th>Type</th><th>Quantity</th><th>Cost</th><th>Reason</th><th>Status / action</th></tr></thead><tbody>{adjustments.map((a:any)=><tr key={a.id}><td>{a.adjustment_number}</td><td>{a.ingredient_code} · {a.ingredient_name}</td><td>{dateText(a.occurred_on)}</td><td>{String(a.adjustment_kind).replaceAll("_"," ")}</td><td>{number(a.quantity)} {a.unit_code}</td><td>{a.total_value==null?"—":money(a.total_value,a.currency)}</td><td>{a.reason}</td><td><span className="badge">{a.status}</span>{can("inventory.adjust")&&a.status==="posted"?<form action={reverseInventoryAdjustmentAction} className="compact-form"><input type="hidden" name="inventory_adjustment_id" value={a.id}/><input name="reversal_date" type="date" defaultValue={today} required/><input name="reason" placeholder="Reversal reason" required/><button className="secondary">Reverse</button></form>:null}</td></tr>)}{!adjustments.length?<tr><td colSpan={8}>No stock adjustments yet.</td></tr>:null}</tbody></table></div>
    </section>:null}

    {can("inventory.view")?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Audit-friendly stock history</p><h2>Recent inventory movements</h2></div><span className="badge">Last {movements.length}</span></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Ingredient</th><th>Movement</th><th>Quantity</th><th>Unit cost</th><th>Value change</th><th>Reference</th></tr></thead><tbody>{movements.map((m:any)=><tr key={m.id}><td>{dateText(m.occurred_on)}</td><td>{m.ingredient_code} · {m.ingredient_name}</td><td>{String(m.movement_kind).replaceAll("_"," ")}</td><td>{number(m.quantity_delta)} {m.unit_code}</td><td>{money(m.unit_cost,inventoryCurrency)}</td><td>{money(m.value_delta,inventoryCurrency)}</td><td>{m.reference||m.source_type}</td></tr>)}{!movements.length?<tr><td colSpan={7}>No inventory movements yet.</td></tr>:null}</tbody></table></div></section>:null}

    <section className="panel section-block"><p className="eyebrow">Scope</p><h2>Deliberately simple costing</h2><p className="muted">Step 11 tracks what Montikids buys, what remains in stock, and manual usage/waste at moving-average cost. It does not pretend to know grams consumed per child or recipe-level theoretical usage. That can be added later without replacing this inventory ledger.</p></section>
  </main>;
}