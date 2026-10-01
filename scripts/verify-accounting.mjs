import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

async function expectFailure(label, work) {
  const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
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

async function createEntry(journalId, kind, postingDate, description, lines, reference = null) {
  const entry = await client.query(
    `insert into journal_entry(
       journal_id,entry_kind,posting_date,currency,description,transaction_reference
     ) values ($1,$2,$3,'USD',$4,$5)
     returning id`,
    [journalId, kind, postingDate, description, reference],
  );
  const entryId = entry.rows[0].id;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(
      `insert into journal_line(
         journal_entry_id,line_number,account_id,description,debit,credit
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        entryId,
        index + 1,
        line.accountId,
        line.description ?? description,
        line.debit ?? "0.00",
        line.credit ?? "0.00",
      ],
    );
  }

  const posted = await client.query(
    "select post_journal_entry($1,null) as entry_number",
    [entryId],
  );
  assert.match(posted.rows[0].entry_number, /^JE-\d{6}$/);
  return entryId;
}

async function normalBalance(accountId) {
  const result = await client.query(
    "select normal_balance::numeric(14,2)::text as balance from account_balance where account_id=$1",
    [accountId],
  );
  return result.rows[0]?.balance ?? "0.00";
}

try {
  await client.query("begin");

  const requiredPermissions = [
    "accounting.view",
    "accounting.manage",
    "accounting.post",
    "accounting.period_lock",
    "accounting.mapping",
  ];
  const permissions = await client.query(
    `select rp.permission_key
     from role_permission rp
     join role r on r.id=rp.role_id
     where lower(r.name)='administrator'
       and rp.permission_key=any($1::text[])`,
    [requiredPermissions],
  );
  assert.equal(
    permissions.rowCount,
    requiredPermissions.length,
    "Administrator must receive every Step 4 permission",
  );

  const suffix = randomUUID().slice(0, 8).toUpperCase();

  const types = await client.query(
    "select id,category from account_type where code=any($1::text[])",
    [["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]],
  );
  const typeByCategory = Object.fromEntries(types.rows.map((row) => [row.category, row.id]));
  assert.equal(Object.keys(typeByCategory).length, 5, "Five base accounting categories must exist");

  const customBankType = await client.query(
    `insert into account_type(code,name,category)
     values ($1,$2,'asset')
     returning id`,
    [`BANK_${suffix}`, "CI Bank Accounts"],
  );
  const bankTypeId = customBankType.rows[0].id;

  const period = await client.query(
    `insert into accounting_period(name,starts_on,ends_on)
     values ($1,'2026-01-01','2026-12-31')
     returning id`,
    [`CI 2026 ${suffix}`],
  );
  const periodId = period.rows[0].id;

  await expectFailure(
    "Accounting periods must not overlap",
    () => client.query(
      `insert into accounting_period(name,starts_on,ends_on)
       values ($1,'2026-06-01','2027-05-31')`,
      [`CI overlap ${suffix}`],
    ),
  );

  const journal = await client.query(
    `insert into journal(code,name,description)
     values ($1,'CI General Journal','Milestone 4 journal')
     returning id`,
    [`GEN_${suffix}`],
  );
  const journalId = journal.rows[0].id;

  const bankHeader = await client.query(
    `insert into account(code,name,account_type_id,currency,allow_posting)
     values ($1,'Banks',$2,'USD',false)
     returning id`,
    [`1000-${suffix}`, bankTypeId],
  );
  const bankHeaderId = bankHeader.rows[0].id;

  async function account(codePrefix, name, typeId, parentId = null) {
    const result = await client.query(
      `insert into account(code,name,account_type_id,parent_account_id,currency,allow_posting)
       values ($1,$2,$3,$4,'USD',true)
       returning id`,
      [`${codePrefix}-${suffix}`, name, typeId, parentId],
    );
    return result.rows[0].id;
  }

  const bankA = await account("1010", "Operating Bank", bankTypeId, bankHeaderId);
  const bankB = await account("1020", "Reserve Bank", bankTypeId, bankHeaderId);
  const receivable = await account("1100", "Student Receivable", typeByCategory.asset);
  const deposits = await account("2100", "Family Deposits", typeByCategory.liability);
  const openingEquity = await account("3000", "Opening Net Position", typeByCategory.equity);
  const income = await account("4000", "School Income", typeByCategory.income);
  const expense = await account("5000", "Operating Expense", typeByCategory.expense);

  await expectFailure(
    "Parent and subaccount categories must match",
    () => client.query(
      `insert into account(code,name,account_type_id,parent_account_id,currency)
       values ($1,'Invalid Expense Child',$2,$3,'USD')`,
      [`BAD-${suffix}`, typeByCategory.expense, bankHeaderId],
    ),
  );

  await client.query(
    "update accounting_configuration set billing_journal_id=$1 where id=1",
    [journalId],
  );

  for (const [role, accountId] of [
    ["accounts_receivable", receivable],
    ["billing_income", income],
    ["customer_deposits", deposits],
    ["payment_asset", bankA],
  ]) {
    await client.query(
      `insert into accounting_mapping(role_key,account_id)
       values ($1,$2)
       on conflict (role_key) do update set account_id=excluded.account_id,updated_at=now()`,
      [role, accountId],
    );
  }

  await expectFailure(
    "Accounting mappings must enforce required account categories",
    () => client.query(
      `update accounting_mapping
       set account_id=$1
       where role_key='billing_income'`,
      [bankA],
    ),
  );

  await createEntry(
    journalId,
    "opening_balance",
    "2026-09-01",
    "Opening bank balance",
    [
      { accountId: bankA, debit: "10000.00" },
      { accountId: openingEquity, credit: "10000.00" },
    ],
    "OPEN-001",
  );

  await createEntry(
    journalId,
    "receipt",
    "2026-09-02",
    "Receive income",
    [
      { accountId: bankA, debit: "1000.00" },
      { accountId: income, credit: "1000.00" },
    ],
    "REC-001",
  );

  await createEntry(
    journalId,
    "expense",
    "2026-09-03",
    "Operating expense",
    [
      { accountId: expense, debit: "200.00" },
      { accountId: bankA, credit: "200.00" },
    ],
    "EXP-001",
  );

  await createEntry(
    journalId,
    "transfer",
    "2026-09-04",
    "Move funds to reserve",
    [
      { accountId: bankB, debit: "500.00" },
      { accountId: bankA, credit: "500.00" },
    ],
    "TRF-001",
  );

  assert.equal(await normalBalance(bankA), "10300.00", "Operating bank must end at 10,300.00");
  assert.equal(await normalBalance(bankB), "500.00", "Reserve bank must end at 500.00");
  assert.equal(await normalBalance(openingEquity), "10000.00", "Opening equity must be 10,000.00");
  assert.equal(await normalBalance(income), "1000.00", "Income must be 1,000.00");
  assert.equal(await normalBalance(expense), "200.00", "Expense must be 200.00");

  const postedTotals = await client.query(
    `select
       sum(jl.debit)::numeric(14,2)::text as debit,
       sum(jl.credit)::numeric(14,2)::text as credit
     from journal_line jl
     join journal_entry je on je.id=jl.journal_entry_id
     where je.status in ('posted','reversed')`,
  );
  assert.equal(postedTotals.rows[0].debit, "11700.00");
  assert.equal(postedTotals.rows[0].credit, "11700.00");

  const trial = await client.query(
    `select
       sum(debit_balance)::numeric(14,2)::text as debit_balance,
       sum(credit_balance)::numeric(14,2)::text as credit_balance
     from trial_balance`,
  );
  assert.equal(trial.rows[0].debit_balance, "11000.00");
  assert.equal(trial.rows[0].credit_balance, "11000.00");

  const position = await client.query("select * from accounting_position");
  assert.equal(position.rows[0].assets, "10800.00");
  assert.equal(position.rows[0].liabilities, "0.00");
  assert.equal(position.rows[0].equity, "10000.00");
  assert.equal(position.rows[0].income, "1000.00");
  assert.equal(position.rows[0].expenses, "200.00");
  assert.equal(position.rows[0].current_surplus, "800.00");
  assert.equal(position.rows[0].net_position, "10800.00");
  assert.equal(position.rows[0].equation_difference, "0.00");

  const bankLedger = await client.query(
    `select running_balance::numeric(14,2)::text as running_balance
     from general_ledger
     where account_id=$1
     order by posting_date desc,entry_number desc,line_number desc
     limit 1`,
    [bankA],
  );
  assert.equal(bankLedger.rows[0].running_balance, "10300.00");

  const unbalanced = await client.query(
    `insert into journal_entry(
       journal_id,entry_kind,posting_date,currency,description
     ) values ($1,'manual','2026-09-05','USD','Unbalanced CI draft')
     returning id`,
    [journalId],
  );
  await client.query(
    `insert into journal_line(journal_entry_id,line_number,account_id,debit,credit)
     values
       ($1,1,$2,10.00,0),
       ($1,2,$3,0,9.00)`,
    [unbalanced.rows[0].id, bankA, income],
  );
  await expectFailure(
    "Posting engine must reject Debit != Credit",
    () => client.query("select post_journal_entry($1,null)", [unbalanced.rows[0].id]),
  );

  const reversible = await createEntry(
    journalId,
    "receipt",
    "2026-09-06",
    "Temporary receipt to reverse",
    [
      { accountId: bankA, debit: "50.00" },
      { accountId: income, credit: "50.00" },
    ],
    "REV-TEST",
  );
  const reversal = await client.query(
    "select reverse_journal_entry($1,'2026-09-07',null,'CI reversal') as id",
    [reversible],
  );
  assert.ok(reversal.rows[0].id);
  assert.equal(await normalBalance(bankA), "10300.00", "Reversal must restore bank balance");
  assert.equal(await normalBalance(income), "1000.00", "Reversal must restore income balance");

  await client.query(
    `update accounting_period
     set status='locked',locked_at=now(),lock_note='CI lock'
     where id=$1`,
    [periodId],
  );
  const lockedDraft = await client.query(
    `insert into journal_entry(
       journal_id,entry_kind,posting_date,currency,description
     ) values ($1,'manual','2026-09-08','USD','Locked period draft')
     returning id`,
    [journalId],
  );
  await client.query(
    `insert into journal_line(journal_entry_id,line_number,account_id,debit,credit)
     values
       ($1,1,$2,25.00,0),
       ($1,2,$3,0,25.00)`,
    [lockedDraft.rows[0].id, bankA, income],
  );
  await expectFailure(
    "Locked accounting period must reject posting",
    () => client.query("select post_journal_entry($1,null)", [lockedDraft.rows[0].id]),
  );
  await client.query(
    `update accounting_period
     set status='open',locked_at=null,locked_by=null,lock_note=null
     where id=$1`,
    [periodId],
  );

  const family = await client.query(
    "insert into family(display_name) values ('CI Accounting Billing Family') returning id",
  );
  const familyId = family.rows[0].id;
  const student = await client.query(
    `insert into student(family_id,first_name,last_name,date_of_birth,status)
     values ($1,'Billing','Child','2022-01-01','active')
     returning id`,
    [familyId],
  );
  const studentId = student.rows[0].id;
  const year = await client.query(
    `insert into school_year(name,starts_on,ends_on,status)
     values ($1,'2026-09-01','2027-06-30','planned')
     returning id`,
    [`CI-ACCOUNTING-${suffix}`],
  );
  const yearId = year.rows[0].id;
  const term = await client.query(
    `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
     values ($1,1,'September–December','2026-09-01','2026-12-31')
     returning id`,
    [yearId],
  );
  const termId = term.rows[0].id;
  const schedule = await client.query(
    `insert into fee_schedule(
       school_year_id,term_id,name,standard_fee,currency,status,activated_at
     ) values ($1,$2,'CI Accounting Fee',1000.00,'USD','active',now())
     returning id`,
    [yearId, termId],
  );
  const invoice = await client.query(
    `insert into invoice(
       invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,
       currency,due_on
     ) values ($1,$2,$3,$4,$5,$6,'USD','2026-10-01')
     returning id`,
    [`CI-AINV-${suffix}`, familyId, studentId, yearId, termId, schedule.rows[0].id],
  );
  const invoiceId = invoice.rows[0].id;
  await client.query(
    `insert into invoice_line(invoice_id,line_type,description,gross_amount)
     values ($1,'nursery_fee','CI accounting tuition',1000.00)`,
    [invoiceId],
  );
  await client.query(
    "update invoice set status='issued',issued_on='2026-10-01' where id=$1",
    [invoiceId],
  );
  const invoiceJournal = await client.query(
    "select accounting_post_invoice($1,null) as id",
    [invoiceId],
  );
  assert.ok(invoiceJournal.rows[0].id);
  assert.equal(await normalBalance(receivable), "1000.00");
  assert.equal(await normalBalance(income), "2000.00");

  const payment = await client.query(
    `insert into payment(
       receipt_number,family_id,payment_kind,amount,currency,received_on,method
     ) values ($1,$2,'payment',600.00,'USD','2026-10-02','bank_transfer')
     returning id`,
    [`CI-AREC-${suffix}`, familyId],
  );
  const paymentId = payment.rows[0].id;
  await client.query("select accounting_post_payment($1,null)", [paymentId]);

  const allocation = await client.query(
    `insert into payment_allocation(payment_id,invoice_id,amount,allocated_on)
     values ($1,$2,500.00,'2026-10-02')
     returning id`,
    [paymentId, invoiceId],
  );
  await client.query(
    "select accounting_post_payment_allocation($1,null)",
    [allocation.rows[0].id],
  );

  assert.equal(await normalBalance(bankA), "10900.00");
  assert.equal(await normalBalance(deposits), "100.00");
  assert.equal(await normalBalance(receivable), "500.00");

  const credit = await client.query(
    `insert into credit_note(
       credit_note_number,family_id,student_id,original_invoice_id,
       amount,currency,reason,issued_on
     ) values ($1,$2,$3,$4,100.00,'USD','CI accounting credit','2026-10-03')
     returning id`,
    [`CI-ACRN-${suffix}`, familyId, studentId, invoiceId],
  );
  const creditId = credit.rows[0].id;
  await client.query("select accounting_post_credit_note($1,null)", [creditId]);

  const creditAllocation = await client.query(
    `insert into credit_note_allocation(credit_note_id,invoice_id,amount,allocated_on)
     values ($1,$2,100.00,'2026-10-03')
     returning id`,
    [creditId, invoiceId],
  );
  await client.query(
    "select accounting_post_credit_allocation($1,null)",
    [creditAllocation.rows[0].id],
  );

  assert.equal(await normalBalance(deposits), "100.00");
  assert.equal(await normalBalance(receivable), "400.00");
  assert.equal(await normalBalance(income), "1900.00");

  const billingEntries = await client.query(
    `select source_type,
       sum(x.debit)::numeric(14,2)::text as debit,
       sum(x.credit)::numeric(14,2)::text as credit
     from journal_entry je
     join lateral (
       select sum(debit) as debit,sum(credit) as credit
       from journal_line where journal_entry_id=je.id
     ) x on true
     where source_type in (
       'billing_invoice','billing_payment','billing_payment_allocation',
       'billing_credit_note','billing_credit_allocation'
     )
     group by source_type`,
  );
  assert.equal(billingEntries.rowCount, 5, "Each billing event must create an accounting journal entry");
  for (const row of billingEntries.rows) {
    assert.equal(row.debit, row.credit, `${row.source_type} must be balanced`);
  }

  console.log("Step 4 accounting verification passed.");
  console.log("Milestone balances: Bank A 10300.00, Bank B 500.00, total assets 10800.00.");
  console.log("Milestone trial balance: debit 11000.00, credit 11000.00.");
  console.log("Milestone net position: 10800.00 with current surplus 800.00 and equation difference 0.00.");
  console.log("Unbalanced posting, period locking, reversals, parent/subaccounts, custom account types, and billing accounting integration passed.");

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
