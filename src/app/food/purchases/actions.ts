"use server";

import type { PoolClient } from "pg";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const QTY_RE=/^\d+(?:\.\d{1,3})?$/;
const MONEY_RE=/^\d+(?:\.\d{1,4})?$/;
function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function fail(m:string):never{redirect("/food/purchases?error="+encodeURIComponent(m));}
function ok(m:string,anchor=""):never{
  revalidatePath("/food/purchases");revalidatePath("/food/inventory");revalidatePath("/food/alerts");
  revalidatePath("/inventory");revalidatePath("/money");revalidatePath("/dashboard");
  redirect("/food/purchases?success="+encodeURIComponent(m)+anchor);
}
function id(raw:string,label:string){if(!UUID_RE.test(raw))fail("Invalid "+label+".");return raw;}
function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))fail("Enter a valid "+label+".");return raw;}
function cur(raw:string){const x=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(x))fail("Currency must be a three-letter code.");return x;}
function qty(raw:string,label:string){if(!QTY_RE.test(raw)||Number(raw)<=0)fail("Enter a valid "+label+" greater than zero.");return Number(raw).toFixed(3);}
function cost(raw:string){if(!MONEY_RE.test(raw)||Number(raw)<0)fail("Enter a valid unit cost.");return Number(raw).toFixed(4);}
async function nextNo(c:PoolClient,type:string,userId:string){
  const r=await c.query<{prefix:string;number:string}>(
    "update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text number",
    [type,userId],
  );
  if(!r.rows[0])fail("Document sequence "+type+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}

export async function quickCreatePurchaseOrderAction(d:FormData){
  const auth=await requirePermission("inventory.purchase");
  const supplier=id(v(d,"supplier_id"),"supplier"),ordered=day(v(d,"ordered_on"),"order date");
  const expected=v(d,"expected_on")?day(v(d,"expected_on"),"expected date"):null,currency=cur(v(d,"currency"));
  if(expected&&expected<ordered)fail("Expected date cannot be before order date.");
  let orderId="";
  await withTransaction(async c=>{
    const number=await nextNo(c,"food_purchase_order",auth.userId);
    const r=await c.query<{id:string}>(
      "insert into food_purchase_order(order_number,supplier_id,ordered_on,expected_on,currency,notes,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$7,$7) returning id",
      [number,supplier,ordered,expected,currency,v(d,"notes")||null,auth.userId],
    );
    orderId=r.rows[0].id;
    await writeAudit(c,{actorUserId:auth.userId,action:"food_purchase_order_created",entityType:"food_purchase_order",entityId:orderId,after:{number,supplier,ordered,expected,currency,source:"simple_food_purchase"}});
  });
  ok("Draft purchase created. Add the ingredients, then place the order.","#order-"+orderId);
}

export async function quickAddPurchaseLineAction(d:FormData){
  const auth=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order"),ingredient=id(v(d,"ingredient_id"),"ingredient");
  const quantity=qty(v(d,"quantity_ordered"),"quantity"),unitCost=cost(v(d,"unit_cost"));
  await withTransaction(async c=>{
    const row=(await c.query<{status:string}>("select status from food_purchase_order where id=$1 for update",[order])).rows[0];
    if(!row||row.status!=="draft")fail("Only draft purchase orders can be edited.");
    await c.query(
      "insert into food_purchase_order_line(purchase_order_id,ingredient_id,quantity_ordered,unit_cost,created_by) values($1,$2,$3,$4,$5) on conflict(purchase_order_id,ingredient_id) do update set quantity_ordered=excluded.quantity_ordered,unit_cost=excluded.unit_cost",
      [order,ingredient,quantity,unitCost,auth.userId],
    );
    await writeAudit(c,{actorUserId:auth.userId,action:"food_purchase_order_line_saved",entityType:"food_purchase_order",entityId:order,after:{ingredient,quantity,unitCost,source:"simple_food_purchase"}});
  });
  ok("Ingredient saved on the purchase order.","#order-"+order);
}

export async function quickPlacePurchaseOrderAction(d:FormData){
  const auth=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order");
  await withTransaction(async c=>{
    await c.query("select submit_food_purchase_order($1,$2)",[order,auth.userId]);
    await writeAudit(c,{actorUserId:auth.userId,action:"food_purchase_order_ordered",entityType:"food_purchase_order",entityId:order,after:{status:"ordered",source:"simple_food_purchase"}});
  });
  ok("Purchase order placed. When the delivery arrives, receive it below.","#order-"+order);
}

export async function quickCreateReceiptFromOrderAction(d:FormData){
  const auth=await requirePermission("inventory.purchase"),order=id(v(d,"purchase_order_id"),"purchase order");
  const received=day(v(d,"received_on"),"received date");
  let receiptId="";
  await withTransaction(async c=>{
    const po=(await c.query<{supplier_id:string;currency:string;status:string}>(
      "select supplier_id,currency,status from food_purchase_order where id=$1 for update",[order],
    )).rows[0];
    if(!po||!["ordered","partially_received"].includes(po.status))fail("Only ordered purchases with outstanding stock can be received.");
    const lines=(await c.query<{ingredient_id:string;quantity_outstanding:string;unit_cost:string}>(
      "select ingredient_id,quantity_outstanding::text,unit_cost::text from food_purchase_order_line_progress where purchase_order_id=$1 and quantity_outstanding>0 order by ingredient_name",
      [order],
    )).rows;
    if(!lines.length)fail("This purchase order has no outstanding quantities.");
    const number=await nextNo(c,"inventory_receipt",auth.userId);
    const receipt=await c.query<{id:string}>(
      "insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,received_on,currency,notes,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$7,$7) returning id",
      [number,po.supplier_id,order,received,po.currency,v(d,"notes")||null,auth.userId],
    );
    receiptId=receipt.rows[0].id;
    for(const line of lines){
      await c.query(
        "insert into inventory_receipt_line(inventory_receipt_id,ingredient_id,quantity_received,unit_cost,created_by) values($1,$2,$3,$4,$5)",
        [receiptId,line.ingredient_id,line.quantity_outstanding,line.unit_cost,auth.userId],
      );
    }
    await writeAudit(c,{actorUserId:auth.userId,action:"inventory_receipt_created",entityType:"inventory_receipt",entityId:receiptId,after:{order,received,lineCount:lines.length,source:"simple_food_purchase"}});
  });
  ok("Delivery captured from all outstanding order quantities. Review and post the receipt.","#receipt-"+receiptId);
}

export async function quickPostReceiptAction(d:FormData){
  const auth=await requirePermission("inventory.post"),receipt=id(v(d,"inventory_receipt_id"),"inventory receipt");
  await withTransaction(async c=>{
    const row=(await c.query<{status:string}>("select status from inventory_receipt where id=$1 for update",[receipt])).rows[0];
    if(!row||row.status!=="draft")fail("Only draft receipts can be posted.");
    const invoice=(await c.query<{post_inventory_receipt:string}>("select post_inventory_receipt($1,$2)",[receipt,auth.userId])).rows[0]?.post_inventory_receipt;
    await writeAudit(c,{actorUserId:auth.userId,action:"inventory_receipt_posted",entityType:"inventory_receipt",entityId:receipt,after:{supplierInvoiceId:invoice,source:"simple_food_purchase"}});
  });
  ok("Stock received. Inventory and supplier payable were updated.","#receipts");
}
