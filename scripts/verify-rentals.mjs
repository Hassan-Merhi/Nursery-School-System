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
async function expectFailure(label,work){
  const savepoint="sp_"+randomUUID().replaceAll("-","");
  await client.query("savepoint "+savepoint);
  let failed=false;
  try{await work();}catch{failed=true;await client.query("rollback to savepoint "+savepoint);}
  assert.equal(failed,true,label);
}
async function createAgreement(number,landlord,amount,start,end,deposit="0.00"){
  const r=await client.query(
    `insert into rental_agreement(
      agreement_number,landlord_id,property_name,property_address,start_on,end_on,
      recurring_amount,currency,frequency,due_day,deposit_amount
    ) values ($1,$2,$3,'CI rental property',$4,$5,$6,'USD','monthly',1,$7) returning id`,
    [number,landlord,"CI Property "+number,start,end,amount,deposit],
  );
  await client.query("select activate_rental_agreement($1,null)",[r.rows[0].id]);
  return r.rows[0].id;
}
async function payRent(number,agreement,bank,amount,date,paymentType="rent"){
  const r=await client.query(
    `insert into rent_payment(
      rent_payment_number,rental_agreement_id,payment_type,payment_account_id,
      amount,currency,paid_on,method
    ) values ($1,$2,$3,$4,$5,'USD',$6,'bank_transfer') returning id`,
    [number,agreement,paymentType,bank,amount,date],
  );
  if(paymentType==="rent")await client.query("select allocate_rent_payment($1,null)",[r.rows[0].id]);
  await client.query("select accounting_post_rent_payment($1,null)",[r.rows[0].id]);
  return r.rows[0].id;
}

try{
  await client.query("begin");
  const suffix=randomUUID().slice(0,8).toUpperCase();

  const required=["rentals.view","rentals.manage","rentals.pay","rentals.post","rental_documents.view","rental_documents.manage"];
  const perms=await client.query(
    `select rp.permission_key
     from role_permission rp join role r on r.id=rp.role_id
     where lower(r.name)='administrator' and rp.permission_key=any($1::text[])`,
    [required],
  );
  assert.equal(perms.rowCount,required.length,"Administrator must receive every Step 6 permission");

  const types=await client.query("select id,category from account_type where code=any($1::text[])",[["ASSET","LIABILITY","EQUITY","EXPENSE"]]);
  const type=Object.fromEntries(types.rows.map((x)=>[x.category,x.id]));
  assert.equal(Object.keys(type).length,4);

  await client.query(
    "insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-09-01','2027-03-31')",
    ["CI Step6 "+suffix],
  );
  const journal=(await client.query("insert into journal(code,name) values ($1,'CI Rentals Journal') returning id",["RNT-"+suffix])).rows[0].id;
  await client.query("update accounting_configuration set rentals_journal_id=$1 where id=1",[journal]);

  const bank=await createAccount("1010","Rental Bank",type.asset,suffix);
  const prepaid=await createAccount("1200","Prepaid Rent",type.asset,suffix);
  const deposit=await createAccount("1250","Rent Deposits",type.asset,suffix);
  const payable=await createAccount("2200","Rent Payable",type.liability,suffix);
  const equity=await createAccount("3000","Opening Net Position",type.equity,suffix);
  const rentExpense=await createAccount("6100","Rent Expense",type.expense,suffix);

  await client.query("insert into cash_bank_account(account_id,account_kind,display_name,bank_name) values ($1,'bank','Rental Bank','CI Bank')",[bank]);
  for(const [role,account] of [["rent_expense",rentExpense],["prepaid_rent",prepaid],["rent_payable",payable],["rent_deposit",deposit]]){
    await client.query(
      "insert into accounting_mapping(role_key,account_id) values ($1,$2) on conflict (role_key) do update set account_id=excluded.account_id",
      [role,account],
    );
  }

  const opening=(await client.query(
    `insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference)
     values ($1,'opening_balance','2026-09-01','USD','CI Step 6 opening balance',$2) returning id`,
    [journal,"CI6-OPEN-"+suffix],
  )).rows[0].id;
  await client.query(
    `insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit)
     values ($1,1,$2,'Opening bank',30000.00,0),($1,2,$3,'Opening net position',0,30000.00)`,
    [opening,bank,equity],
  );
  await client.query("select post_journal_entry($1,null)",[opening]);

  const landlord=(await client.query(
    "insert into landlord(landlord_number,name,contact_name,email) values ($1,'CI Landlord','CI Contact','landlord@example.invalid') returning id",
    ["CI6-LND-"+suffix],
  )).rows[0].id;

  const agreement=await createAgreement("CI6-RNT-"+suffix,landlord,"2000.00","2026-09-01","2027-02-28","1000.00");
  const schedule=await client.query("select * from rent_schedule where rental_agreement_id=$1 order by sequence",[agreement]);
  assert.equal(schedule.rowCount,6,"Six-month agreement must generate six schedule periods");
  assert.deepEqual(schedule.rows.map((x)=>x.amount),"2000.00".repeat(0)?[]:schedule.rows.map(()=>schedule.rows[0].amount));
  assert.equal(schedule.rows.every((x)=>x.amount==="2000.00"),true,"Each monthly schedule item must be 2,000.00");

  await expectFailure(
    "Activated rental financial terms must be immutable",
    ()=>client.query("update rental_agreement set recurring_amount=2100.00 where id=$1",[agreement]),
  );

  const prepayment=await payRent("CI6-RPAY-PRE-"+suffix,agreement,bank,"12000.00","2026-09-01");
  assert.equal(await balance(prepaid),"12000.00","Initial six-month prepayment must be an asset");
  assert.equal(await balance(rentExpense),"0.00","Prepayment must not create rent expense immediately");
  assert.equal(await balance(payable),"0.00");
  assert.equal(await balance(bank),"18000.00");

  const allocation=await client.query(
    "select allocation_type,count(*)::int as n,sum(amount)::numeric(14,2)::text as total from rent_payment_allocation where rent_payment_id=$1 group by allocation_type",
    [prepayment],
  );
  assert.equal(allocation.rows.length,1);
  assert.equal(allocation.rows[0].allocation_type,"prepaid");
  assert.equal(allocation.rows[0].n,6);
  assert.equal(allocation.rows[0].total,"12000.00");

  const monthEnds=["2026-09-30","2026-10-31","2026-11-30","2026-12-31","2027-01-31","2027-02-28"];
  for(let i=0;i<monthEnds.length;i++){
    const r=await client.query("select recognize_rent_through($1,$2,null)::int as count",[agreement,monthEnds[i]]);
    assert.equal(r.rows[0].count,1,"Each month-end run should recognize exactly one new period");
    assert.equal(await balance(prepaid),((5-i)*2000).toFixed(2),"Prepaid rent must fall by 2,000 each month");
    assert.equal(await balance(rentExpense),((i+1)*2000).toFixed(2),"Rent expense must rise by 2,000 each month");
    assert.equal(await balance(payable),"0.00","Fully prepaid rent must not create rent payable");
  }

  const milestone=(await client.query("select * from rental_agreement_balance where id=$1",[agreement])).rows[0];
  assert.equal(milestone.prepaid_rent_balance,"0.00","Milestone: prepaid rent must be zero after six periods");
  assert.equal(milestone.recognized_rent_expense,"12000.00","Milestone: six months must recognize 12,000 rent expense");
  assert.equal(milestone.rent_payable_balance,"0.00");
  assert.equal(await balance(prepaid),"0.00");
  assert.equal(await balance(rentExpense),"12000.00");

  // Reversing a consumed prepayment restores the cash and creates rent payable,
  // never a negative prepaid-rent asset.
  await client.query("select reverse_rent_payment($1,'2027-02-28',null,'CI prepayment reversal')",[prepayment]);
  assert.equal(await balance(prepaid),"0.00","Consumed prepaid reversal must not make prepaid rent negative");
  assert.equal(await balance(payable),"12000.00","Consumed prepaid reversal must reclass the obligation to rent payable");
  assert.equal(await balance(bank),"30000.00");
  const replacement=await payRent("CI6-RPAY-REPL-"+suffix,agreement,bank,"12000.00","2027-02-28");
  assert.ok(replacement);
  assert.equal(await balance(payable),"0.00","Replacement payment must clear rent payable");
  assert.equal(await balance(rentExpense),"12000.00","Payment reversal/replacement must not rewrite recognized expense");
  assert.equal(await balance(bank),"18000.00");

  const depositPayment=await payRent("CI6-RPAY-DEP-"+suffix,agreement,bank,"1000.00","2027-02-28","deposit");
  assert.ok(depositPayment);
  assert.equal(await balance(deposit),"1000.00","Refundable deposit must remain an asset, not rent expense");
  assert.equal(await balance(rentExpense),"12000.00");
  assert.equal(await balance(bank),"17000.00");

  const doc=(await client.query(
    "insert into stored_document(storage_key,original_name,mime_type,size_bytes,sha256) values ($1,'lease.pdf','application/pdf',1,$2) returning id",
    [randomUUID(),"b".repeat(64)],
  )).rows[0].id;
  const attachment=(await client.query(
    "insert into rental_attachment(rental_agreement_id,document_id,document_type,notes) values ($1,$2,'Lease','CI lease copy') returning id",
    [agreement,doc],
  )).rows[0].id;
  assert.ok(attachment);

  const payableAgreement=await createAgreement("CI6-RNT-PAY-"+suffix,landlord,"500.00","2027-03-01","2027-03-31");
  const recog=(await client.query("select accounting_recognize_rent_schedule(id,'2027-03-31',null) as id from rent_schedule where rental_agreement_id=$1",[payableAgreement])).rows[0].id;
  assert.ok(recog);
  assert.equal(await balance(payable),"500.00","Unpaid recognized rent must create rent payable");
  assert.equal(await balance(rentExpense),"12500.00");

  await client.query("select reverse_rent_recognition($1,'2027-03-31',null,'CI recognition correction')",[recog]);
  assert.equal(await balance(payable),"0.00","Recognition reversal must clear the accrued payable");
  assert.equal(await balance(rentExpense),"12000.00");
  const recog2=(await client.query("select accounting_recognize_rent_schedule(id,'2027-03-31',null) as id from rent_schedule where rental_agreement_id=$1",[payableAgreement])).rows[0].id;
  assert.ok(recog2);
  assert.equal(await balance(payable),"500.00");

  const payablePayment=await payRent("CI6-RPAY-DUE-"+suffix,payableAgreement,bank,"500.00","2027-03-31");
  assert.equal(await balance(payable),"0.00","Paying recognized rent must clear rent payable");
  await client.query("select reverse_rent_payment($1,'2027-03-31',null,'CI payable payment reversal')",[payablePayment]);
  assert.equal(await balance(payable),"500.00","Reversing a payable payment must restore rent payable");
  await payRent("CI6-RPAY-DUE2-"+suffix,payableAgreement,bank,"500.00","2027-03-31");
  assert.equal(await balance(payable),"0.00");

  const history=await client.query("select event_type from rental_history where rental_agreement_id=$1",[agreement]);
  const events=new Set(history.rows.map((x)=>x.event_type));
  for(const event of ["agreement_created","agreement_activated","rent_paid","rent_recognized","rent_payment_reversed","deposit_paid","attachment_added"]){
    assert.equal(events.has(event),true,"Rental history must contain "+event);
  }
  const oneHistory=(await client.query("select id from rental_history where rental_agreement_id=$1 limit 1",[agreement])).rows[0].id;
  await expectFailure("Rental history must be append-only",()=>client.query("update rental_history set summary='tampered' where id=$1",[oneHistory]));

  const agreementFinal=(await client.query("select * from rental_agreement_balance where id=$1",[agreement])).rows[0];
  assert.equal(agreementFinal.prepaid_rent_balance,"0.00");
  assert.equal(agreementFinal.rent_payable_balance,"0.00");
  assert.equal(agreementFinal.recognized_rent_expense,"12000.00");
  assert.equal(agreementFinal.deposit_paid,"1000.00");

  const tb=await client.query(
    "select sum(debit_balance)::numeric(14,2)::text as debit,sum(credit_balance)::numeric(14,2)::text as credit from trial_balance where currency='USD'",
  );
  assert.equal(tb.rows[0].debit,tb.rows[0].credit,"Step 6 trial balance must balance");

  console.log("Step 6 rentals verification passed.");
  console.log("Milestone 6: paid 12,000 for six months; initial prepaid rent 12,000; six month-end recognitions of 2,000; final prepaid rent 0.00 and rent expense 12,000.00.");
  console.log("Also verified rent payable/payment flow, refundable deposits, payment and recognition reversals, attachments, immutable agreement terms, append-only rent history, permissions, and balanced accounting.");

  await client.query("rollback");
}catch(error){
  try{await client.query("rollback");}catch{}
  throw error;
}finally{
  client.release();
  await pool.end();
}
