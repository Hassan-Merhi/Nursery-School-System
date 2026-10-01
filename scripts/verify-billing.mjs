import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

async function expectFailure(label, work) {
  const savepoint = `sp_${Math.random().toString(16).slice(2)}`;
  await client.query(`savepoint ${savepoint}`);
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
    await client.query(`rollback to savepoint ${savepoint}`);
  }
  assert.equal(failed, true, label);
}

async function discountTotal(studentId, termId, baseAmount) {
  const result = await client.query(
    `select coalesce(sum(applied_amount),0)::numeric(12,2)::text as amount
     from billing_discount_breakdown($1,$2,$3::numeric)`,
    [studentId, termId, baseAmount],
  );
  return result.rows[0].amount;
}

async function createInvoice({
  familyId,
  studentId,
  schoolYearId,
  termId,
  feeScheduleId,
  termName,
  fee,
}) {
  const invoiceNumber = `CI-INV-${randomUUID()}`;
  const invoice = await client.query(
    `insert into invoice(
       invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,
       currency,due_on
     ) values ($1,$2,$3,$4,$5,$6,'USD','2026-09-01')
     returning id`,
    [invoiceNumber, familyId, studentId, schoolYearId, termId, feeScheduleId],
  );
  const invoiceId = invoice.rows[0].id;

  const line = await client.query(
    `insert into invoice_line(invoice_id,line_type,description,gross_amount)
     values ($1,'nursery_fee',$2,$3)
     returning id`,
    [invoiceId, `Standard nursery fee — ${termName}`, fee],
  );
  const lineId = line.rows[0].id;

  const breakdown = await client.query(
    "select * from billing_discount_breakdown($1,$2,$3::numeric)",
    [studentId, termId, fee],
  );

  let discount = 0;
  for (const row of breakdown.rows) {
    discount += Number(row.applied_amount);
    await client.query(
      `insert into invoice_line_discount(
         invoice_line_id,student_discount_id,discount_label,discount_kind,
         discount_value,priority,application_order,applied_amount,combination_mode
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        lineId,
        row.student_discount_id,
        row.discount_label,
        row.discount_kind,
        row.discount_value,
        row.priority,
        row.application_order,
        row.applied_amount,
        row.combination_mode,
      ],
    );
  }

  await client.query(
    "update invoice_line set discount_amount=$2 where id=$1",
    [lineId, discount.toFixed(2)],
  );
  await client.query(
    "update invoice set status='issued',issued_on=current_date where id=$1",
    [invoiceId],
  );
  await client.query("select refresh_invoice_status($1)", [invoiceId]);

  return { invoiceId, lineId, invoiceNumber };
}

try {
  await client.query("begin");

  const requiredPermissions = [
    "billing.view",
    "billing.manage",
    "discounts.view",
    "discounts.manage",
    "discounts.approve",
    "payments.view",
    "payments.manage",
  ];
  const adminPermissions = await client.query(
    `select rp.permission_key
     from role_permission rp
     join role r on r.id=rp.role_id
     where lower(r.name)='administrator'
       and rp.permission_key=any($1::text[])`,
    [requiredPermissions],
  );
  assert.equal(
    adminPermissions.rowCount,
    requiredPermissions.length,
    "Administrator must receive every Step 3 permission",
  );

  const family = await client.query(
    "insert into family(display_name) values ('CI Billing Family') returning id",
  );
  const familyId = family.rows[0].id;

  const students = {};
  for (const [key, firstName] of [
    ["a", "Child A"],
    ["b", "Child B"],
    ["c", "Child C"],
  ]) {
    const inserted = await client.query(
      `insert into student(family_id,first_name,last_name,date_of_birth,status)
       values ($1,$2,'Billing','2022-01-01','active')
       returning id`,
      [familyId, firstName],
    );
    students[key] = inserted.rows[0].id;
  }

  const year = await client.query(
    `insert into school_year(name,starts_on,ends_on,status)
     values ($1,'2026-09-01','2027-06-30','planned')
     returning id`,
    [`CI-BILLING-${randomUUID()}`],
  );
  const schoolYearId = year.rows[0].id;

  const terms = await client.query(
    `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
     values
       ($1,1,'September–December','2026-09-01','2026-12-31'),
       ($1,2,'January–March','2027-01-01','2027-03-31'),
       ($1,3,'April–June','2027-04-01','2027-06-30')
     returning id,sequence,name`,
    [schoolYearId],
  );
  const term1 = terms.rows.find((row) => row.sequence === 1);
  const termId = term1.id;

  const schoolClass = await client.query(
    `insert into school_class(school_year_id,name,status)
     values ($1,'CI Billing Casa','active')
     returning id`,
    [schoolYearId],
  );
  const classId = schoolClass.rows[0].id;

  for (const studentId of Object.values(students)) {
    const enrollment = await client.query(
      `insert into student_enrollment(student_id,school_year_id,class_id,starts_on)
       values ($1,$2,$3,'2026-09-01')
       returning id`,
      [studentId, schoolYearId, classId],
    );
    await client.query(
      `insert into student_term_enrollment(
         enrollment_id,school_year_id,term_id,starts_on,ends_on
       ) values ($1,$2,$3,'2026-09-01','2026-12-31')`,
      [enrollment.rows[0].id, schoolYearId, termId],
    );
  }

  const schedule = await client.query(
    `insert into fee_schedule(
       school_year_id,term_id,name,standard_fee,currency,status,activated_at
     ) values ($1,$2,'CI Standard',1000.00,'USD','active',now())
     returning id`,
    [schoolYearId, termId],
  );
  const feeScheduleId = schedule.rows[0].id;

  const definitions = await client.query(
    `select id,code from discount_definition
     where code in ('SIBLING10','TEACHER50','CUSTOM')`,
  );
  const definition = Object.fromEntries(definitions.rows.map((row) => [row.code, row.id]));

  const siblingDiscount = await client.query(
    `insert into student_discount(
       student_id,school_year_id,term_id,discount_definition_id,status,
       eligibility_note,reviewed_at
     ) values ($1,$2,$3,$4,'approved','CI sibling test',now())
     returning id`,
    [students.b, schoolYearId, termId, definition.SIBLING10],
  );

  const customDiscount = await client.query(
    `insert into student_discount(
       student_id,school_year_id,term_id,discount_definition_id,
       custom_name,override_kind,override_value,status,eligibility_note,reviewed_at
     ) values ($1,$2,$3,$4,'CI custom 150','fixed',150.00,'approved','CI custom test',now())
     returning id`,
    [students.c, schoolYearId, termId, definition.CUSTOM],
  );

  await client.query(
    `insert into discount_history(student_discount_id,event_type,snapshot,note)
     values ($1,'approved',$2::jsonb,'CI history')`,
    [
      siblingDiscount.rows[0].id,
      JSON.stringify({ code: "SIBLING10", value: 10, status: "approved" }),
    ],
  );

  await expectFailure(
    "Discount history must be append-only",
    () => client.query(
      "update discount_history set note='tampered' where student_discount_id=$1",
      [siblingDiscount.rows[0].id],
    ),
  );

  await client.query(
    `update billing_configuration
     set discount_combination_mode='best_single',max_discount_percent=100
     where id=1`,
  );

  assert.equal(await discountTotal(students.a, termId, "1000.00"), "0.00");
  assert.equal(await discountTotal(students.b, termId, "1000.00"), "100.00");
  assert.equal(await discountTotal(students.c, termId, "1000.00"), "150.00");

  const invoiceA = await createInvoice({
    familyId,
    studentId: students.a,
    schoolYearId,
    termId,
    feeScheduleId,
    termName: term1.name,
    fee: "1000.00",
  });
  const invoiceB = await createInvoice({
    familyId,
    studentId: students.b,
    schoolYearId,
    termId,
    feeScheduleId,
    termName: term1.name,
    fee: "1000.00",
  });
  const invoiceC = await createInvoice({
    familyId,
    studentId: students.c,
    schoolYearId,
    termId,
    feeScheduleId,
    termName: term1.name,
    fee: "1000.00",
  });

  const milestoneBalances = await client.query(
    `select student_id,total_amount::numeric(12,2)::text as total
     from invoice
     where id=any($1::uuid[])`,
    [[invoiceA.invoiceId, invoiceB.invoiceId, invoiceC.invoiceId]],
  );
  const totalByStudent = Object.fromEntries(
    milestoneBalances.rows.map((row) => [row.student_id, row.total]),
  );
  assert.equal(totalByStudent[students.a], "1000.00", "Child A normal fee must be 1000.00");
  assert.equal(totalByStudent[students.b], "900.00", "Child B sibling fee must be 900.00");
  assert.equal(totalByStudent[students.c], "850.00", "Child C custom-discount fee must be 850.00");

  await expectFailure(
    "Issued invoice lines must be immutable",
    () => client.query(
      `insert into invoice_line(invoice_id,line_type,description,gross_amount)
       values ($1,'additional_charge','Late mutation',25.00)`,
      [invoiceA.invoiceId],
    ),
  );

  await client.query(
    `insert into student_discount(
       student_id,school_year_id,term_id,discount_definition_id,status,
       eligibility_note,reviewed_at
     ) values ($1,$2,$3,$4,'approved','CI teacher-child test',now())`,
    [students.b, schoolYearId, termId, definition.TEACHER50],
  );

  const expectedCombined = {
    best_single: "500.00",
    additive: "600.00",
    sequential: "550.00",
  };
  for (const [mode, expected] of Object.entries(expectedCombined)) {
    await client.query(
      "update billing_configuration set discount_combination_mode=$1 where id=1",
      [mode],
    );
    assert.equal(
      await discountTotal(students.b, termId, "1000.00"),
      expected,
      `Combined discount mode ${mode} must be explicit and deterministic`,
    );
  }

  const originalInvoiceB = await client.query(
    `select total_amount::numeric(12,2)::text as total
     from invoice where id=$1`,
    [invoiceB.invoiceId],
  );
  assert.equal(
    originalInvoiceB.rows[0].total,
    "900.00",
    "Changing discount configuration must not rewrite an already issued invoice snapshot",
  );

  await client.query(
    "update billing_configuration set discount_combination_mode='best_single' where id=1",
  );

  const payment1 = await client.query(
    `insert into payment(
       receipt_number,family_id,payment_kind,amount,currency,received_on,method
     ) values ($1,$2,'payment',400.00,'USD','2026-09-01','cash')
     returning id`,
    [`CI-REC-${randomUUID()}`, familyId],
  );
  await client.query(
    `insert into payment_allocation(payment_id,invoice_id,amount)
     values ($1,$2,400.00)`,
    [payment1.rows[0].id, invoiceB.invoiceId],
  );

  let balance = await client.query(
    `select i.status,b.balance_amount::text
     from invoice i join invoice_balance b on b.id=i.id
     where i.id=$1`,
    [invoiceB.invoiceId],
  );
  assert.equal(balance.rows[0].status, "partially_paid");
  assert.equal(balance.rows[0].balance_amount, "500.00");

  const payment2 = await client.query(
    `insert into payment(
       receipt_number,family_id,payment_kind,amount,currency,received_on,method
     ) values ($1,$2,'payment',600.00,'USD','2026-09-02','bank_transfer')
     returning id`,
    [`CI-REC-${randomUUID()}`, familyId],
  );
  await client.query(
    `insert into payment_allocation(payment_id,invoice_id,amount)
     values ($1,$2,500.00)`,
    [payment2.rows[0].id, invoiceB.invoiceId],
  );

  balance = await client.query(
    `select i.status,b.balance_amount::text
     from invoice i join invoice_balance b on b.id=i.id
     where i.id=$1`,
    [invoiceB.invoiceId],
  );
  assert.equal(balance.rows[0].status, "paid");
  assert.equal(balance.rows[0].balance_amount, "0.00");

  const overpayment = await client.query(
    `select unallocated_amount::text,balance_type
     from payment_balance where id=$1`,
    [payment2.rows[0].id],
  );
  assert.equal(overpayment.rows[0].unallocated_amount, "100.00");
  assert.equal(overpayment.rows[0].balance_type, "overpayment");

  const prepayment = await client.query(
    `insert into payment(
       receipt_number,family_id,payment_kind,amount,currency,received_on,method
     ) values ($1,$2,'prepayment',200.00,'USD','2026-08-15','cash')
     returning id`,
    [`CI-REC-${randomUUID()}`, familyId],
  );
  const prepaymentBalance = await client.query(
    `select unallocated_amount::text,balance_type
     from payment_balance where id=$1`,
    [prepayment.rows[0].id],
  );
  assert.equal(prepaymentBalance.rows[0].unallocated_amount, "200.00");
  assert.equal(prepaymentBalance.rows[0].balance_type, "prepayment");

  const credit = await client.query(
    `insert into credit_note(
       credit_note_number,family_id,student_id,original_invoice_id,
       amount,currency,reason,issued_on
     ) values ($1,$2,$3,$4,50.00,'USD','CI correction','2026-09-03')
     returning id`,
    [`CI-CRN-${randomUUID()}`, familyId, students.c, invoiceC.invoiceId],
  );
  await client.query(
    `insert into credit_note_allocation(credit_note_id,invoice_id,amount)
     values ($1,$2,50.00)`,
    [credit.rows[0].id, invoiceC.invoiceId],
  );

  let creditAdjusted = await client.query(
    `select i.status,b.balance_amount::text,b.credit_amount::text
     from invoice i join invoice_balance b on b.id=i.id
     where i.id=$1`,
    [invoiceC.invoiceId],
  );
  assert.equal(creditAdjusted.rows[0].status, "partially_paid");
  assert.equal(creditAdjusted.rows[0].balance_amount, "800.00");
  assert.equal(creditAdjusted.rows[0].credit_amount, "50.00");

  await client.query(
    `update credit_note
     set status='reversed',reversed_at=now(),reversal_reason='CI reversal'
     where id=$1`,
    [credit.rows[0].id],
  );
  creditAdjusted = await client.query(
    `select i.status,b.balance_amount::text,b.credit_amount::text
     from invoice i join invoice_balance b on b.id=i.id
     where i.id=$1`,
    [invoiceC.invoiceId],
  );
  assert.equal(creditAdjusted.rows[0].status, "issued");
  assert.equal(creditAdjusted.rows[0].balance_amount, "850.00");
  assert.equal(creditAdjusted.rows[0].credit_amount, "0.00");

  const familyLedger = await client.query(
    "select count(*)::int as count from family_ledger where family_id=$1",
    [familyId],
  );
  assert.ok(familyLedger.rows[0].count >= 6, "Family ledger must include invoices and funds");

  const studentLedger = await client.query(
    "select count(*)::int as count from student_ledger where student_id=$1",
    [students.b],
  );
  assert.ok(studentLedger.rows[0].count >= 3, "Student ledger must include invoice and allocated payments");

  console.log("Step 3 billing verification passed.");
  console.log("Milestone balances: Child A 1000.00, Child B 900.00, Child C 850.00.");
  console.log("Combined discounts on 1000.00: best_single 500.00, additive 600.00, sequential 550.00.");
  console.log("Partial payments, overpayments, prepayments, credit notes, reversals, ledgers and immutability passed.");

  await client.query("rollback");
} catch (error) {
  try {
    await client.query("rollback");
  } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
