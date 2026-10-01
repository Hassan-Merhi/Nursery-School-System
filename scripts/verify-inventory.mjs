import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool }=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new Pool({connectionString});
const client=await pool.connect();

async function expectFailure(label,work){
  const savepoint="sp_"+Math.random().toString(16).slice(2);
  await client.query("savepoint "+savepoint);
  let failed=false;
  try{await work();}catch{failed=true;await client.query("rollback to savepoint "+savepoint);}
  assert.equal(failed,true,label);
}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8);

  const requiredPermissions=["inventory.view","inventory.manage","inventory.purchase","inventory.post","inventory.adjust"];
  const adminPermissions=await client.query("select rp.permission_key from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key=any($1::text[])",[requiredPermissions]);
  assert.equal(adminPermissions.rowCount,requiredPermissions.length,"Administrator must receive every Step 11 permission");

  const types=(await client.query("select id,category from account_type")).rows;
  const type=Object.fromEntries(types.map((r)=>[r.category,r.id]));
  async function account(code,name,category){
    const r=await client.query("insert into account(code,name,account_type_id,currency) values ($1,$2,$3,'USD') returning id",[code+"-"+suffix,name,type[category]]);
    return r.rows[0].id;
  }

  const inventoryAsset=await account("CI-INV","CI Food Inventory","asset");
  const alternateInventoryAsset=await account("CI-INV-ALT","CI Alternate Food Inventory","asset");
  const foodExpense=await account("CI-FOOD-COST","CI Food Program Expense","expense");
  const ap=await account("CI-AP","CI Accounts Payable","liability");
  const ar=await account("CI-AR","CI Accounts Receivable","asset");
  const foodIncome=await account("CI-FOOD-INCOME","CI Food Income","income");
  const cash=await account("CI-CASH","CI Cash","asset");
  const deposits=await account("CI-DEP","CI Customer Deposits","liability");

  const operationsJournal=(await client.query("insert into journal(code,name) values ($1,'CI Inventory Operations') returning id",["CIIO-"+suffix])).rows[0].id;
  const billingJournal=(await client.query("insert into journal(code,name) values ($1,'CI Inventory Food Billing') returning id",["CIIF-"+suffix])).rows[0].id;
  await client.query("update accounting_configuration set operations_journal_id=$1,billing_journal_id=$2 where id=1",[operationsJournal,billingJournal]);
  for(const [roleKey,accountId] of Object.entries({
    inventory_asset:inventoryAsset,
    food_program_expense:foodExpense,
    accounts_payable:ap,
    accounts_receivable:ar,
    food_income:foodIncome,
    payment_asset:cash,
    customer_deposits:deposits,
  })){
    await client.query("insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict (role_key) do update set account_id=excluded.account_id",[roleKey,accountId]);
  }
  await client.query("insert into accounting_period(name,starts_on,ends_on,status) values ($1,'2026-10-01','2026-10-31','open')",["CI Inventory Oct "+suffix]);

  const supplier=(await client.query("insert into supplier(supplier_number,name,payment_terms_days,status) values ($1,'CI Food Supplier',14,'active') returning id",["SUP-"+suffix])).rows[0].id;
  const kg=(await client.query("select id from inventory_unit where code='KG'")).rows[0].id;
  const customUnit=(await client.query("insert into inventory_unit(code,name,decimal_places) values ($1,'CI Crate',0) returning id",["CRATE-"+suffix])).rows[0].id;
  assert.ok(customUnit,"Custom inventory units must be supported");
  const rice=(await client.query("insert into ingredient(code,name,unit_id,reorder_level,status) values ($1,'CI Rice',$2,10,'active') returning id",["RICE-"+suffix,kg])).rows[0].id;

  await expectFailure("Normal supplier invoices must still reject asset accounts",()=>client.query(
    "insert into supplier_invoice(supplier_invoice_number,supplier_id,expense_account_id,amount,currency,invoice_date,due_on) values ($1,$2,$3,10,'USD','2026-10-01','2026-10-01')",
    ["BAD-ASSET-"+suffix,supplier,inventoryAsset],
  ));

  const po=(await client.query("insert into food_purchase_order(order_number,supplier_id,ordered_on,expected_on,currency,status) values ($1,$2,'2026-10-01','2026-10-03','USD','draft') returning id",["PO-"+suffix,supplier])).rows[0].id;
  await client.query("insert into food_purchase_order_line(purchase_order_id,ingredient_id,quantity_ordered,unit_cost) values ($1,$2,50,2)",[po,rice]);
  await client.query("select submit_food_purchase_order($1,null)",[po]);
  assert.equal((await client.query("select status from food_purchase_order where id=$1",[po])).rows[0].status,"ordered");
  await expectFailure("Ordered PO lines must be immutable",()=>client.query("update food_purchase_order_line set quantity_ordered=55 where purchase_order_id=$1",[po]));
  await expectFailure("Receipt date cannot precede its purchase order",()=>client.query(
    "insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,received_on,currency) values ($1,$2,$3,'2026-09-30','USD')",
    ["EARLY-"+suffix,supplier,po],
  ));

  async function createReceipt(number,quantity,cost,date="2026-10-02",purchaseOrder=po,ingredient=rice){
    const receipt=(await client.query("insert into inventory_receipt(receipt_number,supplier_id,purchase_order_id,received_on,currency) values ($1,$2,$3,$4,'USD') returning id",[number,supplier,purchaseOrder,date])).rows[0].id;
    await client.query("insert into inventory_receipt_line(inventory_receipt_id,ingredient_id,quantity_received,unit_cost) values ($1,$2,$3,$4)",[receipt,ingredient,quantity,cost]);
    return receipt;
  }

  const receipt1=await createReceipt("RCV1-"+suffix,20,2);
  const invoice1=(await client.query("select post_inventory_receipt($1,null) as id",[receipt1])).rows[0].id;
  let stock=(await client.query("select quantity_on_hand::text,inventory_value::text,average_unit_cost::text from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.equal(stock.quantity_on_hand,"20.000");
  assert.equal(stock.inventory_value,"40.00");
  assert.equal(stock.average_unit_cost,"2.0000");
  assert.equal((await client.query("select status from food_purchase_order where id=$1",[po])).rows[0].status,"partially_received");
  await expectFailure("Inventory Asset mapping cannot change while stock is on hand",()=>client.query(
    "update accounting_mapping set account_id=$1 where role_key='inventory_asset'",
    [alternateInventoryAsset],
  ));

  const invoiceRow=(await client.query("select status,amount::text,inventory_receipt_id from supplier_invoice where id=$1",[invoice1])).rows[0];
  assert.equal(invoiceRow.status,"posted");
  assert.equal(invoiceRow.amount,"40.00");
  assert.equal(invoiceRow.inventory_receipt_id,receipt1);
  const receiptJournal=(await client.query("select sum(jl.debit)::text as debit,sum(jl.credit)::text as credit from journal_entry je join journal_line jl on jl.journal_entry_id=je.id where je.source_type='supplier_invoice' and je.source_id=$1 and je.status='posted'",[invoice1])).rows[0];
  assert.equal(receiptJournal.debit,"40.00");
  assert.equal(receiptJournal.credit,"40.00");
  await expectFailure("Inventory supplier invoice cannot be reversed directly",()=>client.query("update supplier_invoice set status='reversed' where id=$1",[invoice1]));
  await expectFailure("Inventory supplier credit must use a future stock-return workflow",()=>client.query("insert into supplier_credit(supplier_credit_number,supplier_id,supplier_invoice_id,expense_account_id,amount,currency,credited_on,reason) values ($1,$2,$3,$4,1,'USD','2026-10-03','Bad direct inventory credit')",["CR-"+suffix,supplier,invoice1,foodExpense]));

  await expectFailure("Receipt cannot exceed outstanding PO quantity",async()=>{
    const bad=await createReceipt("BADRCV-"+suffix,31,3,"2026-10-03");
    await client.query("select post_inventory_receipt($1,null)",[bad]);
  });

  const receipt2=await createReceipt("RCV2-"+suffix,30,3,"2026-10-03");
  await client.query("select post_inventory_receipt($1,null)",[receipt2]);
  stock=(await client.query("select quantity_on_hand::text,inventory_value::text,average_unit_cost::text from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.equal(stock.quantity_on_hand,"50.000");
  assert.equal(stock.inventory_value,"130.00");
  assert.equal(stock.average_unit_cost,"2.6000","Moving-average cost must be $2.60 after mixed-cost receipts");
  assert.equal((await client.query("select status from food_purchase_order where id=$1",[po])).rows[0].status,"received");

  async function postAdjustment(kind,quantity,reason,cost=null,date="2026-10-10"){
    const number="ADJ-"+kind+"-"+randomUUID();
    const r=(await client.query("insert into inventory_adjustment(adjustment_number,ingredient_id,adjustment_kind,quantity,unit_cost_override,occurred_on,currency,reason) values ($1,$2,$3,$4,$5,$6,'USD',$7) returning id",[number,rice,kind,quantity,cost,date,reason])).rows[0].id;
    await client.query("select post_inventory_adjustment($1,null)",[r]);
    return r;
  }

  const reversibleWaste=await postAdjustment("waste",1,"CI reversible waste",null,"2026-10-04");
  await client.query("select reverse_inventory_adjustment($1,'2026-10-05',null,'CI correction')",[reversibleWaste]);
  stock=(await client.query("select quantity_on_hand::text,inventory_value::text from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.equal(stock.quantity_on_hand,"50.000");
  assert.equal(stock.inventory_value,"130.00","Adjustment reversal must restore stock value");

  await postAdjustment("usage",10,"Kitchen lunch usage",null,"2026-10-10");
  await postAdjustment("waste",5,"Preparation waste",null,"2026-10-11");
  await postAdjustment("spoilage",1,"Expired stock",null,"2026-10-12");
  await postAdjustment("correction_out",25,"Stock count shortage",null,"2026-10-13");
  await postAdjustment("correction_in",1,"Stock count found item",4,"2026-10-14");

  stock=(await client.query("select quantity_on_hand::text,inventory_value::text,average_unit_cost::text,low_stock from ingredient_inventory_balance where ingredient_id=$1",[rice])).rows[0];
  assert.equal(stock.quantity_on_hand,"10.000");
  assert.equal(stock.inventory_value,"27.40");
  assert.equal(stock.average_unit_cost,"2.7400");
  assert.equal(stock.low_stock,true,"Stock at the reorder threshold must appear as low stock");
  assert.equal((await client.query("select count(*)::int as count from low_stock_alert where ingredient_id=$1",[rice])).rows[0].count,1);
  await expectFailure("Stock adjustments cannot make inventory negative",async()=>{
    const n="NEG-"+randomUUID();
    const a=(await client.query("insert into inventory_adjustment(adjustment_number,ingredient_id,adjustment_kind,quantity,occurred_on,currency,reason) values ($1,$2,'usage',11,'2026-10-15','USD','Too much') returning id",[n,rice])).rows[0].id;
    await client.query("select post_inventory_adjustment($1,null)",[a]);
  });
  await expectFailure("Posted inventory movements must be immutable",()=>client.query("update inventory_movement set quantity_delta=999 where ingredient_id=$1",[rice]));
  await expectFailure("Receipt reversal must fail after received stock has been consumed",()=>client.query("select reverse_inventory_receipt($1,'2026-10-16',null,'Too late')",[receipt2]));

  // A separate receipt can be safely reversed before its stock is consumed.
  const sugar=(await client.query("insert into ingredient(code,name,unit_id,reorder_level,status) values ($1,'CI Sugar',$2,0,'active') returning id",["SUGAR-"+suffix,kg])).rows[0].id;
  const sugarReceipt=await createReceipt("SUGAR-RCV-"+suffix,5,1,"2026-10-06",null,sugar);
  const sugarInvoice=(await client.query("select post_inventory_receipt($1,null) as id",[sugarReceipt])).rows[0].id;
  await client.query("select reverse_inventory_receipt($1,'2026-10-07',null,'Supplier delivery returned')",[sugarReceipt]);
  assert.equal((await client.query("select quantity_on_hand::text from ingredient_inventory_balance where ingredient_id=$1",[sugar])).rows[0].quantity_on_hand,"0.000");
  assert.equal((await client.query("select status from supplier_invoice where id=$1",[sugarInvoice])).rows[0].status,"reversed");

  // Step 10 income must appear beside Step 11 cost without recipe-level consumption assumptions.
  const family=(await client.query("insert into family(display_name) values ('CI Inventory Food Family') returning id")).rows[0].id;
  const student=(await client.query("insert into student(family_id,first_name,last_name,date_of_birth,status) values ($1,'Inventory','Student','2022-01-01','active') returning id",[family])).rows[0].id;
  const year=(await client.query("insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','planned') returning id",["CI-INV-"+suffix])).rows[0].id;
  const term=(await client.query("insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'September–December','2026-09-01','2026-12-31') returning id",[year])).rows[0].id;
  const klass=(await client.query("insert into school_class(school_year_id,name,status) values ($1,$2,'active') returning id",[year,"CI Inventory Class "+suffix])).rows[0].id;
  const enrollment=(await client.query("insert into student_enrollment(student_id,school_year_id,class_id,starts_on) values ($1,$2,$3,'2026-09-01') returning id",[student,year,klass])).rows[0].id;
  await client.query("insert into student_term_enrollment(enrollment_id,school_year_id,term_id,starts_on,ends_on) values ($1,$2,$3,'2026-09-01','2026-12-31')",[enrollment,year,term]);
  const foodItem=(await client.query("insert into food_item(code,name,status) values ($1,'CI Inventory Lunch','active') returning id",["INV-LUNCH-"+suffix])).rows[0].id;
  const foodPackage=(await client.query("insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency,status) values ($1,$2,$3,'CI Inventory Monthly Lunch','monthly',150,'USD','draft') returning id",[year,term,"INV-PKG-"+suffix])).rows[0].id;
  await client.query("insert into food_package_item(food_package_id,food_item_id,quantity) values ($1,$2,1)",[foodPackage,foodItem]);
  await client.query("update food_package set status='active' where id=$1",[foodPackage]);
  const selection=(await client.query("insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on) values ($1,$2,$3,$4,$5,150,'USD',1,'2026-10-01','2026-10-31') returning id",[family,student,year,term,foodPackage])).rows[0].id;
  const bill=(await client.query("insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency) values ($1,$2,$3,$4,$5,$6,$7,'2026-10-01','2026-10-31','2026-10-05','USD') returning id",["INV-FOOD-"+suffix,family,student,year,term,foodPackage,selection])).rows[0].id;
  await client.query("insert into food_bill_line(food_bill_id,description,package_kind,quantity,unit_price) values ($1,'CI monthly food package','monthly',1,150)",[bill]);
  await client.query("select issue_food_bill($1,'2026-10-01',null)",[bill]);

  const summary=(await client.query("select * from food_program_month_summary where month_start='2026-10-01' and currency='USD'")).rows[0];
  assert.equal(summary.purchased_amount,"130.00","How much food Montikids bought this month must be directly reportable");
  assert.equal(summary.food_income,"150.00","Food package income must be directly reportable");
  assert.equal(summary.recognized_food_cost,"102.60","Usage, waste, spoilage and net corrections must drive rough food cost");
  assert.equal(summary.rough_food_margin,"47.40","Rough food margin must compare food income with recognized inventory cost");

  const valuation=(await client.query("select sum(inventory_value)::numeric(14,2)::text as value from ingredient_inventory_balance")).rows[0].value;
  assert.equal(valuation,"27.40","Current stock valuation must remain after receipt reversal and usage");

  const apBalance=(await client.query("select normal_balance::text from account_balance where account_id=$1",[ap])).rows[0].normal_balance;
  assert.equal(apBalance,"130.00","Posted, unreversed inventory receipts must remain in Accounts Payable");
  const inventoryLedger=(await client.query("select normal_balance::text from account_balance where account_id=$1",[inventoryAsset])).rows[0].normal_balance;
  assert.equal(inventoryLedger,"27.40","Inventory subledger valuation must reconcile to the Inventory Asset account");
  const expenseLedger=(await client.query("select normal_balance::text from account_balance where account_id=$1",[foodExpense])).rows[0].normal_balance;
  assert.equal(expenseLedger,"102.60","Recognized inventory cost must reconcile to Food Program Expense");

  const trial=await client.query("select sum(debit_balance)::text as debit,sum(credit_balance)::text as credit from report_trial_balance('2026-10-31') where currency='USD'");
  assert.equal(trial.rows[0].debit,trial.rows[0].credit,"Trial balance must remain balanced with Step 11 activity");

  console.log("Step 11 food inventory verification passed.");
  console.log("Covered: ingredients/units, POs, partial/full receiving, moving-average valuation, supplier payables, low-stock alerts, usage/waste/spoilage, corrections, reversals, negative-stock protection, food income/cost summary, inventory/AP/expense reconciliation and balanced trial balance.");
  await client.query("rollback");
}finally{
  client.release();
  await pool.end();
}