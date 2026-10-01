"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE=/^\d+(?:\.\d{1,4})?$/;
const QTY_RE=/^\d+(?:\.\d{1,3})?$/;
const ADJUSTMENT_KINDS=new Set(["usage","waste","spoilage","correction_in","correction_out"]);

function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function bad(m:string):never{redirect("/inventory?error="+encodeURIComponent(m));}
function good(m:string):never{
  revalidatePath("/inventory");revalidatePath("/operations");revalidatePath("/accounting");
  revalidatePath("/reports");revalidatePath("/dashboard");revalidatePath("/food");
  redirect("/inventory?success="+encodeURIComponent(m));
}
function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
function oid(raw:string,label:string){return raw?id(raw,label):null;}
function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");return raw;}
function cur(raw:string){const c=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(c))bad("Currency must be a three-letter code.");return c;}
function code(raw:string,label:string){const x=raw.trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(x))bad(label+" must be 2–30 characters using letters, numbers, hyphens or underscores.");return x;}
function qty(raw:string,label:string,allowZero=false){if(!QTY_RE.test(raw))bad("Enter a valid "+label+" with at most three decimals.");const n=Number(raw);if(!Number.isFinite(n)||(allowZero?n<0:n<=0)||n>99999999999)bad(label+(allowZero?" cannot be negative.":" must be greater than zero."));return n.toFixed(3);}
function money4(raw:string,label:string,allowZero=true){if(!MONEY_RE.test(raw))bad("Enter a valid "+label+" with at most four decimals.");const n=Number(raw);if(!Number.isFinite(n)||(allowZero?n<0:n<=0)||n>9999999999)bad(label+(allowZero?" cannot be negative.":" must be greater than zero."));return n.toFixed(4);}

async function nextNo(c:PoolClient,t:string,u:string){
  const r=await c.query<{prefix:string;number:string}>("update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text as number",[t,u]);
  if(!r.rows[0])bad("Document sequence "+t+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}

export async function configureInventoryMappingAction(d:FormData){
  const a=await requirePermission("accounting.mapping");
  const role=v(d,"role_key"),account=id(v(d,"account_id"),"account");
  if(!["inventory_asset","food_program_expense"].includes(role))bad("Invalid inventory accounting role.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from accounting_mapping where role_key=$1 for update",[role])).rows[0]??null;
    await c.query("insert into accounting_mapping(role_key,account_id,updated_by) values ($1,$2,$3) on conflict (role_key) do update set account_id=excluded.account_id,updated_at=now(),updated_by=excluded.updated_by",[role,account,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"inventory_mapping_configured",entityType:"accounting_mapping",entityId:role,before,after:{roleKey:role,accountId:account}});
  });
  good("Inventory accounting mapping saved.");
}

export async function createIngredientAction(d:FormData){
  const a=await requirePermission("inventory.manage");
  const ingredientCode=code(v(d,"code"),"Ingredient code"),name=v(d,"name"),unit=id(v(d,"unit_id"),"unit"),reorder=qty(v(d,"reorder_level")||"0","reorder level",true);
  if(!name)bad("Ingredient name is required.");
  await withTransaction(async c=>{
    const r=await c.query<{id:string}>("insert into ingredient(code,name,unit_id,reorder_level,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id",[ingredientCode,name,unit,reorder,v(d,"notes")||null,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"ingredient_created",entityType:"ingredient",entityId:r.rows[0].id,after:{code:ingredientCode,name,unit,reorderLevel:reorder}});
  });
  good("Ingredient created.");
}

export async function setIngredientStatusAction(d:FormData){
  const a=await requirePermission("inventory.manage"),ingredient=id(v(d,"ingredient_id"),"ingredient"),status=v(d,"status");
  if(!["active","inactive"].includes(status))bad("Invalid ingredient status.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from ingredient where id=$1 for update",[ingredient])).rows[0];if(!before)bad("Ingredient not found.");
    await c.query("update ingredient set status=$2,updated_at=now(),updated_by=$3 where id=$1",[ingredient,status,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"ingredient_status_changed",entityType:"ingredient",entityId:ingredient,before,after:{status}});
  });
  good("Ingredient status updated.");
}

export async function createPurchaseOrderAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),supplier=id(v(d,"supplier_id"),"supplier"),orderedOn=day(v(d,"ordered_on"),"order date"),expected=v(d,"expected_on")?day(v(d,"expected_on"),"expected date"):null,currency=cur(v(d,"currency"));
  if(expected&&expected<orderedOn)bad("Expected date cannot be before the order date.");
  await withTransaction(async c=>{
    const number=await nextNo(c,"food_purchase_order",a.userId);
    const r=await c.query<{id:string}>("insert into food_purchase_order(order_number,supplier_id,ordered_on,expected_on,currency,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id",[number,supplier,orderedOn,expected,currency,v(d,"notes")||null,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_purchase_order_created",entityType:"food_purchase_order",entityId:r.rows[0].id,after:{number,supplier,orderedOn,expected,currency}});
  });
  good("Draft food purchase order created.");
}

export async function addPurchaseOrderLineAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order"),ingredient=id(v(d,"ingredient_id"),"ingredient"),quantity=qty(v(d,"quantity_ordered"),"ordered quantity"),unitCost=money4(v(d,"unit_cost"),"unit cost");
  await withTransaction(async c=>{
    await c.query("insert into food_purchase_order_line(purchase_order_id,ingredient_id,quantity_ordered,unit_cost,created_by) values ($1,$2,$3,$4,$5) on conflict (purchase_order_id,ingredient_id) do update set quantity_ordered=excluded.quantity_ordered,unit_cost=excluded.unit_cost",[order,ingredient,quantity,unitCost,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_purchase_order_line_saved",entityType:"food_purchase_order",entityId:order,after:{ingredient,quantity,unitCost}});
  });
  good("Purchase order line saved.");
}

export async function removePurchaseOrderLineAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order"),ingredient=id(v(d,"ingredient_id"),"ingredient");
  await withTransaction(async c=>{
    await c.query("delete from food_purchase_order_line where purchase_order_id=$1 and ingredient_id=$2",[order,ingredient]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_purchase_order_line_removed",entityType:"food_purchase_order",entityId:order,after:{ingredient}});
  });
  good("Purchase order line removed.");
}

export async function orderPurchaseOrderAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order");
  await withTransaction(async c=>{await c.query("select submit_food_purchase_order($1,$2)",[order,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"food_purchase_order_ordered",entityType:"food_purchase_order",entityId:order,after:{status:"ordered"}});});
  good("Purchase order marked as ordered.");
}

export async function cancelPurchaseOrderAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order"),reason=v(d,"reason");if(!reason)bad("Cancellation reason is required.");
  await withTransaction(async c=>{await c.query("select cancel_food_purchase_order($1,$2,$3)",[order,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"food_purchase_order_cancelled",entityType:"food_purchase_order",entityId:order,after:{status:"cancelled",reason}});});
  good("Purchase order cancelled.");
}

export async function createInventoryReceiptAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),supplier=id(v(d,"supplier_id"),"supplier"),order=oid(v(d,"purchase_order_id"),"purchase order"),receivedOn=day(v(d,"received_on"),"received date"),currency=cur(v(d,"currency"));
  await withTransaction(async c=>{
    const number=await nextNo(c,"inventory_receipt",a.userId);
    const r=await c.query<{id:string}>("insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,supplier_reference,received_on,currency,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id",[number,supplier,order,v(d,"supplier_reference")||null,receivedOn,currency,v(d,"notes")||null,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"inventory_receipt_created",entityType:"inventory_receipt",entityId:r.rows[0].id,after:{number,supplier,order,receivedOn,currency}});
  });
  good("Draft stock receipt created.");
}

export async function addInventoryReceiptLineAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),receipt=id(v(d,"inventory_receipt_id"),"inventory receipt"),ingredient=id(v(d,"ingredient_id"),"ingredient"),quantity=qty(v(d,"quantity_received"),"received quantity"),unitCost=money4(v(d,"unit_cost"),"unit cost");
  await withTransaction(async c=>{
    await c.query("insert into inventory_receipt_line(inventory_receipt_id,ingredient_id,quantity_received,unit_cost,created_by) values ($1,$2,$3,$4,$5) on conflict (inventory_receipt_id,ingredient_id) do update set quantity_received=excluded.quantity_received,unit_cost=excluded.unit_cost",[receipt,ingredient,quantity,unitCost,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"inventory_receipt_line_saved",entityType:"inventory_receipt",entityId:receipt,after:{ingredient,quantity,unitCost}});
  });
  good("Stock receipt line saved.");
}

export async function removeInventoryReceiptLineAction(d:FormData){
  const a=await requirePermission("inventory.purchase"),receipt=id(v(d,"inventory_receipt_id"),"inventory receipt"),ingredient=id(v(d,"ingredient_id"),"ingredient");
  await withTransaction(async c=>{await c.query("delete from inventory_receipt_line where inventory_receipt_id=$1 and ingredient_id=$2",[receipt,ingredient]);await writeAudit(c,{actorUserId:a.userId,action:"inventory_receipt_line_removed",entityType:"inventory_receipt",entityId:receipt,after:{ingredient}});});
  good("Stock receipt line removed.");
}

export async function postInventoryReceiptAction(d:FormData){
  const a=await requirePermission("inventory.post"),receipt=id(v(d,"inventory_receipt_id"),"inventory receipt");
  await withTransaction(async c=>{
    const invoice=(await c.query<{post_inventory_receipt:string}>("select post_inventory_receipt($1,$2)",[receipt,a.userId])).rows[0]?.post_inventory_receipt;
    await writeAudit(c,{actorUserId:a.userId,action:"inventory_receipt_posted",entityType:"inventory_receipt",entityId:receipt,after:{supplierInvoiceId:invoice}});
  });
  good("Stock received, inventory updated, and supplier payable posted.");
}

export async function reverseInventoryReceiptAction(d:FormData){
  const a=await requirePermission("inventory.post"),receipt=id(v(d,"inventory_receipt_id"),"inventory receipt"),reversalDate=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await c.query("select reverse_inventory_receipt($1,$2,$3,$4)",[receipt,reversalDate,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"inventory_receipt_reversed",entityType:"inventory_receipt",entityId:receipt,after:{reversalDate,reason}});});
  good("Inventory receipt and supplier payable reversed.");
}

export async function recordInventoryAdjustmentAction(d:FormData){
  const a=await requirePermission("inventory.adjust"),ingredient=id(v(d,"ingredient_id"),"ingredient"),kind=v(d,"adjustment_kind"),quantity=qty(v(d,"quantity"),"quantity"),occurredOn=day(v(d,"occurred_on"),"date"),currency=cur(v(d,"currency")),reason=v(d,"reason");
  if(!ADJUSTMENT_KINDS.has(kind))bad("Invalid stock adjustment type.");if(!reason)bad("Reason is required.");
  const override=v(d,"unit_cost_override")?money4(v(d,"unit_cost_override"),"unit cost"):null;
  await withTransaction(async c=>{
    const number=await nextNo(c,"inventory_adjustment",a.userId);
    const r=await c.query<{id:string}>("insert into inventory_adjustment(adjustment_number,ingredient_id,adjustment_kind,quantity,unit_cost_override,occurred_on,currency,reason,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",[number,ingredient,kind,quantity,override,occurredOn,currency,reason,v(d,"notes")||null,a.userId]);
    await c.query("select post_inventory_adjustment($1,$2)",[r.rows[0].id,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"inventory_adjustment_posted",entityType:"inventory_adjustment",entityId:r.rows[0].id,after:{number,ingredient,kind,quantity,occurredOn,currency,reason}});
  });
  good("Stock adjustment posted at moving-average cost.");
}

export async function reverseInventoryAdjustmentAction(d:FormData){
  const a=await requirePermission("inventory.adjust"),adjustment=id(v(d,"inventory_adjustment_id"),"inventory adjustment"),reversalDate=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await c.query("select reverse_inventory_adjustment($1,$2,$3,$4)",[adjustment,reversalDate,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"inventory_adjustment_reversed",entityType:"inventory_adjustment",entityId:adjustment,after:{reversalDate,reason}});});
  good("Stock adjustment reversed.");
}