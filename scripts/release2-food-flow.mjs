import assert from "node:assert/strict";
import { allocateFood,balance,makePayment,reversePayment } from "./release2-test-support.mjs";

export async function runFoodFlow(ctx){
  const {client,pool,suffix,family,bank,ar,deposits,foodIncome}=ctx;
  const year=(await client.query(`insert into school_year(name,starts_on,ends_on,status) values ($1,'2026-09-01','2027-06-30','current') returning id`,["Release 2 2026-2027 "+suffix])).rows[0].id;
  const term=(await client.query(`insert into school_term(school_year_id,sequence,name,starts_on,ends_on,status) values ($1,1,'September-December','2026-09-01','2026-12-31','open') returning id`,[year])).rows[0].id;
  const schoolClass=(await client.query(`insert into school_class(school_year_id,name,capacity,status) values ($1,$2,30,'active') returning id`,[year,"Release 2 Montessori "+suffix])).rows[0].id;
  const student=(await client.query(`insert into student(family_id,first_name,last_name,date_of_birth,status,admission_date) values ($1,'Food','Release2','2022-01-01','active','2026-09-01') returning id`,[family])).rows[0].id;
  const enrollment=(await client.query(`insert into student_enrollment(student_id,school_year_id,class_id,status,enrolled_on,starts_on) values ($1,$2,$3,'enrolled','2026-09-01','2026-09-01') returning id`,[student,year,schoolClass])).rows[0].id;
  await client.query(`insert into student_term_enrollment(enrollment_id,school_year_id,term_id,status,starts_on,ends_on) values ($1,$2,$3,'enrolled','2026-09-01','2026-12-31')`,[enrollment,year,term]);
  const item=(await client.query("insert into food_item(code,name,status) values ($1,'Release 2 Lunch','active') returning id",["R2-LUNCH-"+suffix])).rows[0].id;
  await client.query(`insert into food_item_price(food_item_id,amount,currency,effective_from) values ($1,6,'USD','2026-09-01')`,[item]);
  const pkg=(await client.query(`insert into food_package(school_year_id,term_id,code,name,package_kind,package_price,currency,available_from,available_to,status) values ($1,$2,$3,'Release 2 Monthly Lunch','monthly',120,'USD','2026-10-01','2026-10-31','draft') returning id`,[year,term,"R2-PKG-"+suffix])).rows[0].id;
  await client.query("insert into food_package_item(food_package_id,food_item_id,quantity) values ($1,$2,1)",[pkg,item]);
  await client.query("update food_package set status='active' where id=$1",[pkg]);
  const selection=(await client.query(`insert into student_food_selection(family_id,student_id,school_year_id,term_id,food_package_id,unit_price,currency,quantity,starts_on,ends_on) values ($1,$2,$3,$4,$5,120,'USD',1,'2026-10-01','2026-10-31') returning id`,[family,student,year,term,pkg])).rows[0].id;

  async function issue(number,start,end,amount,date){
    const bill=(await client.query(`insert into food_bill(bill_number,family_id,student_id,school_year_id,term_id,food_package_id,student_food_selection_id,period_start,period_end,due_on,currency) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-10-05','USD') returning id`,[number,family,student,year,term,pkg,selection,start,end])).rows[0].id;
    await client.query(`insert into food_bill_line(food_bill_id,description,package_kind,quantity,unit_price) values ($1,'Release 2 food charge','monthly',1,$2)`,[bill,amount]);
    await client.query("select issue_food_bill($1,$2,null)",[bill,date]);
    return bill;
  }

  const bill=await issue("R2-FOOD-"+suffix,"2026-10-01","2026-10-31",120,"2026-10-01");
  assert.equal((await client.query("select count(*)::int n from student_ledger where entry_type='food_bill' and source_id=$1",[bill])).rows[0].n,1,"Food charge must appear on student account");
  assert.equal(await balance(client,ar),"120.00");
  assert.equal(await balance(client,foodIncome),"120.00");

  const p1=await makePayment(client,{number:"R2-FOOD-PAY-1-"+suffix,family,student,amount:"120.00",bank,date:"2026-10-02"});
  await allocateFood(client,{payment:p1,bill,amount:"120.00",date:"2026-10-02"});
  assert.equal((await client.query("select balance_amount::text v from food_bill_balance where id=$1",[bill])).rows[0].v,"0.00");
  assert.equal(await balance(client,bank),"120.00");
  assert.equal(await balance(client,ar),"0.00");
  assert.equal(await balance(client,deposits),"0.00");

  await reversePayment(client,p1,"2026-10-03","Release 2 payment reversal test");
  assert.equal((await client.query("select balance_amount::text v from food_bill_balance where id=$1",[bill])).rows[0].v,"120.00");
  assert.equal(await balance(client,bank),"0.00");
  const p2=await makePayment(client,{number:"R2-FOOD-PAY-2-"+suffix,family,student,amount:"120.00",bank,date:"2026-10-04"});
  await allocateFood(client,{payment:p2,bill,amount:"120.00",date:"2026-10-04"});

  const raceBill=await issue("R2-RACE-FOOD-"+suffix,"2026-10-01","2026-10-10",10,"2026-10-05");
  const rp1=await makePayment(client,{number:"R2-RACE-PAY-1-"+suffix,family,student,amount:"10.00",bank,date:"2026-10-05"});
  const rp2=await makePayment(client,{number:"R2-RACE-PAY-2-"+suffix,family,student,amount:"10.00",bank,date:"2026-10-05"});
  const e1=await pool.connect(),e2=await pool.connect();
  let winner;
  try{
    await e1.query("begin");
    winner=(await e1.query(`insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,10,'2026-10-05') returning id`,[rp1,raceBill])).rows[0].id;
    await e2.query("begin");
    const second=e2.query(`insert into food_payment_allocation(payment_id,food_bill_id,amount,allocated_on) values ($1,$2,10,'2026-10-05') returning id`,[rp2,raceBill]).then(()=>true).catch(()=>false);
    await new Promise(r=>setTimeout(r,100));
    await e1.query("commit");
    assert.equal(await second,false,"Concurrent food allocations must not overpay one bill");
    await e2.query("rollback");
  }finally{e1.release();e2.release();}
  await client.query("select accounting_post_food_payment_allocation($1,null)",[winner]);
  await reversePayment(client,rp2,"2026-10-06","Release 2 losing concurrent payment cleanup");
  assert.equal((await client.query("select balance_amount::text v from food_bill_balance where id=$1",[raceBill])).rows[0].v,"0.00");
  assert.equal(await balance(client,bank),"130.00");
  console.log("Food charge -> student account -> payment -> bank -> accounting concurrency path passed.");
  return {year,term,student,bill,raceBill,pkg,selection};
}
