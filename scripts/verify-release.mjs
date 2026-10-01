import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toLowerCase();
const scratchName = "montikids_release_" + suffix;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const scratchUrl = new URL(sourceUrl);
scratchUrl.pathname = "/" + scratchName;

const admin = new Pool({ connectionString: adminUrl.toString() });
let pool;

async function expectFailure(label, work) {
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
  }
  assert.equal(failed, true, label);
}

async function expectFailureInTransaction(client, label, work) {
  const savepoint = "sp_" + randomUUID().replaceAll("-", "");
  await client.query("savepoint " + savepoint);
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
    await client.query("rollback to savepoint " + savepoint);
  }
  if (!failed) {
    await client.query("rollback to savepoint " + savepoint);
  }
  await client.query("release savepoint " + savepoint);
  assert.equal(failed, true, label);
}

async function migrateScratch(client) {
  await client.query(`
    create table if not exists schema_migration (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = path.resolve("db");
  const migrations = (await readdir(dir))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  const hardeningIndex = migrations.indexOf("016_release1_hardening.sql");
  assert.ok(hardeningIndex >= 0, "Step 9 migration must exist");

  for (const filename of migrations.slice(0, hardeningIndex)) {
    await client.query(await readFile(path.join(dir, filename), "utf8"));
    await client.query("insert into schema_migration(filename) values ($1)", [filename]);
  }

  const legacyYear = (
    await client.query(
      `insert into school_year(name,starts_on,ends_on,status)
       values ($1,'2025-09-01','2026-06-30','closed') returning id`,
      ["Legacy migration year " + suffix],
    )
  ).rows[0].id;
  const legacyTerm = (
    await client.query(
      `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
       values ($1,1,'Legacy Term 1','2025-09-01','2025-12-31') returning id`,
      [legacyYear],
    )
  ).rows[0].id;

  for (const filename of migrations.slice(hardeningIndex)) {
    await client.query(await readFile(path.join(dir, filename), "utf8"));
    await client.query("insert into schema_migration(filename) values ($1)", [filename]);
  }

  const migrated = (
    await client.query("select status from school_term where id=$1", [legacyTerm])
  ).rows[0];
  assert.equal(migrated.status, "open", "Existing terms must migrate safely with an explicit status");

  const applied = (
    await client.query("select count(*)::int count from schema_migration")
  ).rows[0].count;
  assert.equal(applied, migrations.length, "Every migration must be recorded in the scratch database");

  return { legacyTerm, migrationCount: applied };
}

async function createAccount(client, code, name, typeId) {
  return (
    await client.query(
      `insert into account(code,name,account_type_id,currency,allow_posting)
       values ($1,$2,$3,'USD',true) returning id`,
      [code + "-" + suffix, name, typeId],
    )
  ).rows[0].id;
}

async function currentBalance(client, accountId) {
  const row = (
    await client.query(
      "select normal_balance::numeric(14,2)::text balance from account_balance where account_id=$1",
      [accountId],
    )
  ).rows[0];
  return row?.balance ?? "0.00";
}

async function makeStudent(client, familyName, firstName, year, schoolClass, term) {
  const family = (
    await client.query("insert into family(display_name) values ($1) returning id", [
      familyName + " " + suffix,
    ])
  ).rows[0].id;
  const student = (
    await client.query(
      `insert into student(family_id,first_name,last_name,date_of_birth,status,admission_date)
       values ($1,$2,'Release','2022-01-01','active','2026-09-01') returning id`,
      [family, firstName],
    )
  ).rows[0].id;
  const enrollment = (
    await client.query(
      `insert into student_enrollment(
         student_id,school_year_id,class_id,status,enrolled_on,starts_on
       ) values ($1,$2,$3,'enrolled','2026-09-01','2026-09-01') returning id`,
      [student, year, schoolClass],
    )
  ).rows[0].id;
  await client.query(
    `insert into student_term_enrollment(
       enrollment_id,school_year_id,term_id,status,starts_on,ends_on
     ) values ($1,$2,$3,'enrolled','2026-09-01','2026-12-31')`,
    [enrollment, year, term],
  );
  return { family, student, enrollment };
}

async function makeInvoice(client, number, family, student, year, term, fee, amount, status = "issued") {
  const invoice = (
    await client.query(
      `insert into invoice(
         invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,currency,due_on
       ) values ($1,$2,$3,$4,$5,$6,'USD','2026-10-05') returning id`,
      [number, family, student, year, term, fee],
    )
  ).rows[0].id;
  await client.query(
    `insert into invoice_line(invoice_id,line_type,description,gross_amount)
     values ($1,'nursery_fee','Release hardening tuition',$2)`,
    [invoice, amount],
  );
  if (status === "issued") {
    await client.query(
      "update invoice set status='issued',issued_on='2026-10-01' where id=$1",
      [invoice],
    );
    await client.query("select accounting_post_invoice($1,null)", [invoice]);
  } else if (status === "void") {
    await client.query("update invoice set status='void' where id=$1", [invoice]);
  }
  return invoice;
}

async function makePayment(client, number, family, student, amount, account) {
  const payment = (
    await client.query(
      `insert into payment(
         receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id
       ) values ($1,$2,$3,'payment',$4,'USD','2026-10-03','bank_transfer',$5) returning id`,
      [number, family, student, amount, account],
    )
  ).rows[0].id;
  await client.query("select accounting_post_payment($1,null)", [payment]);
  return payment;
}

async function allocate(client, payment, invoice, amount, date = "2026-10-03") {
  const allocation = (
    await client.query(
      `insert into payment_allocation(payment_id,invoice_id,amount,allocated_on)
       values ($1,$2,$3,$4) returning id`,
      [payment, invoice, amount, date],
    )
  ).rows[0].id;
  await client.query("select accounting_post_payment_allocation($1,null)", [allocation]);
  return allocation;
}

try {
  await admin.query('create database "' + scratchName + '"');
  pool = new Pool({ connectionString: scratchUrl.toString(), max: 8 });
  const client = await pool.connect();

  try {
    const migration = await migrateScratch(client);
    assert.ok(migration.legacyTerm);
    console.log("Data migration test passed across " + migration.migrationCount + " migration(s).");

    const typesResult = await client.query(
      "select id,category from account_type where code=any($1::text[])",
      [["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]],
    );
    const type = Object.fromEntries(typesResult.rows.map((row) => [row.category, row.id]));
    assert.equal(Object.keys(type).length, 5, "All accounting account types must exist");

    await client.query(
      "insert into accounting_period(name,starts_on,ends_on) values ($1,'2026-10-01','2026-10-31')",
      ["Release 1 October " + suffix],
    );
    const journal = (
      await client.query(
        "insert into journal(code,name) values ($1,'Release 1 Hardening Journal') returning id",
        ["R1-" + suffix],
      )
    ).rows[0].id;
    await client.query(
      `update accounting_configuration
       set billing_journal_id=$1,operations_journal_id=$1,payroll_journal_id=$1
       where id=1`,
      [journal],
    );

    const bank = await createAccount(client, "1010", "Release Operating Bank", type.asset);
    const cash = await createAccount(client, "1020", "Release Cash", type.asset);
    const ar = await createAccount(client, "1100", "Release Student Receivables", type.asset);
    const salaryAdvance = await createAccount(client, "1300", "Release Salary Advances", type.asset);
    const deposits = await createAccount(client, "2100", "Release Parent Credits", type.liability);
    const ap = await createAccount(client, "2200", "Release Accounts Payable", type.liability);
    const salaryPayable = await createAccount(client, "2300", "Release Salary Payable", type.liability);
    const equity = await createAccount(client, "3000", "Release Opening Net Position", type.equity);
    const tuition = await createAccount(client, "4000", "Release Tuition Income", type.income);
    const supplies = await createAccount(client, "5100", "Release Supplies Expense", type.expense);
    const payrollExpense = await createAccount(client, "6200", "Release Payroll Expense", type.expense);

    await client.query(
      `insert into cash_bank_account(account_id,account_kind,display_name,bank_name)
       values ($1,'bank','Release Operating Bank','CI Bank'),($2,'cash','Release Cash',null)`,
      [bank, cash],
    );

    const mappings = [
      ["accounts_receivable", ar],
      ["billing_income", tuition],
      ["customer_deposits", deposits],
      ["payment_asset", bank],
      ["accounts_payable", ap],
      ["payroll_expense", payrollExpense],
      ["salary_payable", salaryPayable],
      ["salary_advance", salaryAdvance],
    ];
    for (const [role, account] of mappings) {
      await client.query(
        `insert into accounting_mapping(role_key,account_id)
         values ($1,$2) on conflict(role_key) do update set account_id=excluded.account_id`,
        [role, account],
      );
    }

    const opening = (
      await client.query(
        `insert into journal_entry(
           journal_id,entry_kind,posting_date,currency,description,transaction_reference
         ) values ($1,'opening_balance','2026-10-01','USD','Release 1 opening','R1-OPEN') returning id`,
        [journal],
      )
    ).rows[0].id;
    await client.query(
      `insert into journal_line(
         journal_entry_id,line_number,account_id,description,debit,credit
       ) values
         ($1,1,$2,'Opening bank',5000,0),
         ($1,2,$3,'Opening net position',0,5000)`,
      [opening, bank, equity],
    );
    await client.query("select post_journal_entry($1,null)", [opening]);

    const year = (
      await client.query(
        `insert into school_year(name,starts_on,ends_on,status)
         values ($1,'2026-09-01','2027-06-30','current') returning id`,
        ["Release 2026-2027 " + suffix],
      )
    ).rows[0].id;
    const term1 = (
      await client.query(
        `insert into school_term(school_year_id,sequence,name,starts_on,ends_on,status)
         values ($1,1,'September-December','2026-09-01','2026-12-31','open') returning id`,
        [year],
      )
    ).rows[0].id;
    const term2 = (
      await client.query(
        `insert into school_term(school_year_id,sequence,name,starts_on,ends_on,status)
         values ($1,2,'January-March','2027-01-01','2027-03-31','open') returning id`,
        [year],
      )
    ).rows[0].id;
    const schoolClass = (
      await client.query(
        `insert into school_class(school_year_id,name,capacity,status)
         values ($1,$2,30,'active') returning id`,
        [year, "Release Montessori " + suffix],
      )
    ).rows[0].id;
    const fee1 = (
      await client.query(
        `insert into fee_schedule(
           school_year_id,term_id,name,standard_fee,currency,status,activated_at
         ) values ($1,$2,$3,1000,'USD','active',now()) returning id`,
        [year, term1, "Release Term 1 " + suffix],
      )
    ).rows[0].id;
    const fee2 = (
      await client.query(
        `insert into fee_schedule(
           school_year_id,term_id,name,standard_fee,currency,status,activated_at
         ) values ($1,$2,$3,1000,'USD','active',now()) returning id`,
        [year, term2, "Release Term 2 " + suffix],
      )
    ).rows[0].id;

    const alice = await makeStudent(client, "Release Family A", "Alice", year, schoolClass, term1);
    const ben = await makeStudent(client, "Release Family B", "Ben", year, schoolClass, term1);
    const cara = await makeStudent(client, "Release Family C", "Cara", year, schoolClass, term1);

    await client.query("update school_term set status='closed' where id=$1", [term2]);
    await expectFailure("Closed terms must reject new term enrollments", () =>
      client.query(
        `insert into student_term_enrollment(
           enrollment_id,school_year_id,term_id,status,starts_on,ends_on
         ) values ($1,$2,$3,'enrolled','2027-01-01','2027-03-31')`,
        [alice.enrollment, year, term2],
      ),
    );
    const customDiscount = (
      await client.query("select id from discount_definition where code='CUSTOM'")
    ).rows[0].id;
    await expectFailure("Closed terms must reject new discounts", () =>
      client.query(
        `insert into student_discount(
           student_id,school_year_id,term_id,discount_definition_id,
           custom_name,override_kind,override_value,status
         ) values ($1,$2,$3,$4,'Closed term discount','percentage',10,'pending')`,
        [alice.student, year, term2, customDiscount],
      ),
    );
    await expectFailure("Closed terms must reject new invoices", () =>
      client.query(
        `insert into invoice(
           invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,currency,due_on
         ) values ($1,$2,$3,$4,$5,$6,'USD','2027-01-10')`,
        ["R1-CLOSED-" + suffix, alice.family, alice.student, year, term2, fee2],
      ),
    );
    await expectFailure("Percentage discounts above 100% must be rejected", () =>
      client.query(
        `insert into student_discount(
           student_id,school_year_id,term_id,discount_definition_id,
           custom_name,override_kind,override_value,status
         ) values ($1,$2,$3,$4,'Invalid discount','percentage',101,'pending')`,
        [alice.student, year, term1, customDiscount],
      ),
    );

    const invoiceA = await makeInvoice(
      client,
      "R1-INV-A-" + suffix,
      alice.family,
      alice.student,
      year,
      term1,
      fee1,
      "1000.00",
    );
    const paymentA = await makePayment(
      client,
      "R1-REC-A-" + suffix,
      alice.family,
      alice.student,
      "600.00",
      bank,
    );
    await allocate(client, paymentA, invoiceA, "600.00");

    const firstPost = (
      await client.query("select accounting_post_payment($1,null) id", [paymentA])
    ).rows[0].id;
    const secondPost = (
      await client.query("select accounting_post_payment($1,null) id", [paymentA])
    ).rows[0].id;
    assert.equal(firstPost, secondPost, "Repeated accounting posting must be idempotent");

    await expectFailure("Duplicate receipt numbers must be rejected", () =>
      client.query(
        `insert into payment(
           receipt_number,family_id,student_id,payment_kind,amount,currency,received_on,method,payment_account_id
         ) values ($1,$2,$3,'payment',1,'USD','2026-10-03','bank_transfer',$4)`,
        ["R1-REC-A-" + suffix, alice.family, alice.student, bank],
      ),
    );

    const prepayment = (
      await client.query(
        `insert into payment(
           receipt_number,family_id,payment_kind,amount,currency,received_on,method,payment_account_id
         ) values ($1,$2,'prepayment',300,'USD','2026-10-04','bank_transfer',$3) returning id`,
        ["R1-PRE-" + suffix, alice.family, bank],
      )
    ).rows[0].id;
    await client.query("select accounting_post_payment($1,null)", [prepayment]);

    const refund = (
      await client.query(
        `insert into parent_refund(
           refund_number,family_id,payment_account_id,amount,currency,refunded_on,method,reason
         ) values ($1,$2,$3,100,'USD','2026-10-05','bank_transfer','Release refund') returning id`,
        ["R1-REF-" + suffix, alice.family, bank],
      )
    ).rows[0].id;
    await client.query("select accounting_post_parent_refund($1,null)", [refund]);
    await expectFailure("Refunds cannot exceed available prepaid credit", () =>
      client.query(
        `insert into parent_refund(
           refund_number,family_id,payment_account_id,amount,currency,refunded_on,method,reason
         ) values ($1,$2,$3,201,'USD','2026-10-05','bank_transfer','Too large')`,
        ["R1-REF-BAD-" + suffix, alice.family, bank],
      ),
    );

    const voidInvoice = await makeInvoice(
      client,
      "R1-VOID-" + suffix,
      ben.family,
      ben.student,
      year,
      term1,
      fee1,
      "100.00",
      "void",
    );
    const voidPayment = await makePayment(
      client,
      "R1-VOID-REC-" + suffix,
      ben.family,
      ben.student,
      "100.00",
      bank,
    );
    await expectFailure("Voided/cancelled invoices cannot accept payments", () =>
      client.query(
        `insert into payment_allocation(payment_id,invoice_id,amount,allocated_on)
         values ($1,$2,100,'2026-10-06')`,
        [voidPayment, voidInvoice],
      ),
    );

    const limitedUser = (
      await client.query(
        `insert into app_user(email,full_name,password_hash)
         values ($1,'Release Limited User','not-used-by-test') returning id`,
        ["limited-" + suffix + "@example.invalid"],
      )
    ).rows[0].id;
    const limitedRole = (
      await client.query(
        "insert into role(name,description) values ($1,'Release permission test') returning id",
        ["Release Viewer " + suffix],
      )
    ).rows[0].id;
    await client.query(
      "insert into role_permission(role_id,permission_key) values ($1,'students.view')",
      [limitedRole],
    );
    await client.query("insert into user_role(user_id,role_id) values ($1,$2)", [
      limitedUser,
      limitedRole,
    ]);
    const effectivePermissions = (
      await client.query(
        `select array_agg(rp.permission_key order by rp.permission_key) permissions
         from user_role ur join role_permission rp on rp.role_id=ur.role_id
         where ur.user_id=$1`,
        [limitedUser],
      )
    ).rows[0].permissions;
    assert.deepEqual(effectivePermissions, ["students.view"]);
    assert.equal(effectivePermissions.includes("expenses.manage"), false);
    assert.equal(effectivePermissions.includes("payroll.pay"), false);
    console.log("Permission isolation test passed.");

    const bankBeforeExpense = await currentBalance(client, bank);
    const expenseBefore = await currentBalance(client, supplies);
    const badExpense = (
      await client.query(
        `insert into expense(
           expense_number,expense_account_id,payment_account_id,amount,currency,incurred_on,
           payment_method,notes,status,submitted_at,approved_at
         ) values ($1,$2,$3,50,'USD','2026-10-07','bank_transfer',
           'Incorrect expense to reverse','approved',now(),now()) returning id`,
        ["R1-EXP-" + suffix, supplies, bank],
      )
    ).rows[0].id;
    await client.query("select accounting_post_expense($1,null)", [badExpense]);
    await client.query(
      "select reverse_operational_source('expense',$1,'2026-10-07',null,'Release correction')",
      [badExpense],
    );
    await client.query(
      `update expense set status='reversed',reversed_at=now(),reversal_reason='Release correction'
       where id=$1`,
      [badExpense],
    );
    assert.equal(await currentBalance(client, bank), bankBeforeExpense, "Expense reversal must restore bank");
    assert.equal(await currentBalance(client, supplies), expenseBefore, "Expense reversal must restore expense account");

    const supplier = (
      await client.query(
        `insert into supplier(
           supplier_number,name,default_expense_account_id,default_payment_account_id,payment_terms_days
         ) values ($1,'Release Supplier',$2,$3,30) returning id`,
        ["R1-SUP-" + suffix, supplies, bank],
      )
    ).rows[0].id;
    const supplierInvoice = (
      await client.query(
        `insert into supplier_invoice(
           supplier_invoice_number,supplier_id,expense_account_id,amount,currency,invoice_date,due_on,
           status,approved_at
         ) values ($1,$2,$3,300,'USD','2026-10-08','2026-10-31','approved',now()) returning id`,
        ["R1-BILL-" + suffix, supplier, supplies],
      )
    ).rows[0].id;
    await client.query("select accounting_post_supplier_invoice($1,null)", [supplierInvoice]);

    const job = (
      await client.query(
        "insert into job_title(name,description) values ($1,'Release test') returning id",
        ["Release Teacher " + suffix],
      )
    ).rows[0].id;
    const employee = (
      await client.query(
        `insert into employee(employee_number,first_name,last_name,job_title_id,start_on)
         values ($1,'Dana','Teacher',$2,'2026-09-01') returning id`,
        ["R1-EMP-" + suffix, job],
      )
    ).rows[0].id;
    await client.query(
      `insert into employee_salary_agreement(employee_id,effective_from,monthly_salary,currency)
       values ($1,'2026-09-01',1000,'USD')`,
      [employee],
    );
    const advance = (
      await client.query(
        `insert into salary_advance(
           advance_number,employee_id,advance_date,amount,currency,payment_account_id,
           installments_count,first_repayment_on
         ) values ($1,$2,'2026-10-01',2500,'USD',$3,1,'2026-10-31') returning id`,
        ["R1-ADV-" + suffix, employee, bank],
      )
    ).rows[0].id;
    await client.query("select generate_salary_advance_schedule($1,null)", [advance]);
    await client.query("select accounting_post_salary_advance($1,null)", [advance]);
    const payroll = (
      await client.query(
        `insert into payroll_run(run_number,period_start,period_end,pay_date,currency)
         values ($1,'2026-10-01','2026-10-31','2026-10-31','USD') returning id`,
        ["R1-PAY-" + suffix],
      )
    ).rows[0].id;
    await client.query("select populate_payroll_run($1,null)", [payroll]);
    await client.query(
      "update payroll_run set status='pending',submitted_at=now() where id=$1",
      [payroll],
    );
    await client.query(
      "update payroll_run set status='approved',approved_at=now() where id=$1",
      [payroll],
    );
    await client.query("select lock_payroll_run($1,null)", [payroll]);
    const payrollItem = (
      await client.query(
        `select net_pay::text,advance_repayment_total::text
         from payroll_run_item where payroll_run_id=$1 and employee_id=$2`,
        [payroll, employee],
      )
    ).rows[0];
    assert.equal(payrollItem.net_pay, "0.00", "Advance repayment cannot make payroll net negative");
    assert.equal(payrollItem.advance_repayment_total, "1000.00");
    const advanceBalance = (
      await client.query(
        "select outstanding_amount::text from salary_advance_balance where id=$1",
        [advance],
      )
    ).rows[0].outstanding_amount;
    assert.equal(advanceBalance, "1500.00", "Advance above salary must carry forward safely");

    const raceInvoice = await makeInvoice(
      client,
      "R1-RACE-" + suffix,
      cara.family,
      cara.student,
      year,
      term1,
      fee1,
      "100.00",
    );
    const racePayment1 = await makePayment(
      client,
      "R1-RACE-1-" + suffix,
      cara.family,
      cara.student,
      "100.00",
      bank,
    );
    const racePayment2 = await makePayment(
      client,
      "R1-RACE-2-" + suffix,
      cara.family,
      cara.student,
      "100.00",
      bank,
    );

    const editor1 = await pool.connect();
    const editor2 = await pool.connect();
    let successfulAllocation;
    try {
      await editor1.query("begin");
      successfulAllocation = (
        await editor1.query(
          `insert into payment_allocation(payment_id,invoice_id,amount,allocated_on)
           values ($1,$2,100,'2026-10-09') returning id`,
          [racePayment1, raceInvoice],
        )
      ).rows[0].id;

      await editor2.query("begin");
      const secondAttempt = editor2
        .query(
          `insert into payment_allocation(payment_id,invoice_id,amount,allocated_on)
           values ($1,$2,100,'2026-10-09') returning id`,
          [racePayment2, raceInvoice],
        )
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error }));

      await new Promise((resolve) => setTimeout(resolve, 100));
      await editor1.query("commit");
      const secondResult = await secondAttempt;
      assert.equal(secondResult.ok, false, "Two simultaneous editors must not overpay one invoice");
      await editor2.query("rollback");
    } finally {
      editor1.release();
      editor2.release();
    }
    await client.query("select accounting_post_payment_allocation($1,null)", [successfulAllocation]);
    const raceBalance = (
      await client.query("select balance_amount::text from invoice_balance where id=$1", [raceInvoice])
    ).rows[0].balance_amount;
    assert.equal(raceBalance, "0.00", "Exactly one concurrent allocation must settle the invoice");

    const gate = await client.query(
      `select check_name,currency,system_amount::text,ledger_amount::text,difference::text,passed
       from release_reconciliation_gate('2026-10-31')`,
    );
    const requiredChecks = new Set([
      "Student balances = Accounts Receivable",
      "Family credits = Customer Deposits",
      "Supplier balances = Accounts Payable",
      "Cash screens = Cash ledger",
      "Bank screens = Bank ledger",
      "Payroll reports = Payroll accounting",
      "Net Position = Accounting ledger",
      "Trial Balance debits = Trial Balance credits",
    ]);
    for (const row of gate.rows) {
      assert.equal(row.passed, true, row.check_name + " must reconcile for " + row.currency);
      requiredChecks.delete(row.check_name);
    }
    assert.equal(requiredChecks.size, 0, "Every Release 1 launch-gate relationship must be checked");

    const gateByName = Object.fromEntries(gate.rows.map((row) => [row.check_name, row]));
    assert.equal(gateByName["Student balances = Accounts Receivable"].system_amount, "400.00");
    assert.equal(gateByName["Family credits = Customer Deposits"].system_amount, "300.00");
    assert.equal(gateByName["Supplier balances = Accounts Payable"].system_amount, "300.00");
    assert.equal(gateByName["Payroll reports = Payroll accounting"].system_amount, "1000.00");

    const trial = gateByName["Trial Balance debits = Trial Balance credits"];
    assert.equal(trial.system_amount, trial.ledger_amount);

    console.table(gate.rows);
    console.log("Release 1 hardening verification passed.");
    console.log("Covered: data migration, permissions, duplicate payments, >100% discounts, prepaid/refunded fees, closed terms, void invoices, expense reversals, large salary advances, concurrent edits, and all launch-gate reconciliations.");
  } finally {
    client.release();
  }
} finally {
  if (pool) await pool.end();
  try {
    await admin.query('drop database if exists "' + scratchName + '" with (force)');
  } finally {
    await admin.end();
  }
}
