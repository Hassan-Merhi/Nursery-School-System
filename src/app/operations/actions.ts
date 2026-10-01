"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\\d{4}-\\d{2}-\\d{2}$/;
const MONEY_RE=/^\\d+(?:\\.\\d{1,2})?$/;

function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function bad(m:string):never{redirect("/operations?error="+encodeURIComponent(m));}
function good(m:string):never{revalidatePath("/operations");revalidatePath("/billing");revalidatePath("/accounting");redirect("/operations?success="+encodeURIComponent(m));}
function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
function oid(raw:string,label:string){return raw?id(raw,label):null;}
function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");return raw;}
function amt(raw:string,label:string){if(!MONEY_RE.test(raw))bad("Enter a valid "+label+" with at most two decimals.");const n=Number(raw);if(!Number.isFinite(n)||n<=0||n>999999999.99)bad(label+" must be greater than zero.");return n.toFixed(2);}
function cur(raw:string){const c=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(c))bad("Currency must be a three-letter code.");return c;}

async function nextNo(c:PoolClient,t:string,u:string){
  const r=await c.query<{prefix:string;number:string}>("update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text as number",[t,u]);
  if(!r.rows[0])bad("Document sequence "+t+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}
async function openPeriod(c:PoolClient,d:string){
  const r=await c.query("select 1 from accounting_period where status='open' and $1::date between starts_on and ends_on",[d]);
  if(!r.rowCount)bad("Posting date is not inside an open accounting period.");
}
async function ready(c:PoolClient,d:string,roles:string[]=[]){
  await openPeriod(c,d);
  if(!(await c.query("select 1 from accounting_configuration x join journal j on j.id=x.operations_journal_id where x.id=1 and j.status='active'")).rowCount)bad("Configure an active Operations journal before posting Step 5 transactions.");
  for(const role of roles)if(!(await c.query("select 1 from accounting_mapping m join account a on a.id=m.account_id where m.role_key=$1 and a.status='active' and a.allow_posting=true",[role])).rowCount)bad("Accounting mapping "+role+" is not configured.");
}

export async function configureOperationsJournalAction(d:FormData){
  const a=await requirePermission("accounting.mapping");const journal=id(v(d,"journal_id"),"journal");
  await withTransaction(async c=>{if(!(await c.query("select 1 from journal where id=$1 and status='active'",[journal])).rowCount)bad("Select an active journal.");const before=(await c.query("select * from accounting_configuration where id=1 for update")).rows[0];await c.query("update accounting_configuration set operations_journal_id=$1,updated_at=now(),updated_by=$2 where id=1",[journal,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"operations_journal_configured",entityType:"accounting_configuration",entityId:"1",before,after:{operationsJournalId:journal}});});good("Operations journal configured.");
}

export async function createCashBankAccountAction(d:FormData){
  const a=await requirePermission("banking.manage");const account=id(v(d,"account_id"),"account"),kind=v(d,"account_kind"),name=v(d,"display_name");if(!["cash","bank"].includes(kind))bad("Choose cash or bank.");if(!name)bad("Display name is required.");
  await withTransaction(async c=>{await c.query("insert into cash_bank_account(account_id,account_kind,display_name,bank_name,account_identifier,iban,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)",[account,kind,name,v(d,"bank_name")||null,v(d,"account_identifier")||null,v(d,"iban")||null,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"cash_bank_account_created",entityType:"cash_bank_account",entityId:account,after:{kind,displayName:name}});});good("Cash/bank account enabled.");
}

export async function updateCashBankAccountAction(d:FormData){
  const a=await requirePermission("banking.manage"),account=id(v(d,"account_id"),"account"),kind=v(d,"account_kind"),name=v(d,"display_name"),active=v(d,"is_active")==="true";
  if(!["cash","bank"].includes(kind))bad("Choose cash or bank.");if(!name)bad("Display name is required.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from cash_bank_account where account_id=$1 for update",[account])).rows[0];if(!before)bad("Cash/bank account not found.");
    await c.query("update cash_bank_account set account_kind=$2,display_name=$3,bank_name=$4,account_identifier=$5,iban=$6,is_active=$7,updated_at=now(),updated_by=$8 where account_id=$1",[account,kind,name,v(d,"bank_name")||null,v(d,"account_identifier")||null,v(d,"iban")||null,active,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"cash_bank_account_updated",entityType:"cash_bank_account",entityId:account,before,after:{kind,displayName:name,active}});
  });good("Cash/bank account updated.");
}

export async function createSupplierAction(d:FormData){
  const a=await requirePermission("suppliers.manage");const name=v(d,"name");if(!name)bad("Supplier name is required.");const terms=Number.parseInt(v(d,"payment_terms_days")||"0",10);if(!Number.isInteger(terms)||terms<0||terms>3650)bad("Invalid payment terms.");
  await withTransaction(async c=>{const number=await nextNo(c,"supplier",a.userId);const r=await c.query<{id:string}>("insert into supplier(supplier_number,name,contact_name,email,phone,address,tax_number,default_expense_account_id,default_payment_account_id,payment_terms_days,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id",[number,name,v(d,"contact_name")||null,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,v(d,"tax_number")||null,oid(v(d,"default_expense_account_id"),"default expense account"),oid(v(d,"default_payment_account_id"),"default payment account"),terms,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_created",entityType:"supplier",entityId:r.rows[0].id,after:{supplierNumber:number,name}});});good("Supplier created.");
}

export async function updateSupplierAction(d:FormData){
  const a=await requirePermission("suppliers.manage"),supplier=id(v(d,"supplier_id"),"supplier"),name=v(d,"name"),status=v(d,"status");
  if(!name)bad("Supplier name is required.");if(!["active","inactive"].includes(status))bad("Invalid supplier status.");
  const terms=Number.parseInt(v(d,"payment_terms_days")||"0",10);if(!Number.isInteger(terms)||terms<0||terms>3650)bad("Invalid payment terms.");
  await withTransaction(async c=>{
    const before=(await c.query("select * from supplier where id=$1 for update",[supplier])).rows[0];if(!before)bad("Supplier not found.");
    await c.query("update supplier set name=$2,contact_name=$3,email=$4,phone=$5,address=$6,tax_number=$7,default_expense_account_id=$8,default_payment_account_id=$9,payment_terms_days=$10,notes=$11,status=$12,updated_at=now(),updated_by=$13 where id=$1",[supplier,name,v(d,"contact_name")||null,v(d,"email")||null,v(d,"phone")||null,v(d,"address")||null,v(d,"tax_number")||null,oid(v(d,"default_expense_account_id"),"default expense account"),oid(v(d,"default_payment_account_id"),"default payment account"),terms,v(d,"notes")||null,status,a.userId]);
    await writeAudit(c,{actorUserId:a.userId,action:"supplier_updated",entityType:"supplier",entityId:supplier,before,after:{name,status,paymentTermsDays:terms}});
  });good("Supplier updated.");
}

export async function createExpenseAction(d:FormData){
  const a=await requirePermission("expenses.manage"),supplier=oid(v(d,"supplier_id"),"supplier"),expense=id(v(d,"expense_account_id"),"expense account"),payment=id(v(d,"payment_account_id"),"payment account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),incurred=day(v(d,"incurred_on"),"expense date"),method=v(d,"payment_method"),cheque=v(d,"cheque_number");
  if(!["cash","card","bank_transfer","check","other"].includes(method))bad("Invalid payment method.");if(method==="check"&&!cheque)bad("Cheque number is required.");
  const status=v(d,"submit_mode")==="submit"?"pending":"draft";
  await withTransaction(async c=>{const number=await nextNo(c,"expense",a.userId);const r=await c.query<{id:string}>("insert into expense(expense_number,supplier_id,expense_account_id,payment_account_id,amount,currency,incurred_on,payment_method,cheque_number,cheque_due_on,reference,notes,status,submitted_at,submitted_by,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,case when $13='pending' then now() else null end,case when $13='pending' then $14 else null end,$14,$14) returning id",[number,supplier,expense,payment,amount,currency,incurred,method,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,v(d,"notes")||null,status,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:status==="pending"?"expense_submitted":"expense_created",entityType:"expense",entityId:r.rows[0].id,after:{expenseNumber:number,amount,currency,status}});});good(status==="pending"?"Expense submitted for approval.":"Draft expense created.");
}

export async function submitExpenseAction(d:FormData){
  const a=await requirePermission("expenses.manage"),expense=id(v(d,"expense_id"),"expense");
  await withTransaction(async c=>{const before=(await c.query("select * from expense where id=$1 for update",[expense])).rows[0];if(!before||before.status!=="draft")bad("Only draft expenses can be submitted.");await c.query("update expense set status='pending',submitted_at=now(),submitted_by=$2,updated_at=now(),updated_by=$2 where id=$1",[expense,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"expense_submitted",entityType:"expense",entityId:expense,before,after:{status:"pending"}});});good("Expense submitted.");
}

export async function reviewExpenseAction(d:FormData){
  const a=await requirePermission("expenses.approve"),expense=id(v(d,"expense_id"),"expense"),decision=v(d,"decision"),note=v(d,"approval_note");if(!["approve","reject"].includes(decision))bad("Invalid decision.");if(decision==="reject"&&!note)bad("Rejection note is required.");
  await withTransaction(async c=>{const before=(await c.query("select * from expense where id=$1 for update",[expense])).rows[0];if(!before||before.status!=="pending")bad("Only pending expenses can be reviewed.");if(decision==="approve")await c.query("update expense set status='approved',approved_at=now(),approved_by=$2,approval_note=$3,updated_at=now(),updated_by=$2 where id=$1",[expense,a.userId,note||null]);else await c.query("update expense set status='draft',submitted_at=null,submitted_by=null,approval_note=$2,updated_at=now(),updated_by=$3 where id=$1",[expense,note,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:decision==="approve"?"expense_approved":"expense_rejected",entityType:"expense",entityId:expense,before,after:{status:decision==="approve"?"approved":"draft",note}});});good(decision==="approve"?"Expense approved.":"Expense returned to draft.");
}

export async function postExpenseAction(d:FormData){
  const a=await requirePermission("expenses.post"),expense=id(v(d,"expense_id"),"expense");
  await withTransaction(async c=>{const row=(await c.query<{incurred_on:string;status:string}>("select incurred_on::text,status from expense where id=$1 for update",[expense])).rows[0];if(!row||row.status!=="approved")bad("Only approved expenses can be posted.");await ready(c,row.incurred_on);await c.query("select accounting_post_expense($1,$2)",[expense,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"expense_posted",entityType:"expense",entityId:expense,after:{status:"posted"}});});good("Expense posted.");
}

export async function reverseExpenseAction(d:FormData){
  const a=await requirePermission("expenses.post"),expense=id(v(d,"expense_id"),"expense"),rd=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await openPeriod(c,rd);const before=(await c.query("select * from expense where id=$1 for update",[expense])).rows[0];if(!before||before.status!=="posted")bad("Only posted expenses can be reversed.");await c.query("select reverse_operational_source('expense',$1,$2,$3,$4)",[expense,rd,a.userId,reason]);await c.query("update expense set status='reversed',reversed_at=now(),reversed_by=$2,reversal_reason=$3,updated_at=now(),updated_by=$2 where id=$1",[expense,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:"expense_reversed",entityType:"expense",entityId:expense,before,after:{status:"reversed",reason}});});good("Expense reversed.");
}

export async function createSupplierInvoiceAction(d:FormData){
  const a=await requirePermission("suppliers.manage"),supplier=id(v(d,"supplier_id"),"supplier"),expense=id(v(d,"expense_account_id"),"expense account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),invoiceDate=day(v(d,"invoice_date"),"invoice date"),due=day(v(d,"due_on"),"due date");if(due<invoiceDate)bad("Due date cannot be before invoice date.");
  await withTransaction(async c=>{const number=await nextNo(c,"supplier_invoice",a.userId);const r=await c.query<{id:string}>("insert into supplier_invoice(supplier_invoice_number,supplier_id,supplier_reference,expense_account_id,amount,currency,invoice_date,due_on,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id",[number,supplier,v(d,"supplier_reference")||null,expense,amount,currency,invoiceDate,due,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_invoice_created",entityType:"supplier_invoice",entityId:r.rows[0].id,after:{number,supplier,amount,currency}});});good("Supplier invoice created.");
}

export async function approveSupplierInvoiceAction(d:FormData){
  const a=await requirePermission("expenses.approve"),invoice=id(v(d,"supplier_invoice_id"),"supplier invoice");
  await withTransaction(async c=>{const before=(await c.query("select * from supplier_invoice where id=$1 for update",[invoice])).rows[0];if(!before||before.status!=="draft")bad("Only draft supplier invoices can be approved.");await c.query("update supplier_invoice set status='approved',approved_at=now(),approved_by=$2,updated_at=now(),updated_by=$2 where id=$1",[invoice,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_invoice_approved",entityType:"supplier_invoice",entityId:invoice,before,after:{status:"approved"}});});good("Supplier invoice approved.");
}

export async function postSupplierInvoiceAction(d:FormData){
  const a=await requirePermission("expenses.post"),invoice=id(v(d,"supplier_invoice_id"),"supplier invoice");
  await withTransaction(async c=>{const row=(await c.query<{invoice_date:string;status:string}>("select invoice_date::text,status from supplier_invoice where id=$1 for update",[invoice])).rows[0];if(!row||row.status!=="approved")bad("Only approved supplier invoices can be posted.");await ready(c,row.invoice_date,["accounts_payable"]);await c.query("select accounting_post_supplier_invoice($1,$2)",[invoice,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_invoice_posted",entityType:"supplier_invoice",entityId:invoice,after:{status:"posted"}});});good("Supplier invoice posted.");
}

export async function reverseSupplierInvoiceAction(d:FormData){
  const a=await requirePermission("expenses.post"),invoice=id(v(d,"supplier_invoice_id"),"supplier invoice"),rd=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{
    await openPeriod(c,rd);
    const before=(await c.query("select * from supplier_invoice where id=$1 for update",[invoice])).rows[0];
    if(!before||before.status!=="posted")bad("Only an unpaid posted supplier invoice can be reversed.");
    const balance=(await c.query<{balance_amount:string}>("select balance_amount::text from supplier_invoice_balance where id=$1",[invoice])).rows[0];
    if(!balance||Number(balance.balance_amount)!==Number(before.amount))bad("Reverse supplier payments or credits before reversing the invoice.");
    await c.query("select reverse_operational_source('supplier_invoice',$1,$2,$3,$4)",[invoice,rd,a.userId,reason]);
    await c.query("update supplier_invoice set status='reversed',reversed_at=now(),reversed_by=$2,reversal_reason=$3,updated_at=now(),updated_by=$2 where id=$1",[invoice,a.userId,reason]);
    await writeAudit(c,{actorUserId:a.userId,action:"supplier_invoice_reversed",entityType:"supplier_invoice",entityId:invoice,before,after:{status:"reversed",reason,reversalDate:rd}});
  });good("Supplier invoice reversed.");
}

export async function paySupplierInvoiceAction(d:FormData){
  const a=await requirePermission("suppliers.manage"),invoice=id(v(d,"supplier_invoice_id"),"supplier invoice"),payment=id(v(d,"payment_account_id"),"payment account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),paid=day(v(d,"paid_on"),"payment date"),method=v(d,"method"),cheque=v(d,"cheque_number");if(!["cash","card","bank_transfer","check","other"].includes(method))bad("Invalid payment method.");if(method==="check"&&!cheque)bad("Cheque number is required.");
  await withTransaction(async c=>{await ready(c,paid,["accounts_payable"]);const inv=(await c.query<{supplier_id:string}>("select supplier_id from supplier_invoice where id=$1",[invoice])).rows[0];if(!inv)bad("Supplier invoice not found.");const number=await nextNo(c,"supplier_payment",a.userId);const r=await c.query<{id:string}>("insert into supplier_payment(supplier_payment_number,supplier_id,supplier_invoice_id,payment_account_id,amount,currency,paid_on,method,cheque_number,cheque_due_on,reference,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",[number,inv.supplier_id,invoice,payment,amount,currency,paid,method,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,v(d,"notes")||null,a.userId]);await c.query("select accounting_post_supplier_payment($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_payment_posted",entityType:"supplier_payment",entityId:r.rows[0].id,after:{number,invoice,amount,currency}});});good("Supplier payment posted.");
}

export async function createSupplierCreditAction(d:FormData){
  const a=await requirePermission("suppliers.manage"),invoice=id(v(d,"supplier_invoice_id"),"supplier invoice"),expense=id(v(d,"expense_account_id"),"expense account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),credited=day(v(d,"credited_on"),"credit date"),reason=v(d,"reason");if(!reason)bad("Credit reason is required.");
  await withTransaction(async c=>{await ready(c,credited,["accounts_payable"]);const inv=(await c.query<{supplier_id:string}>("select supplier_id from supplier_invoice where id=$1",[invoice])).rows[0];if(!inv)bad("Supplier invoice not found.");const number=await nextNo(c,"supplier_credit",a.userId);const r=await c.query<{id:string}>("insert into supplier_credit(supplier_credit_number,supplier_id,supplier_invoice_id,expense_account_id,amount,currency,credited_on,reference,reason,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",[number,inv.supplier_id,invoice,expense,amount,currency,credited,v(d,"reference")||null,reason,a.userId]);await c.query("select accounting_post_supplier_credit($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"supplier_credit_posted",entityType:"supplier_credit",entityId:r.rows[0].id,after:{number,invoice,amount,currency}});});good("Supplier credit posted.");
}

async function reverseSource(d:FormData,permission:string,table:string,key:string,source:string,entity:string){
  const a=await requirePermission(permission),sourceId=id(v(d,key),entity),rd=day(v(d,"reversal_date"),"reversal date"),reason=v(d,"reason");if(!reason)bad("Reversal reason is required.");
  await withTransaction(async c=>{await openPeriod(c,rd);const before=(await c.query("select * from "+table+" where id=$1 for update",[sourceId])).rows[0];if(!before||before.status!=="posted")bad("Only posted "+entity+" records can be reversed.");await c.query("select reverse_operational_source($1,$2,$3,$4,$5)",[source,sourceId,rd,a.userId,reason]);await c.query("update "+table+" set status='reversed',reversed_at=now(),reversed_by=$2,reversal_reason=$3 where id=$1",[sourceId,a.userId,reason]);await writeAudit(c,{actorUserId:a.userId,action:source+"_reversed",entityType:entity,entityId:sourceId,before,after:{status:"reversed",reason}});});
  good(entity+" reversed.");
}
export async function reverseSupplierPaymentAction(d:FormData){return reverseSource(d,"suppliers.manage","supplier_payment","supplier_payment_id","supplier_payment","supplier payment");}
export async function reverseSupplierCreditAction(d:FormData){return reverseSource(d,"suppliers.manage","supplier_credit","supplier_credit_id","supplier_credit","supplier credit");}

export async function createParentRefundAction(d:FormData){
  const a=await requirePermission("refunds.manage"),family=id(v(d,"family_id"),"family"),student=oid(v(d,"student_id"),"student"),payment=id(v(d,"payment_account_id"),"payment account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),refunded=day(v(d,"refunded_on"),"refund date"),method=v(d,"method"),cheque=v(d,"cheque_number"),reason=v(d,"reason");if(!reason)bad("Refund reason is required.");if(!["cash","card","bank_transfer","check","other"].includes(method))bad("Invalid refund method.");if(method==="check"&&!cheque)bad("Cheque number is required.");
  await withTransaction(async c=>{await ready(c,refunded,["customer_deposits"]);const number=await nextNo(c,"refund",a.userId);const r=await c.query<{id:string}>("insert into parent_refund(refund_number,family_id,student_id,payment_account_id,amount,currency,refunded_on,method,cheque_number,cheque_due_on,reference,reason,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",[number,family,student,payment,amount,currency,refunded,method,cheque||null,v(d,"cheque_due_on")?day(v(d,"cheque_due_on"),"cheque due date"):null,v(d,"reference")||null,reason,a.userId]);await c.query("select accounting_post_parent_refund($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"parent_refund_posted",entityType:"parent_refund",entityId:r.rows[0].id,after:{number,family,amount,currency}});});good("Parent credit refunded.");
}
export async function reverseParentRefundAction(d:FormData){return reverseSource(d,"refunds.manage","parent_refund","refund_id","parent_refund","parent refund");}

export async function createCashBankTransactionAction(d:FormData){
  const a=await requirePermission("banking.manage"),kind=v(d,"transaction_kind"),account=id(v(d,"account_id"),"cash/bank account"),contra=id(v(d,"contra_account_id"),"contra account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),transactionDate=day(v(d,"transaction_date"),"transaction date");if(!["transfer","deposit","withdrawal"].includes(kind))bad("Invalid transaction type.");
  await withTransaction(async c=>{await ready(c,transactionDate);const number=await nextNo(c,"bank_transaction",a.userId);const r=await c.query<{id:string}>("insert into cash_bank_transaction(transaction_number,transaction_kind,account_id,contra_account_id,amount,currency,transaction_date,reference,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",[number,kind,account,contra,amount,currency,transactionDate,v(d,"reference")||null,v(d,"notes")||null,a.userId]);await c.query("select accounting_post_cash_bank_transaction($1,$2)",[r.rows[0].id,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"cash_bank_"+kind+"_posted",entityType:"cash_bank_transaction",entityId:r.rows[0].id,after:{number,kind,amount,currency}});});good(kind.charAt(0).toUpperCase()+kind.slice(1)+" posted.");
}
export async function reverseCashBankTransactionAction(d:FormData){return reverseSource(d,"banking.manage","cash_bank_transaction","transaction_id","cash_bank_transaction","cash/bank transaction");}

export async function createRecurringExpenseAction(d:FormData){
  const a=await requirePermission("recurring_expenses.manage"),name=v(d,"name"),category=v(d,"category_key"),supplier=oid(v(d,"supplier_id"),"supplier"),expense=id(v(d,"expense_account_id"),"expense account"),payment=id(v(d,"payment_account_id"),"payment account"),amount=amt(v(d,"amount"),"amount"),currency=cur(v(d,"currency")),frequency=v(d,"frequency"),due=day(v(d,"next_due_on"),"next due date"),method=v(d,"payment_method");if(!name)bad("Name is required.");if(!["monthly","quarterly","yearly"].includes(frequency))bad("Invalid frequency.");if(!["cash","card","bank_transfer","other"].includes(method))bad("Recurring cheque expenses must be entered manually.");
  await withTransaction(async c=>{const r=await c.query<{id:string}>("insert into recurring_expense(name,category_key,supplier_id,expense_account_id,payment_account_id,amount,currency,frequency,next_due_on,payment_method,reference_prefix,notes,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) returning id",[name,category,supplier,expense,payment,amount,currency,frequency,due,method,v(d,"reference_prefix")||null,v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"recurring_expense_created",entityType:"recurring_expense",entityId:r.rows[0].id,after:{name,category,amount,currency,frequency,due}});});good("Recurring expense created.");
}
function advance(current:string,frequency:string){const x=new Date(current+"T00:00:00Z");if(frequency==="monthly")x.setUTCMonth(x.getUTCMonth()+1);else if(frequency==="quarterly")x.setUTCMonth(x.getUTCMonth()+3);else x.setUTCFullYear(x.getUTCFullYear()+1);return x.toISOString().slice(0,10);}
export async function generateRecurringExpensesAction(d:FormData){
  const a=await requirePermission("recurring_expenses.manage"),through=day(v(d,"through_date"),"through date");let count=0;
  await withTransaction(async c=>{const rows=(await c.query<any>("select * from recurring_expense where status='active' and next_due_on<=$1 order by next_due_on,id for update",[through])).rows;for(const t of rows){let due=String(t.next_due_on).slice(0,10),guard=0;while(due<=through){if(++guard>120)bad("Recurring generation safety limit reached.");if(!(await c.query("select 1 from recurring_expense_occurrence where recurring_expense_id=$1 and due_on=$2",[t.id,due])).rowCount){const number=await nextNo(c,"expense",a.userId);const ref=t.reference_prefix?t.reference_prefix+"-"+due:null;const e=await c.query<{id:string}>("insert into expense(expense_number,supplier_id,expense_account_id,payment_account_id,amount,currency,incurred_on,payment_method,reference,notes,status,submitted_at,submitted_by,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',now(),$11,$11,$11) returning id",[number,t.supplier_id,t.expense_account_id,t.payment_account_id,t.amount,t.currency,due,t.payment_method,ref,t.notes,a.userId]);await c.query("insert into recurring_expense_occurrence(recurring_expense_id,due_on,expense_id,generated_by) values ($1,$2,$3,$4)",[t.id,due,e.rows[0].id,a.userId]);count++;}due=advance(due,t.frequency);}await c.query("update recurring_expense set next_due_on=$2,updated_at=now(),updated_by=$3 where id=$1",[t.id,due,a.userId]);}await writeAudit(c,{actorUserId:a.userId,action:"recurring_expenses_generated",entityType:"recurring_expense",entityId:null,after:{throughDate:through,count}});});good(String(count)+" recurring expense"+(count===1?"":"s")+" generated.");
}

export async function setRecurringExpenseStatusAction(d:FormData){
  const a=await requirePermission("recurring_expenses.manage"),recurring=id(v(d,"recurring_expense_id"),"recurring expense"),status=v(d,"status");if(!["active","paused","ended"].includes(status))bad("Invalid status.");
  await withTransaction(async c=>{const before=(await c.query("select * from recurring_expense where id=$1 for update",[recurring])).rows[0];if(!before)bad("Recurring expense not found.");await c.query("update recurring_expense set status=$2,updated_at=now(),updated_by=$3 where id=$1",[recurring,status,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"recurring_expense_status_updated",entityType:"recurring_expense",entityId:recurring,before,after:{status}});});good("Recurring expense status updated.");
}

export async function createReconciliationAction(d:FormData){
  const a=await requirePermission("banking.reconcile"),account=id(v(d,"account_id"),"cash/bank account"),start=day(v(d,"statement_starts_on"),"statement start"),end=day(v(d,"statement_ends_on"),"statement end"),openingRaw=v(d,"statement_opening_balance")||"0",raw=v(d,"statement_ending_balance");if(end<start)bad("Statement end cannot be before start.");if(!/^-?\\d+(?:\\.\\d{1,2})?$/.test(openingRaw))bad("Invalid opening balance.");if(!/^-?\\d+(?:\\.\\d{1,2})?$/.test(raw))bad("Invalid ending balance.");
  await withTransaction(async c=>{const number=await nextNo(c,"bank_reconciliation",a.userId);const r=await c.query<{id:string}>("insert into bank_reconciliation(reconciliation_number,account_id,statement_starts_on,statement_ends_on,statement_opening_balance,statement_ending_balance,notes,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",[number,account,start,end,Number(openingRaw).toFixed(2),Number(raw).toFixed(2),v(d,"notes")||null,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"bank_reconciliation_created",entityType:"bank_reconciliation",entityId:r.rows[0].id,after:{number,account,start,end,openingBalance:Number(openingRaw).toFixed(2),endingBalance:Number(raw).toFixed(2)}});});good("Reconciliation created.");
}
export async function addReconciliationItemAction(d:FormData){
  const a=await requirePermission("banking.reconcile"),recon=id(v(d,"reconciliation_id"),"reconciliation"),line=id(v(d,"journal_line_id"),"journal line");
  await withTransaction(async c=>{await c.query("insert into bank_reconciliation_item(reconciliation_id,journal_line_id,added_by) values ($1,$2,$3)",[recon,line,a.userId]);});good("Transaction marked cleared.");
}
export async function removeReconciliationItemAction(d:FormData){
  await requirePermission("banking.reconcile");const recon=id(v(d,"reconciliation_id"),"reconciliation"),line=id(v(d,"journal_line_id"),"journal line");await withTransaction(async c=>{await c.query("delete from bank_reconciliation_item where reconciliation_id=$1 and journal_line_id=$2",[recon,line]);});good("Transaction removed.");
}
export async function completeReconciliationAction(d:FormData){
  const a=await requirePermission("banking.reconcile"),recon=id(v(d,"reconciliation_id"),"reconciliation");await withTransaction(async c=>{await c.query("select complete_bank_reconciliation($1,$2)",[recon,a.userId]);await writeAudit(c,{actorUserId:a.userId,action:"bank_reconciliation_completed",entityType:"bank_reconciliation",entityId:recon,after:{status:"completed"}});});good("Reconciliation completed.");
}
