import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool }=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required");
const pool=new Pool({connectionString});
const client=await pool.connect();

async function balance(accountId){
  const r=await client.query("select normal_balance::numeric(14,2)::text as balance from account_balance where account_id=$1",[accountId]);
  return r.rows[0]?.balance??"0.00";
}
async function createAccount(prefix,name,typeId,suffix){
  const r=await client.query("insert into account(code,name,account_type_id,currency,allow_posting) values ($1,$2,$3,'USD',true) returning id",[prefix+"-"+suffix,name,typeId]);
  return r.rows[0].id;
}
async function postExpense(number,expenseAccount,paymentAccount,amount,date,notes){
  const r=await client.query("insert into expense(expense_number,expense_account_id,payment_account_id,amount,currency,incurred_on,payment_method,notes,status,submitted_at,approved_at) values ($1,$2,$3,$4,'USD',$5,'cash',$6,'approved',now(),now()) returning id",[number,expenseAccount,paymentAccount,amount,date,notes]);
  await client.query("select accounting_post_expense($1,null)",[r.rows[0].id]);
  return r.rows[0].id;
}
async function createSupplierInvoice(number,supplier,expenseAccount,amount,date){
  const r=await client.query("insert into supplier_invoice(supplier_invoice_number,supplier_id,expense_account_id,amount,currency,invoice_date,due_on,status,approved_at) values ($1,$2,$3,$4,'USD',$5,$5,'approved',now()) returning id",[number,supplier,expenseAccount,amount,date]);
  await client.query("select accounting_post_supplier_invoice($1,null)",[r.rows[0].id]);
  return r.rows[0].id;
}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8).toUpperCase();

  const required=["expenses.view","expenses.manage","expenses.approve","expenses.post","suppliers.view","suppliers.manage","banking.view","banking.manage","banking.reconcile","recurring_expenses.view","recurring_expenses.manage","refunds.manage"];
  const perms=await client.query("select rp.permission_key from role_permission rp join role r on r.id=rp.role_id where lower(r.name)='administrator' and rp.permission_key=any($1::text[])",[required]);
  assert.equal(perms.rowCount,required.length,"Administrator must receive every Step 5 permission");

  const types=await client.query("select id,category from account_type where code=any($1::text[])",[["ASSET","LIABILITY","EQUITY","INCOME","EXPENSE"]]);
  const type=Object.fromEntries(types.rows.map((x)=>[x.category,x.id]));
  assert.equal(Object.keys(type).length,5);

  const period=await client.query("insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-10-01','2026-10-31') returning id",["CI Step5 October "+suffix]);
  assert.ok(period.rows[0].id);

  const journal=await client.query("insert into journal(code,name) values ($1,'CI Step 5 Journal') returning id",["OPS-"+suffix]);
  const journalId=journal.rows[0].id;
  await client.query("update accounting_configuration set billing_journal_id=$1,operations_journal_id=$1 where id=1",[journalId]);

  const bank=await createAccount("1010","Operating Bank",type.asset,suffix);
  const cash=await createAccount("1020","School Cash",type.asset,suffix);
  const clearing=await createAccount("1090","Cash Clearing",type.asset,suffix);
  const ar=await createAccount("1100","Student Receivables",type.asset,suffix);
  const deposits=await createAccount("2100","Parent Credits",type.liability,suffix);
  const ap=await createAccount("2200","Accounts Payable",type.liability,suffix);
  const income=await createAccount("4000","Tuition Income",type.income,suffix);
  const stationery=await createAccount("5100","Stationery",type.expense,suffix);
  const accountingFee=await createAccount("5200","Accounting Fee",type.expense,suffix);
  const socialMedia=await createAccount("5300","Social Media",type.expense,suffix);
  const food=await createAccount("5400","Food Supplies",type.expense,suffix);

  await client.query("insert into cash_bank_account(account_id,account_kind,display_name,bank_name) values ($1,'bank','Operating Bank','CI Bank'),($2,'cash','School Cash',null)",[bank,cash]);

  for(const [role,account] of [["accounts_receivable",ar],["billing_income",income],["customer_deposits",deposits],["payment_asset",bank],["accounts_payable",ap]]){
    await client.query("insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict (role_key) do update set account_id=excluded.account_id",[role,account]);
  }

  const year=await client.query("insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','planned') returning id",["CI-STEP5-"+suffix]);
  const yearId=year.rows[0].id;
  const term=await client.query("insert into school_term(school_year_id,sequence,name,starts_on,ends_on) values ($1,1,'September–December','2026-09-01','2026-12-31') returning id",[yearId]);
  const termId=term.rows[0].id;
  const fee=await client.query("insert into fee_schedule(school_year_id,term_id,name,standard_fee,currency,status,activated_at) values ($1,$2,$3,1000.00,'USD','active',now()) returning id",[yearId,termId,"CI Step5 Tuition"]);
  const feeId=fee.rows[0].id;

  const families=[];
  for(let i=1;i<=10;i++){
    const fam=await client.query("insert into family(display_name) values ($1) returning id",["CI Step5 Family "+i+" "+suffix]);
    const familyId=fam.rows[0].id;
    families.push(familyId);
    const stu=await client.query("insert into student(family_id,first_name,last_name,date_of_birth,status,admission_date) values ($1,$2,$3,'2022-01-01','active','2026-09-01') returning id",[familyId,"Child"+i,"Step5"]);
    const studentId=stu.rows[0].id;

    const inv=await client.query("insert into invoice(invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,currency,due_on) values ($1,$2,$3,$4,$5,$6,'USD','2026-10-05') returning id",["CI5-INV-"+i+"-"+suffix,familyId,studentId,yearId,termId,feeId]);
    const invoiceId=inv.rows[0].id;
    await client.query("insert into invoice_line(invoice_id,line_type,description,gross_amount) values ($1,'nursery_fee','October tuition',1000.00)",[invoiceId]);
    await client.query("update invoice set status='issued',issued_on='2026-10-01' where id=$1",[invoiceId]);
    await client.query("select accounting_post_invoice($1,null)",[invoiceId]);

    const receiveInto=i<=5?cash:bank;
    const method=i===10?"check":i<=5?"cash":"bank_transfer";
    const payment=await client.query("insert into payment(receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id,cheque_number) values ($1,$2,$3,'payment',1000.00,'USD','2026-10-03',$4,$5,$6) returning id",["CI5-REC-"+i+"-"+suffix,familyId,studentId,method,receiveInto,method==="check"?"CHQ-"+suffix:null]);
    const paymentId=payment.rows[0].id;
    await client.query("select accounting_post_payment($1,null)",[paymentId]);
    const alloc=await client.query("insert into payment_allocation(payment_id,invoice_id,amount,allocated_on) values ($1,$2,1000.00,'2026-10-03') returning id",[paymentId,invoiceId]);
    await client.query("select accounting_post_payment_allocation($1,null)",[alloc.rows[0].id]);
  }

  assert.equal(await balance(ar),"0.00","Ten tuition payments must clear receivables");
  assert.equal(await balance(income),"10000.00","Ten tuition invoices must produce 10,000 income");
  assert.equal(await balance(bank),"5000.00");
  assert.equal(await balance(cash),"5000.00");

  const prepay=await client.query("insert into payment(receipt_number,family_id,payment_kind,amount,currency,received_on,method,payment_account_id) values ($1,$2,'prepayment',300.00,'USD','2026-10-04','cash',$3) returning id",["CI5-PRE-"+suffix,families[0],cash]);
  await client.query("select accounting_post_payment($1,null)",[prepay.rows[0].id]);
  assert.equal((await client.query("select available_credit::text from family_credit_balance where family_id=$1 and currency='USD'",[families[0]])).rows[0].available_credit,"300.00");

  const refund=await client.query("insert into parent_refund(refund_number,family_id,payment_account_id,amount,currency,refunded_on,method,reason) values ($1,$2,$3,100.00,'USD','2026-10-05','cash','Return excess tuition credit') returning id",["CI5-REF-"+suffix,families[0],cash]);
  await client.query("select accounting_post_parent_refund($1,null)",[refund.rows[0].id]);
  assert.equal((await client.query("select available_credit::text from family_credit_balance where family_id=$1 and currency='USD'",[families[0]])).rows[0].available_credit,"200.00");

  const refund2=await client.query("insert into parent_refund(refund_number,family_id,payment_account_id,amount,currency,refunded_on,method,reason) values ($1,$2,$3,50.00,'USD','2026-10-05','cash','CI reversible refund') returning id",["CI5-REF2-"+suffix,families[0],cash]);
  await client.query("select accounting_post_parent_refund($1,null)",[refund2.rows[0].id]);
  await client.query("select reverse_operational_source('parent_refund',$1,'2026-10-05',null,'CI refund reversal')",[refund2.rows[0].id]);
  await client.query("update parent_refund set status='reversed',reversed_at=now(),reversal_reason='CI refund reversal' where id=$1",[refund2.rows[0].id]);
  assert.equal((await client.query("select available_credit::text from family_credit_balance where family_id=$1 and currency='USD'",[families[0]])).rows[0].available_credit,"200.00");

  const supplier=await client.query("insert into supplier(supplier_number,name,default_expense_account_id,default_payment_account_id,payment_terms_days) values ($1,'CI Office Supplier',$2,$3,30) returning id",["CI5-SUP-"+suffix,stationery,bank]);
  const supplierId=supplier.rows[0].id;

  const exp1=await postExpense("CI5-EXP-ST-"+suffix,stationery,cash,"200.00","2026-10-06","Stationery purchase");
  const doc=await client.query("insert into stored_document(storage_key,original_name,mime_type,size_bytes,sha256) values ($1,'stationery-receipt.pdf','application/pdf',1,$2) returning id",[randomUUID(),"a".repeat(64)]);
  await client.query("insert into expense_receipt(expense_id,document_id) values ($1,$2)",[exp1,doc.rows[0].id]);
  assert.equal((await client.query("select count(*)::int as n from expense_receipt where expense_id=$1",[exp1])).rows[0].n,1);

  const accountantBill=await createSupplierInvoice("CI5-BILL-ACC-"+suffix,supplierId,accountingFee,"400.00","2026-10-07");
  const supplierPayment=await client.query("insert into supplier_payment(supplier_payment_number,supplier_id,supplier_invoice_id,payment_account_id,amount,currency,paid_on,method) values ($1,$2,$3,$4,400.00,'USD','2026-10-08','bank_transfer') returning id",["CI5-SPAY-"+suffix,supplierId,accountantBill,bank]);
  await client.query("select accounting_post_supplier_payment($1,null)",[supplierPayment.rows[0].id]);
  assert.equal((await client.query("select balance_amount::text from supplier_invoice_balance where id=$1",[accountantBill])).rows[0].balance_amount,"0.00");

  const socialTemplate=await client.query("insert into recurring_expense(name,category_key,supplier_id,expense_account_id,payment_account_id,amount,currency,frequency,next_due_on,payment_method,status) values ('Monthly social media','social_media',$1,$2,$3,300.00,'USD','monthly','2026-11-10','bank_transfer','active') returning id",[supplierId,socialMedia,bank]);
  const socialExpense=await postExpense("CI5-EXP-SOC-"+suffix,socialMedia,bank,"300.00","2026-10-10","Monthly social media");
  await client.query("insert into recurring_expense_occurrence(recurring_expense_id,due_on,expense_id) values ($1,'2026-10-10',$2)",[socialTemplate.rows[0].id,socialExpense]);
  const recurringCount=await client.query("select count(*)::int as n from recurring_expense_category");
  assert.equal(recurringCount.rows[0].n,6,"Recurring expense categories must include the six requested groups");

  await postExpense("CI5-EXP-FOOD-"+suffix,food,cash,"250.00","2026-10-11","Food supplies");

  const testBill=await createSupplierInvoice("CI5-BILL-TEST-"+suffix,supplierId,stationery,"100.00","2026-10-12");
  const testPay=await client.query("insert into supplier_payment(supplier_payment_number,supplier_id,supplier_invoice_id,payment_account_id,amount,currency,paid_on,method) values ($1,$2,$3,$4,100.00,'USD','2026-10-12','bank_transfer') returning id",["CI5-SPAY2-"+suffix,supplierId,testBill,bank]);
  await client.query("select accounting_post_supplier_payment($1,null)",[testPay.rows[0].id]);
  await client.query("select reverse_operational_source('supplier_payment',$1,'2026-10-12',null,'CI supplier payment reversal')",[testPay.rows[0].id]);
  await client.query("update supplier_payment set status='reversed',reversed_at=now(),reversal_reason='CI supplier payment reversal' where id=$1",[testPay.rows[0].id]);
  const credit=await client.query("insert into supplier_credit(supplier_credit_number,supplier_id,supplier_invoice_id,expense_account_id,amount,currency,credited_on,reason) values ($1,$2,$3,$4,100.00,'USD','2026-10-13','Supplier returned charge') returning id",["CI5-SCR-"+suffix,supplierId,testBill,stationery]);
  await client.query("select accounting_post_supplier_credit($1,null)",[credit.rows[0].id]);
  assert.equal((await client.query("select balance_amount::text from supplier_invoice_balance where id=$1",[testBill])).rows[0].balance_amount,"0.00");

  const directReversal=await postExpense("CI5-EXP-REV-"+suffix,stationery,bank,"25.00","2026-10-14","Reversible expense");
  await client.query("select reverse_operational_source('expense',$1,'2026-10-14',null,'CI expense reversal')",[directReversal]);
  await client.query("update expense set status='reversed',reversed_at=now(),reversal_reason='CI expense reversal' where id=$1",[directReversal]);

  const transfer=await client.query("insert into cash_bank_transaction(transaction_number,transaction_kind,account_id,contra_account_id,amount,currency,transaction_date,notes) values ($1,'transfer',$2,$3,1000.00,'USD','2026-10-15','Deposit cash into bank') returning id",["CI5-TRF-"+suffix,bank,cash]);
  await client.query("select accounting_post_cash_bank_transaction($1,null)",[transfer.rows[0].id]);

  const deposit=await client.query("insert into cash_bank_transaction(transaction_number,transaction_kind,account_id,contra_account_id,amount,currency,transaction_date) values ($1,'deposit',$2,$3,50.00,'USD','2026-10-16') returning id",["CI5-DEP-"+suffix,bank,clearing]);
  await client.query("select accounting_post_cash_bank_transaction($1,null)",[deposit.rows[0].id]);
  const withdrawal=await client.query("insert into cash_bank_transaction(transaction_number,transaction_kind,account_id,contra_account_id,amount,currency,transaction_date) values ($1,'withdrawal',$2,$3,50.00,'USD','2026-10-17') returning id",["CI5-WD-"+suffix,bank,clearing]);
  await client.query("select accounting_post_cash_bank_transaction($1,null)",[withdrawal.rows[0].id]);
  assert.equal(await balance(clearing),"0.00");

  assert.equal(await balance(bank),"5300.00","Bank ending balance must reconcile");
  assert.equal(await balance(cash),"3750.00","Cash ending balance must reconcile");
  assert.equal(await balance(deposits),"200.00","Parent credits must remain a liability");
  assert.equal(await balance(ap),"0.00","Supplier payables must be fully settled");
  assert.equal(await balance(stationery),"200.00");
  assert.equal(await balance(accountingFee),"400.00");
  assert.equal(await balance(socialMedia),"300.00");
  assert.equal(await balance(food),"250.00");

  const position=(await client.query("select * from accounting_position where currency='USD'")).rows[0];
  assert.equal(position.assets,"9050.00");
  assert.equal(position.liabilities,"200.00");
  assert.equal(position.income,"10000.00");
  assert.equal(position.expenses,"1150.00");
  assert.equal(position.current_surplus,"8850.00");
  assert.equal(position.net_position,"8850.00");
  assert.equal(position.equation_difference,"0.00");

  const tb=await client.query("select sum(debit_balance)::numeric(14,2)::text as debit,sum(credit_balance)::numeric(14,2)::text as credit from trial_balance where currency='USD'");
  assert.equal(tb.rows[0].debit,tb.rows[0].credit,"Trial balance must balance");

  const statement=await client.query("select entry_type,running_payable_balance::text as running_payable_balance from supplier_statement where supplier_id=$1 order by entry_date,occurred_at,source_id",[supplierId]);
  const statementTypes=new Set(statement.rows.map((row)=>row.entry_type));
  assert.equal(statementTypes.has("invoice"),true,"Supplier statement must include invoices");
  assert.equal(statementTypes.has("payment"),true,"Supplier statement must include payments");
  assert.equal(statementTypes.has("credit"),true,"Supplier statement must include credits");
  assert.equal(statement.rows.at(-1)?.running_payable_balance,"0.00","Supplier statement must end with zero payable balance");

  const recon=await client.query("insert into bank_reconciliation(reconciliation_number,account_id,statement_starts_on,statement_ends_on,statement_ending_balance) values ($1,$2,'2026-10-01','2026-10-31',5300.00) returning id",["CI5-REC-BANK-"+suffix,bank]);
  const reconId=recon.rows[0].id;
  const bankLines=await client.query("select jl.id from journal_line jl join journal_entry je on je.id=jl.journal_entry_id where jl.account_id=$1 and je.status in ('posted','reversed') and je.posting_date between '2026-10-01' and '2026-10-31'",[bank]);
  for(const line of bankLines.rows)await client.query("insert into bank_reconciliation_item(reconciliation_id,journal_line_id) values ($1,$2)",[reconId,line.id]);
  const summary=(await client.query("select difference::text,reconciled_book_balance::text from bank_reconciliation_summary where id=$1",[reconId])).rows[0];
  assert.equal(summary.reconciled_book_balance,"5300.00");
  assert.equal(summary.difference,"0.00");
  await client.query("select complete_bank_reconciliation($1,null)",[reconId]);
  assert.equal((await client.query("select status from bank_reconciliation where id=$1",[reconId])).rows[0].status,"completed");

  console.log("Step 5 operations verification passed.");
  console.log("Sample month: 10 tuition payments, stationery, accountant, social media, food supplies, parent credit/refund, supplier credit, cash-to-bank transfer, deposit/withdrawal, and reconciliation.");
  console.log("Final: bank 5300.00 + cash 3750.00 = 9050.00 assets; receivables 0.00; liabilities 200.00; payables 0.00; income 10000.00; expenses 1150.00; net position 8850.00; equation difference 0.00.");

  await client.query("rollback");
}catch(error){
  try{await client.query("rollback");}catch{}
  throw error;
}finally{
  client.release();
  await pool.end();
}
