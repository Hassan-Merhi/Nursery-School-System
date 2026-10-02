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
const RENTAL_ROLES=new Set(["rent_expense","prepaid_rent","rent_payable","rent_deposit"]);

function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function bad(m:string):never{redirect("/rentals?error="+encodeURIComponent(m));}
function good(m:string,d?:FormData):never{
  revalidatePath("/rentals");
  revalidatePath("/money");
  revalidatePath("/accounting");
  revalidatePath("/operations");
  revalidatePath("/dashboard");
  const returnTo=d?String(d.get("return_to")??"").trim():"";
  if(returnTo==="/money")redirect("/money?success="+encodeURIComponent(m)+"#rent");
  redirect("/rentals?success="+encodeURIComponent(m));
}
function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
function day(raw:string,label:string){
  if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");
  return raw;
}
function amt(raw:string,label:string){
  if(!MONEY_RE.test(raw))bad("Enter a valid "+label+" with at most two decimals.");
  const n=Number(raw);
  if(!Number.isFinite(n)||n<=0||n>999999999.99)bad(label+" must be greater than zero.");
  return n.toFixed(2);
}
function nonNegativeAmt(raw:string,label:string){
  if(!MONEY_RE.test(raw||"0"))bad("Enter a valid "+label+" with at most two decimals.");
  const n=Number(raw||"0");
  if(!Number.isFinite(n)||n<0||n>999999999.99)bad(label+" cannot be negative.");
  return n.toFixed(2);
}
function cur(raw:string){const c=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(c))bad("Currency must be a three-letter code.");return c;}
function integer(raw:string,label:string,min:number,max:number){
  const n=Number.parseInt(raw,10);
  if(!Number.isInteger(n)||String(n)!==raw||n<min||n>max)bad(label+" must be between "+min+" and "+max+".");
  return n;
}
async function nextNo(c:PoolClient,t:string,u:string){
  const r=await c.query<{prefix:string;number:string}>(
    "update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text as number",
    [t,u],
  );
  if(!r.rows[0])bad("Document sequence "+t+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}
async function openPeriod(c:PoolClient,d:string){
  const r=await c.query("select 1 from accounting_period where status='open' and $1::date between starts_on and ends_on",[d]);
  if(!r.rowCount)bad("Posting date is not inside an open accounting period.");
}
async function rentalAccountingReady(c:PoolClient,roles:string[]){
  if(!(await c.query("select 1 from accounting_configuration x join journal j on j.id=x.rentals_journal_id where x.id=1 and j.status='active'")).rowCount){
    bad("Configure an active Rentals journal before posting rental transactions.");
  }
  for(const role of roles){
    if(!(await c.query("select 1 from accounting_mapping m join account a on a.id=m.account_id where m.role_key=$1 and a.status='active' and a.allow_posting=true",[role])).rowCount){
      bad("Accounting mapping "+role+" is not configured.");
    }
  }
}

export async function configureRentalsJournalAction(d:FormData){
  const a=await requirePermission("accounting.mapping");
  const journal=id(v(d,"journal_id"),"journal");
  await withTransaction(async c=>{
    if(!(await c.query("select 1 from journal where id=$1 and status='active'",[journal])).rowCount)bad("Select an active journal.");
    const before=(await c.query("select rentals_journal_id from accounting_configuration where id=1 for update")).rows[0];
    await c.query("update accounting_configuration set rentals_journal_id=$1,updated_at=now(),updated_by=$2 where id=1",[journal,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"rentals_journal_configured",entityType:"accounting_configuration",entityId:"1",before,after:{rentalsJournalId:journal}});
  });
  good("Rentals journal configured.");
}

export async function configureRentalMappingAction(d:FormData){
  const a=await requirePermission("accounting.mapping");
  const role=v(d,"role_key");
  if(!RENTAL_ROLES.has(role))bad("Invalid rental accounting role.");
  const account=id(v(d,"account_id"),"account");
  await withTransaction(async c=>{
    const before=(await c.query("select role_key,account_id from accounting_mapping where role_key=$1 for update",[role])).rows[0]??null;
    await c.query(
      "insert into accounting_mapping(role_key,account_id,updated_by) values ($1,$2,$3) on conflict (role_key) do update set account_id=excluded.account_id,updated_at=now(),updated_by=excluded.updated_by",
      [role,account,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"rental_accounting_mapping_updated",entityType:"accounting_mapping",entityId:role,before,after:{roleKey:role,accountId:account}});
  });
  good("Rental accounting mapping saved.");
}

export async function createLandlordAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const name=v(d,"name");
  if(!name)bad("Landlord name is required.");
  await withTransaction(async c=>{
    const number=await nextNo(c,"landlord",a.userId);
    const r=await c.query<{id:string}>(
      "insert into landlord(landlord_number,name,contact_name,email,phone,address,tax_number,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id",
      [number,name,v(d,"contact_name")||null,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,v(d,"tax_number")||null,v(d,"notes")||null,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"landlord_created",entityType:"landlord",entityId:r.rows[0].id,after:{landlordNumber:number,name}});
  });
  good("Landlord created.");
}

export async function updateLandlordAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const landlord=id(v(d,"landlord_id"),"landlord");
  const name=v(d,"name"),status=v(d,"status");
  if(!name)bad("Landlord name is required.");
  if(!["active","inactive"].includes(status))bad("Invalid landlord status.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from landlord where id=$1 for update",[landlord])).rows[0];
    if(!before)bad("Landlord not found.");
    await c.query(
      "update landlord set name=$2,contact_name=$3,email=$4,phone=$5,address=$6,tax_number=$7,notes=$8,status=$9,updated_at=now(),updated_by=$10 where id=$1",
      [landlord,name,v(d,"contact_name")||null,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,v(d,"tax_number")||null,v(d,"notes")||null,status,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"landlord_updated",entityType:"landlord",entityId:landlord,before,after:{name,status}});
  });
  good("Landlord updated.");
}

function agreementInput(d:FormData){
  const landlord=id(v(d,"landlord_id"),"landlord");
  const propertyName=v(d,"property_name"),propertyAddress=v(d,"property_address");
  if(!propertyName)bad("Property name is required.");
  if(!propertyAddress)bad("Property address is required.");
  const start=day(v(d,"start_on"),"start date"),end=day(v(d,"end_on"),"end date");
  if(end<start)bad("End date cannot be before start date.");
  const amount=amt(v(d,"recurring_amount"),"recurring rent");
  const currency=cur(v(d,"currency"));
  const frequency=v(d,"frequency");
  if(!["monthly","quarterly","yearly"].includes(frequency))bad("Invalid rent frequency.");
  const dueDay=integer(v(d,"due_day"),"Due day",1,31);
  const deposit=nonNegativeAmt(v(d,"deposit_amount"),"deposit amount");
  return {landlord,propertyName,propertyAddress,start,end,amount,currency,frequency,dueDay,deposit};
}

export async function createRentalAgreementAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const x=agreementInput(d);
  await withTransaction(async c=>{
    if(!(await c.query("select 1 from landlord where id=$1 and status='active'",[x.landlord])).rowCount)bad("Select an active landlord.");
    const number=await nextNo(c,"rental",a.userId);
    const r=await c.query<{id:string}>(
      `insert into rental_agreement(
        agreement_number,landlord_id,property_name,property_address,start_on,end_on,
        recurring_amount,currency,frequency,due_day,deposit_amount,reference,notes,created_by,updated_by
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) returning id`,
      [number,x.landlord,x.propertyName,x.propertyAddress,x.start,x.end,x.amount,x.currency,x.frequency,x.dueDay,x.deposit,v(d,"reference")||null,v(d,"notes")||null,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"rental_agreement_created",entityType:"rental_agreement",entityId:r.rows[0].id,after:{agreementNumber:number,landlordId:x.landlord,startOn:x.start,endOn:x.end,recurringAmount:x.amount,currency:x.currency}});
  });
  good("Rental agreement created as draft.");
}

export async function updateRentalAgreementAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const agreement=id(v(d,"rental_agreement_id"),"rental agreement");
  const x=agreementInput(d);
  await withTransaction(async c=>{
    const before=(await c.query("select * from rental_agreement where id=$1 for update",[agreement])).rows[0];
    if(!before||before.status!=="draft")bad("Only draft rental agreements can be edited.");
    if(!(await c.query("select 1 from landlord where id=$1 and status='active'",[x.landlord])).rowCount)bad("Select an active landlord.");
    await c.query(
      `update rental_agreement set landlord_id=$2,property_name=$3,property_address=$4,start_on=$5,end_on=$6,
       recurring_amount=$7,currency=$8,frequency=$9,due_day=$10,deposit_amount=$11,reference=$12,notes=$13,
       updated_at=now(),updated_by=$14 where id=$1`,
      [agreement,x.landlord,x.propertyName,x.propertyAddress,x.start,x.end,x.amount,x.currency,x.frequency,x.dueDay,x.deposit,v(d,"reference")||null,v(d,"notes")||null,a.userId],
    );
    await writeAudit(c,{actorUserId:a.userId,action:"rental_agreement_updated",entityType:"rental_agreement",entityId:agreement,before,after:{landlordId:x.landlord,startOn:x.start,endOn:x.end,recurringAmount:x.amount,currency:x.currency}});
  });
  good("Draft rental agreement updated.");
}

export async function activateRentalAgreementAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const agreement=id(v(d,"rental_agreement_id"),"rental agreement");
  await withTransaction(async c=>{
    const before=(await c.query("select * from rental_agreement where id=$1 for update",[agreement])).rows[0];
    if(!before||before.status!=="draft")bad("Only draft rental agreements can be activated.");
    const r=await c.query<{count:number}>("select activate_rental_agreement($1,$2)::int as count",[agreement,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"rental_agreement_activated",entityType:"rental_agreement",entityId:agreement,before,after:{status:"active",scheduleItems:r.rows[0]?.count??0}});
  });
  good("Rental agreement activated and rent schedule generated.");
}

export async function endRentalAgreementAction(d:FormData){
  const a=await requirePermission("rentals.manage");
  const agreement=id(v(d,"rental_agreement_id"),"rental agreement");
  await withTransaction(async c=>{
    const before=(await c.query("select * from rental_agreement where id=$1 for update",[agreement])).rows[0];
    if(!before||before.status!=="active")bad("Only active rental agreements can be ended.");
    await c.query("update rental_agreement set status='ended',ended_at=now(),ended_by=$2,updated_at=now(),updated_by=$2 where id=$1",[agreement,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"rental_agreement_ended",entityType:"rental_agreement",entityId:agreement,before,after:{status:"ended"}});
  });
  good("Rental agreement ended. Its history and existing schedule were preserved.");
}

export async function createRentPaymentAction(d:FormData){
  const a=await requirePermission("rentals.pay");
  const agreement=id(v(d,"rental_agreement_id"),"rental agreement");
  const paymentType=v(d,"payment_type");
  if(!["rent","deposit"].includes(paymentType))bad("Choose rent or deposit payment.");
  const account=id(v(d,"payment_account_id"),"payment account");
  const amount=amt(v(d,"amount"),"amount");
  const currency=cur(v(d,"currency"));
  const paidOn=day(v(d,"paid_on"),"payment date");
  const method=v(d,"method");
  if(!["cash","card","bank_transfer","check","other"].includes(method))bad("Invalid payment method.");
  const cheque=v(d,"cheque_number");
  if(method==="check"&&!cheque)bad("Cheque number is required.");
  await withTransaction(async c=>{
    await openPeriod(c,paidOn);
    await rentalAccountingReady(c,paymentType==="deposit"?["rent_deposit"]:["prepaid_rent","rent_payable"]);
    const number=await nextNo(c,"rent_payment",a.userId);
    const r=await c.query<{id:string}>(
      `insert into rent_payment(
        rent_payment_number,rental_agreement_id,payment_type,payment_account_id,amount,currency,paid_on,
        method,cheque_number,cheque_due_on,reference,notes,created_by
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [number,agreement,paymentType,account,amount,currency,paidOn,method,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,v(d,"notes")||null,a.userId],
    );
    const paymentId=r.rows[0].id;
    if(paymentType==="rent")await c.query("select allocate_rent_payment($1,$2)",[paymentId,a.userId]);
    await c.query("select accounting_post_rent_payment($1,$2)",[paymentId,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:paymentType==="deposit"?"rent_deposit_paid":"rent_payment_posted",entityType:"rent_payment",entityId:paymentId,after:{rentPaymentNumber:number,agreementId:agreement,paymentType,amount,currency,paidOn,paymentAccountId:account}});
  });
  good(paymentType==="deposit"?"Rent deposit posted.":"Rent payment posted and allocated to the rent schedule.",d);
}

export async function reverseRentPaymentAction(d:FormData){
  const a=await requirePermission("rentals.pay");
  const payment=id(v(d,"rent_payment_id"),"rent payment");
  const postingDate=day(v(d,"reversal_date"),"reversal date");
  const reason=v(d,"reason");
  if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{
    await openPeriod(c,postingDate);
    const before=(await c.query("select * from rent_payment where id=$1 for update",[payment])).rows[0];
    if(!before||before.status!=="posted")bad("Only posted rent payments can be reversed.");
    await c.query("select reverse_rent_payment($1,$2,$3,$4)",[payment,postingDate,a.userId,reason]);
    await writeAudit(c,{actorUserId:a.userId,action:"rent_payment_reversed",entityType:"rent_payment",entityId:payment,before,after:{status:"reversed",reason,reversalDate:postingDate}});
  });
  good("Rent payment reversed with accounting history preserved.");
}

export async function recognizeRentThroughAction(d:FormData){
  const a=await requirePermission("rentals.post");
  const agreement=id(v(d,"rental_agreement_id"),"rental agreement");
  const through=day(v(d,"through_date"),"recognition through date");
  await withTransaction(async c=>{
    await rentalAccountingReady(c,["rent_expense","prepaid_rent","rent_payable"]);
    const count=await c.query<{count:number}>("select recognize_rent_through($1,$2,$3)::int as count",[agreement,through,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"rent_recognized_through",entityType:"rental_agreement",entityId:agreement,after:{throughDate:through,periodsRecognized:count.rows[0]?.count??0}});
  });
  good("Rent recognition completed through "+through+".");
}

export async function reverseRentRecognitionAction(d:FormData){
  const a=await requirePermission("rentals.post");
  const recognition=id(v(d,"rent_recognition_id"),"rent recognition");
  const postingDate=day(v(d,"reversal_date"),"reversal date");
  const reason=v(d,"reason");
  if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{
    await openPeriod(c,postingDate);
    const before=(await c.query("select * from rent_recognition where id=$1 for update",[recognition])).rows[0];
    if(!before||before.status!=="posted")bad("Only posted rent recognition can be reversed.");
    await c.query("select reverse_rent_recognition($1,$2,$3,$4)",[recognition,postingDate,a.userId,reason]);
    await writeAudit(c,{actorUserId:a.userId,action:"rent_recognition_reversed",entityType:"rent_recognition",entityId:recognition,before,after:{status:"reversed",reason,reversalDate:postingDate}});
  });
  good("Rent recognition reversed.");
}
