"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE=/^\d+(?:\.\d{1,2})?$/;
const QTY_RE=/^\d+(?:\.\d{1,2})?$/;
const KINDS=new Set(["daily","weekly","monthly","term"]);
const METHODS=new Set(["cash","card","bank_transfer","check","other"]);

function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function familyHubReturn(d:FormData){
  const raw=v(d,"return_to");
  return /^\/students\/families\/[0-9a-f-]{36}$/i.test(raw)?raw:null;
}
function bad(m:string):never{redirect("/food?error="+encodeURIComponent(m));}
function good(m:string):never{
  revalidatePath("/food"); revalidatePath("/billing"); revalidatePath("/accounting");
  revalidatePath("/reports"); revalidatePath("/dashboard");
  redirect("/food?success="+encodeURIComponent(m));
}
function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");return raw;}
function optionalDay(raw:string,label:string){return raw?day(raw,label):null;}
function amt(raw:string,label:string){
  if(!MONEY_RE.test(raw))bad("Enter a valid "+label+" with at most two decimals.");
  const n=Number(raw); if(!Number.isFinite(n)||n<=0||n>999999999.99)bad(label+" must be greater than zero.");
  return n.toFixed(2);
}
function qty(raw:string,label:string){
  if(!QTY_RE.test(raw))bad("Enter a valid "+label+" with at most two decimals.");
  const n=Number(raw); if(!Number.isFinite(n)||n<=0||n>99999)bad(label+" must be greater than zero.");
  return n;
}
function cur(raw:string){const c=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(c))bad("Currency must be a three-letter code.");return c;}
function code(raw:string,label:string){
  const x=raw.trim().toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(x))bad(label+" must be 2–30 characters using letters, numbers, hyphens or underscores.");
  return x;
}
async function nextNo(c:PoolClient,t:string,u:string){
  const r=await c.query<{prefix:string;number:string}>("update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text as number",[t,u]);
  if(!r.rows[0])bad("Document sequence "+t+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}

export async function configureFoodIncomeMappingAction(d:FormData){
  const a=await requirePermission("accounting.mapping");
  const account=id(v(d,"account_id"),"income account");
  await withTransaction(async c=>{
    const before=(await c.query("select role_key,account_id from accounting_mapping where role_key='food_income' for update")).rows[0]??null;
    await c.query("insert into accounting_mapping(role_key,account_id,updated_by) values ('food_income',$1,$2) on conflict (role_key) do update set account_id=excluded.account_id,updated_at=now(),updated_by=excluded.updated_by",[account,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_income_mapping_updated",entityType:"accounting_mapping",entityId:"food_income",before,after:{roleKey:"food_income",accountId:account}});
  });
  good("Food income accounting mapping saved.");
}

export async function createFoodItemAction(d:FormData){
  const a=await requirePermission("food.manage");
  const itemCode=code(v(d,"code"),"Item code"),name=v(d,"name");
  if(!name)bad("Food item name is required.");
  await withTransaction(async c=>{
    const r=await c.query<{id:string}>("insert into food_item(code,name,description,created_by,updated_by) values ($1,$2,$3,$4,$4) returning id",[itemCode,name,v(d,"description")||null,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_item_created",entityType:"food_item",entityId:r.rows[0].id,after:{code:itemCode,name}});
  });
  good("Food item created.");
}

export async function setFoodItemStatusAction(d:FormData){
  const a=await requirePermission("food.manage");
  const item=id(v(d,"food_item_id"),"food item"),status=v(d,"status");
  if(!["active","inactive"].includes(status))bad("Invalid food item status.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from food_item where id=$1 for update",[item])).rows[0];
    if(!before)bad("Food item not found.");
    await c.query("update food_item set status=$2,updated_at=now(),updated_by=$3 where id=$1",[item,status,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_item_status_changed",entityType:"food_item",entityId:item,before,after:{...before,status}});
  });
  good("Food item status updated.");
}

export async function addFoodItemPriceAction(d:FormData){
  const a=await requirePermission("food.manage");
  const item=id(v(d,"food_item_id"),"food item"),amount=amt(v(d,"amount"),"price"),currency=cur(v(d,"currency"));
  const from=day(v(d,"effective_from"),"effective date"),to=optionalDay(v(d,"effective_to"),"price end date");
  if(to&&to<from)bad("Price end date cannot be before its start date.");
  await withTransaction(async c=>{
    if(!(await c.query("select 1 from food_item where id=$1",[item])).rowCount)bad("Food item not found.");
    const r=await c.query<{id:string}>("insert into food_item_price(food_item_id,amount,currency,effective_from,effective_to,created_by) values ($1,$2,$3,$4,$5,$6) returning id",[item,amount,currency,from,to,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_item_price_created",entityType:"food_item_price",entityId:r.rows[0].id,after:{foodItemId:item,amount,currency,effectiveFrom:from,effectiveTo:to}});
  });
  good("Food item price added.");
}

export async function createFoodPackageAction(d:FormData){
  const a=await requirePermission("food.manage");
  const term=id(v(d,"term_id"),"school term"),packageCode=code(v(d,"code"),"Package code"),name=v(d,"name");
  if(!name)bad("Package name is required.");
  const kind=v(d,"package_kind"); if(!KINDS.has(kind))bad("Invalid package type.");
  const price=amt(v(d,"package_price"),"package price"),currency=cur(v(d,"currency"));
  const from=optionalDay(v(d,"available_from"),"available-from date"),to=optionalDay(v(d,"available_to"),"available-to date");
  if(from&&to&&to<from)bad("Package availability end cannot be before its start.");
  await withTransaction(async c=>{
    const t=(await c.query<{school_year_id:string;starts_on:string;ends_on:string;status:string;year_status:string}>("select t.school_year_id,t.starts_on::text,t.ends_on::text,t.status,y.status as year_status from school_term t join school_year y on y.id=t.school_year_id where t.id=$1",[term])).rows[0];
    if(!t)bad("School term not found.");
    if(t.status==="closed"||t.year_status==="closed")bad("Closed terms cannot accept new food packages.");
    if(from&&from<t.starts_on)bad("Package availability cannot start before the school term.");
    if(to&&to>t.ends_on)bad("Package availability cannot end after the school term.");
    const r=await c.query<{id:string}>("insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency,available_from,available_to,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id",[t.school_year_id,term,packageCode,name,kind,price,currency,from,to,v(d,"notes")||null,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_package_created",entityType:"food_package",entityId:r.rows[0].id,after:{code:packageCode,name,kind,price,currency,termId:term}});
  });
  good("Food package created as draft.");
}

export async function addFoodPackageItemAction(d:FormData){
  const a=await requirePermission("food.manage");
  const pack=id(v(d,"food_package_id"),"food package"),item=id(v(d,"food_item_id"),"food item"),quantity=qty(v(d,"quantity"),"item quantity");
  await withTransaction(async c=>{
    await c.query("insert into food_package_item(food_package_id,food_item_id,quantity,created_by) values ($1,$2,$3,$4) on conflict (food_package_id,food_item_id) do update set quantity=excluded.quantity",[pack,item,quantity,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_package_item_saved",entityType:"food_package",entityId:pack,after:{foodItemId:item,quantity}});
  });
  good("Package item saved.");
}

export async function removeFoodPackageItemAction(d:FormData){
  const a=await requirePermission("food.manage");
  const pack=id(v(d,"food_package_id"),"food package"),item=id(v(d,"food_item_id"),"food item");
  await withTransaction(async c=>{
    await c.query("delete from food_package_item where food_package_id=$1 and food_item_id=$2",[pack,item]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_package_item_removed",entityType:"food_package",entityId:pack,after:{foodItemId:item}});
  });
  good("Package item removed.");
}

export async function activateFoodPackageAction(d:FormData){
  const a=await requirePermission("food.manage");
  const pack=id(v(d,"food_package_id"),"food package");
  await withTransaction(async c=>{
    const before=(await c.query("select * from food_package where id=$1 for update",[pack])).rows[0];
    if(!before||before.status!=="draft")bad("Only draft food packages can be activated.");
    await c.query("update food_package set status='active',activated_by=$2,updated_at=now(),updated_by=$2 where id=$1",[pack,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_package_activated",entityType:"food_package",entityId:pack,before,after:{...before,status:"active"}});
  });
  good("Food package activated.");
}

export async function archiveFoodPackageAction(d:FormData){
  const a=await requirePermission("food.manage");
  const pack=id(v(d,"food_package_id"),"food package");
  await withTransaction(async c=>{
    const before=(await c.query("select * from food_package where id=$1 for update",[pack])).rows[0];
    if(!before)bad("Food package not found.");
    if(before.status==="draft")bad("Only activated packages need archiving.");
    await c.query("update food_package set status='archived',updated_at=now(),updated_by=$2 where id=$1",[pack,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_package_archived",entityType:"food_package",entityId:pack,before,after:{...before,status:"archived"}});
  });
  good("Food package archived. Existing selections and bills remain intact.");
}

export async function createFoodSelectionAction(d:FormData){
  const a=await requirePermission("food.manage");
  const student=id(v(d,"student_id"),"student"),pack=id(v(d,"food_package_id"),"food package");
  const start=day(v(d,"starts_on"),"selection start date"),end=day(v(d,"ends_on"),"selection end date");
  if(end<start)bad("Selection end date cannot be before its start.");
  const quantity=qty(v(d,"quantity")||"1","selection quantity");
  await withTransaction(async c=>{
    const r=await c.query<{id:string}>("insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on,notes,created_by) select s.family_id,$1,p.school_year_id,p.term_id,p.id,p.package_price,p.currency,$3,$4,$5,$6,$7 from student s cross join food_package p where s.id=$1 and p.id=$2 returning id",[student,pack,quantity,start,end,v(d,"notes")||null,a.userId]);
    if(!r.rows[0])bad("Student or package not found.");
    await writeAudit(c,{actorUserId:a.userId,action:"student_food_selected",entityType:"student_food_selection",entityId:r.rows[0].id,after:{studentId:student,foodPackageId:pack,startsOn:start,endsOn:end,quantity}});
  });
  const returnTo=familyHubReturn(d);
  if(returnTo){
    revalidatePath(returnTo);
    redirect(returnTo+"?success="+encodeURIComponent("Student food selection created with the package price snapshotted.")+"#food");
  }
  good("Student food selection created with the package price snapshotted.");
}

export async function closeFoodSelectionAction(d:FormData){
  const a=await requirePermission("food.manage");
  const selection=id(v(d,"student_food_selection_id"),"food selection"),status=v(d,"status");
  if(!["ended","cancelled"].includes(status))bad("Invalid selection close status.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from student_food_selection where id=$1 for update",[selection])).rows[0];
    if(!before||before.status!=="active")bad("Only active food selections can be ended or cancelled.");
    await c.query("update student_food_selection set status=$2,ended_at=now(),ended_by=$3 where id=$1",[selection,status,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:status==="cancelled"?"student_food_selection_cancelled":"student_food_selection_ended",entityType:"student_food_selection",entityId:selection,before,after:{...before,status}});
  });
  const returnTo=familyHubReturn(d);
  if(returnTo){
    const message=status==="cancelled"?"Food selection cancelled.":"Food selection ended.";
    revalidatePath(returnTo);
    redirect(returnTo+"?success="+encodeURIComponent(message)+"#food");
  }
  good(status==="cancelled"?"Food selection cancelled.":"Food selection ended.");
}

export async function createFoodBillAction(d:FormData){
  const a=await requirePermission("food.billing");
  const selection=id(v(d,"student_food_selection_id"),"food selection");
  const start=day(v(d,"period_start"),"billing period start"),end=day(v(d,"period_end"),"billing period end"),due=day(v(d,"due_on"),"due date");
  if(end<start)bad("Billing period end cannot be before its start.");
  const units=qty(v(d,"units"),"billing units");
  await withTransaction(async c=>{
    const s=(await c.query<any>("select s.*,p.name as package_name,p.package_kind from student_food_selection s join food_package p on p.id=s.food_package_id where s.id=$1 for update of s",[selection])).rows[0];
    if(!s||s.status==="cancelled")bad("Food selection is unavailable.");
    if(start<s.starts_on||end>s.ends_on)bad("Billing period must stay inside the selection dates.");
    if(s.package_kind==="term"&&Math.abs(units-1)>0.0001)bad("Term packages bill exactly one unit.");
    const number=await nextNo(c,"food_bill",a.userId);
    const b=await c.query<{id:string}>("insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) returning id",[number,s.family_id,s.student_id,s.school_year_id,s.term_id,s.food_package_id,selection,start,end,due,s.currency,v(d,"notes")||null,a.userId]);
    const billId=b.rows[0].id,billedQuantity=Number((units*Number(s.quantity)).toFixed(2));
    await c.query("insert into food_bill_line(food_bill_id,description,package_kind,quantity,unit_price,created_by) values ($1,$2,$3,$4,$5,$6)",[billId,s.package_name,s.package_kind,billedQuantity,s.unit_price,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_bill_created",entityType:"food_bill",entityId:billId,after:{billNumber:number,selectionId:selection,periodStart:start,periodEnd:end,units,billedQuantity,unitPrice:s.unit_price}});
  });
  good("Draft food bill created.");
}

export async function issueFoodBillAction(d:FormData){
  const a=await requirePermission("food.billing");
  const bill=id(v(d,"food_bill_id"),"food bill"),issuedOn=day(v(d,"issued_on"),"issue date");
  await withTransaction(async c=>{
    const before=(await c.query("select * from food_bill where id=$1 for update",[bill])).rows[0];
    if(!before||before.status!=="draft")bad("Only draft food bills can be issued.");
    await c.query("select issue_food_bill($1,$2,$3)",[bill,issuedOn,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_bill_issued",entityType:"food_bill",entityId:bill,before,after:{...before,status:"issued",issuedOn}});
  });
  good("Food bill issued and posted to Accounts Receivable and Food Income.");
}

export async function voidFoodBillAction(d:FormData){
  const a=await requirePermission("food.billing");
  const bill=id(v(d,"food_bill_id"),"food bill"),reversalDate=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");
  if(!reason)bad("Void reason is required.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from food_bill where id=$1 for update",[bill])).rows[0];
    if(!before)bad("Food bill not found.");
    await c.query("select void_food_bill($1,$2,$3,$4)",[bill,reversalDate,a.userId,reason]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_bill_voided",entityType:"food_bill",entityId:bill,before,after:{...before,status:"void",reason,reversalDate}});
  });
  good("Food bill voided with an accounting reversal.");
}

export async function recordFoodPaymentAction(d:FormData){
  const a=await requirePermission("food.payments");
  const bill=id(v(d,"food_bill_id"),"food bill"),amount=amt(v(d,"amount"),"payment amount"),receivedOn=day(v(d,"received_on"),"payment date");
  const method=v(d,"method"); if(!METHODS.has(method))bad("Invalid payment method.");
  const cheque=v(d,"cheque_number"); if(method==="check"&&!cheque)bad("Cheque number is required.");
  const paymentAccountRaw=v(d,"payment_account_id"),paymentAccount=paymentAccountRaw?id(paymentAccountRaw,"payment account"):null;
  await withTransaction(async c=>{
    await c.query("select id from food_bill where id=$1 for update",[bill]);
    const b=(await c.query<any>("select * from food_bill_balance where id=$1",[bill])).rows[0];
    if(!b||!["issued","partially_paid"].includes(b.status))bad("Choose an issued food bill with an open balance.");
    if(Number(amount)>Number(b.balance_amount))bad("Payment cannot exceed the food bill balance.");
    const receipt=await nextNo(c,"receipt",a.userId);
    const p=await c.query<{id:string}>("insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id,cheque_number,cheque_due_on,reference,notes,created_by) values ($1,$2,$3,'payment',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",[receipt,b.family_id,b.student_id,amount,b.currency,receivedOn,method,paymentAccount,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,v(d,"notes")||"Food payment",a.userId]);
    const paymentId=p.rows[0].id;
    await c.query("select accounting_post_payment($1,$2)",[paymentId,a.userId]);
    const allocation=await c.query<{id:string}>("insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on,created_by) values ($1,$2,$3,$4,$5) returning id",[paymentId,bill,amount,receivedOn,a.userId]);
    await c.query("select accounting_post_food_payment_allocation($1,$2)",[allocation.rows[0].id,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_payment_recorded",entityType:"payment",entityId:paymentId,after:{receiptNumber:receipt,foodBillId:bill,amount,currency:b.currency,receivedOn}});
  });
  good("Food payment recorded, allocated and posted. The normal payment receipt is available.");
}

export async function allocateFoodPaymentAction(d:FormData){
  const a=await requirePermission("food.payments");
  const bill=id(v(d,"food_bill_id"),"food bill"),payment=id(v(d,"payment_id"),"payment");
  const amount=amt(v(d,"amount"),"allocation amount"),allocatedOn=day(v(d,"allocated_on"),"allocation date");
  await withTransaction(async c=>{
    const r=await c.query<{id:string}>("insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on,created_by) values ($1,$2,$3,$4,$5) returning id",[payment,bill,amount,allocatedOn,a.userId]);
    await c.query("select accounting_post_food_payment_allocation($1,$2)",[r.rows[0].id,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_payment_allocated",entityType:"food_payment_allocation",entityId:r.rows[0].id,after:{paymentId:payment,foodBillId:bill,amount,allocatedOn}});
  });
  good("Existing parent payment/prepayment allocated to the food bill.");
}

export async function allocateFoodCreditAction(d:FormData){
  const a=await requirePermission("food.payments");
  const bill=id(v(d,"food_bill_id"),"food bill"),credit=id(v(d,"credit_note_id"),"credit note");
  const amount=amt(v(d,"amount"),"allocation amount"),allocatedOn=day(v(d,"allocated_on"),"allocation date");
  await withTransaction(async c=>{
    const r=await c.query<{id:string}>("insert into food_credit_allocation(credit_note_id,food_bill_id,amount,allocated_on,created_by) values ($1,$2,$3,$4,$5) returning id",[credit,bill,amount,allocatedOn,a.userId]);
    await c.query("select accounting_post_food_credit_allocation($1,$2)",[r.rows[0].id,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"food_credit_allocated",entityType:"food_credit_allocation",entityId:r.rows[0].id,after:{creditNoteId:credit,foodBillId:bill,amount,allocatedOn}});
  });
  good("Existing family credit allocated to the food bill.");
}
