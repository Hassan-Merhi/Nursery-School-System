import assert from "node:assert/strict";
import { balance } from "./release2-test-support.mjs";

export async function runInventoryFlow(ctx){
  const {client,pool,suffix,supplier,bank,ap,inventoryAsset,foodExpense}=ctx;
  const kg=(await client.query("select id from inventory_unit where code='KG'")).rows[0].id;
  const rice=(await client.query(`insert into ingredient(code,name,unit_id,reorder_level,status) values ($1,'Release 2 Rice',$2,15,'active') returning id`,["R2-RICE-"+suffix,kg])).rows[0].id;
  const po=(await client.query(`insert into food_purchase_order(order_number,supplier_id,ordered_on,expected_on,currency,status) values ($1,$2,'2026-10-06','2026-10-07','USD','draft') returning id`,["R2-PO-"+suffix,supplier])).rows[0].id;
  await client.query("insert into food_purchase_order_line(purchase_order_id,ingredient_id,quantity_ordered,unit_cost) values ($1,$2,20,4)",[po,rice]);
  await client.query("select submit_food_purchase_order($1,null)",[po]);
  const receipt=(await client.query(`insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,received_on,currency) values ($1,$2,$3,'2026-10-07','USD') returning id`,["R2-RCV-"+suffix,supplier,po])).rows[0].id;
  await client.query("insert into inventory_receipt_line(inventory_receipt_id,ingredient_id,quantity_received,unit_cost) values ($1,$2,20,4)",[receipt,rice]);
  const supplierInvoice=(await client.query("select post_inventory_receipt($1,null) id",[receipt])).rows[0].id;
  const invoice=(await client.query("select status,amount::text,inventory_receipt_id from supplier_invoice where id=$1",[supplierInvoice])).rows[0];
  assert.equal(invoice.status,"posted"); assert.equal(invoice.amount,"80.00"); assert.equal(invoice.inventory_receipt_id,receipt);
  assert.equal(await balance(client,ap),"80.00"); assert.equal(await balance(client,inventoryAsset),"80.00");
  let stock=(await client.query("select quantity_on_hand::text q,inventory_value::text v,average_unit_cost::text a from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.deepEqual(stock,{q:"20.000",v:"80.00",a:"4.0000"});

  const usage=(await client.query(`insert into inventory_adjustment(adjustment_number,ingredient_id,adjustment_kind,quantity,occurred_on,currency,reason) values ($1,$2,'usage',5,'2026-10-10','USD','Release 2 kitchen usage') returning id`,["R2-USE-"+suffix,rice])).rows[0].id;
  await client.query("select post_inventory_adjustment($1,null)",[usage]);
  stock=(await client.query("select quantity_on_hand::text q,inventory_value::text v,low_stock from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.deepEqual(stock,{q:"15.000",v:"60.00",low_stock:true});
  assert.equal(await balance(client,inventoryAsset),"60.00"); assert.equal(await balance(client,foodExpense),"20.00");

  await client.query("select * from refresh_system_notifications('2026-10-10'::date,null)");
  assert.equal((await client.query("select status from system_notification where rule_key='low_food_inventory' and source_id=$1",[rice])).rows[0]?.status,"open","Real inventory low stock must create a notification");
  assert.equal((await client.query("select status from system_notification where rule_key='supplier_payment_due' and source_id=$1",[supplierInvoice])).rows[0]?.status,"open","Inventory supplier payable must create due notification");

  const supplierPayment=(await client.query(`insert into supplier_payment(supplier_payment_number,supplier_id,supplier_invoice_id,payment_account_id,amount,currency,paid_on,method) values ($1,$2,$3,$4,80,'USD','2026-10-11','bank_transfer') returning id`,["R2-SPAY-"+suffix,supplier,supplierInvoice,bank])).rows[0].id;
  await client.query("select accounting_post_supplier_payment($1,null)",[supplierPayment]);
  assert.equal((await client.query("select balance_amount::text v from supplier_invoice_balance where id=$1",[supplierInvoice])).rows[0].v,"0.00");
  assert.equal(await balance(client,ap),"0.00"); assert.equal(await balance(client,bank),"50.00");
  await client.query("select * from refresh_system_notifications('2026-10-11'::date,null)");
  assert.equal((await client.query("select status from system_notification where rule_key='supplier_payment_due' and source_id=$1",[supplierInvoice])).rows[0]?.status,"resolved");
  const statement=await client.query("select entry_type,running_payable_balance::text b from supplier_statement where supplier_id=$1 order by entry_date,occurred_at,source_id",[supplier]);
  const kinds=new Set(statement.rows.map(r=>r.entry_type)); assert.ok(kinds.has("invoice")&&kinds.has("payment")); assert.equal(statement.rows.at(-1)?.b,"0.00");
  console.log("Food purchase -> supplier -> inventory -> expense/asset -> accounting path passed.");

  const beans=(await client.query(`insert into ingredient(code,name,unit_id,reorder_level,status) values ($1,'Release 2 Beans',$2,0,'active') returning id`,["R2-BEANS-"+suffix,kg])).rows[0].id;
  const racePo=(await client.query(`insert into food_purchase_order(order_number,supplier_id,ordered_on,currency,status) values ($1,$2,'2026-10-12','USD','draft') returning id`,["R2-RACE-PO-"+suffix,supplier])).rows[0].id;
  await client.query("insert into food_purchase_order_line(purchase_order_id,ingredient_id,quantity_ordered,unit_cost) values ($1,$2,10,1)",[racePo,beans]);
  await client.query("select submit_food_purchase_order($1,null)",[racePo]);
  async function draft(number){const id=(await client.query(`insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,received_on,currency) values ($1,$2,$3,'2026-10-12','USD') returning id`,[number,supplier,racePo])).rows[0].id; await client.query("insert into inventory_receipt_line(inventory_receipt_id,ingredient_id,quantity_received,unit_cost) values ($1,$2,6,1)",[id,beans]); return id;}
  const r1=await draft("R2-RACE-RCV-1-"+suffix),r2=await draft("R2-RACE-RCV-2-"+suffix);
  const e1=await pool.connect(),e2=await pool.connect(); let raceInvoice;
  try{
    await e1.query("begin"); raceInvoice=(await e1.query("select post_inventory_receipt($1,null) id",[r1])).rows[0].id;
    await e2.query("begin"); const second=e2.query("select post_inventory_receipt($1,null) id",[r2]).then(()=>true).catch(()=>false);
    await new Promise(r=>setTimeout(r,100)); await e1.query("commit");
    assert.equal(await second,false,"Concurrent receipts must not over-receive one purchase order"); await e2.query("rollback");
  }finally{e1.release();e2.release();}
  assert.equal((await client.query("select status from inventory_receipt where id=$1",[r1])).rows[0].status,"posted");
  assert.equal((await client.query("select status from inventory_receipt where id=$1",[r2])).rows[0].status,"draft");
  await client.query("select reverse_inventory_receipt($1,'2026-10-13',null,'Release 2 concurrent receipt cleanup')",[r1]);
  assert.equal((await client.query("select status from supplier_invoice where id=$1",[raceInvoice])).rows[0].status,"reversed");
  assert.equal((await client.query("select quantity_on_hand::text q from ingredient_inventory_balance where ingredient_id=$1",[beans])).rows[0].q,"0.000");
  console.log("Concurrent purchase-order receipt protection passed.");
  return {rice,supplierInvoice};
}
