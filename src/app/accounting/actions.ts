"use server";

import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function fail(message: string): never {
  redirect(`/accounting?error=${encodeURIComponent(message)}`);
}

function success(message: string): never {
  revalidatePath("/accounting");
  redirect(`/accounting?success=${encodeURIComponent(message)}`);
}

function requireUuid(raw: string, label: string) {
  if (!UUID_RE.test(raw)) fail(`Invalid ${label}.`);
  return raw;
}

function optionalUuid(raw: string, label: string) {
  if (!raw) return null;
  return requireUuid(raw, label);
}

function requireDate(raw: string, label: string) {
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    fail(`Enter a valid ${label}.`);
  }
  return raw;
}

function money(raw: string, label: string) {
  if (!MONEY_RE.test(raw)) fail(`Enter a valid ${label} with at most two decimal places.`);
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999_999.99) {
    fail(`${label} must be greater than zero.`);
  }
  return amount.toFixed(2);
}

async function accountCurrency(client: PoolClient, accountIds: string[]) {
  const result = await client.query<{ id: string; currency: string; status: string; allow_posting: boolean }>(
    `select id,currency,status,allow_posting from account where id=any($1::uuid[])`,
    [accountIds],
  );
  if (result.rowCount !== new Set(accountIds).size) fail("One or more accounts were not found.");
  if (result.rows.some((row) => row.status !== "active" || !row.allow_posting)) {
    fail("Transactions require active posting accounts.");
  }
  const currencies = new Set(result.rows.map((row) => row.currency));
  if (currencies.size !== 1) fail("All accounts in an entry must use the same currency.");
  return result.rows[0].currency;
}

async function createAndMaybePost(
  client: PoolClient,
  options: {
    journalId: string;
    entryKind: "manual" | "opening_balance" | "receipt" | "expense" | "transfer";
    postingDate: string;
    currency: string;
    description: string;
    transactionReference?: string | null;
    actorUserId: string;
    postNow: boolean;
    lines: Array<{
      accountId: string;
      description?: string | null;
      debit?: string;
      credit?: string;
    }>;
  },
) {
  const entry = await client.query<{ id: string }>(
    `insert into journal_entry(
       journal_id,entry_kind,posting_date,currency,description,
       transaction_reference,created_by
     ) values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      options.journalId,
      options.entryKind,
      options.postingDate,
      options.currency,
      options.description,
      options.transactionReference || null,
      options.actorUserId,
    ],
  );
  const entryId = entry.rows[0].id;

  let lineNumber = 0;
  for (const line of options.lines) {
    lineNumber += 1;
    await client.query(
      `insert into journal_line(
         journal_entry_id,line_number,account_id,description,debit,credit,created_by
       ) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entryId,
        lineNumber,
        line.accountId,
        line.description || null,
        line.debit || "0.00",
        line.credit || "0.00",
        options.actorUserId,
      ],
    );
  }

  let entryNumber: string | null = null;
  if (options.postNow) {
    const posted = await client.query<{ entry_number: string }>(
      "select post_journal_entry($1,$2) as entry_number",
      [entryId, options.actorUserId],
    );
    entryNumber = posted.rows[0].entry_number;
  }

  return { entryId, entryNumber };
}

export async function createAccountTypeAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const code = value(formData, "code").toUpperCase();
  const name = value(formData, "name");
  const category = value(formData, "category");

  if (!/^[A-Z0-9_-]{2,30}$/.test(code)) fail("Account type code must use letters, numbers, underscores, or hyphens.");
  if (!name) fail("Account type name is required.");
  if (!["asset", "liability", "equity", "income", "expense"].includes(category)) {
    fail("Invalid accounting category.");
  }

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into account_type(code,name,category,created_by)
       values ($1,$2,$3,$4)
       returning id`,
      [code, name, category, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "account_type_created",
      entityType: "account_type",
      entityId: inserted.rows[0].id,
      after: { code, name, category },
    });
  });

  success("Account type created.");
}

export async function createAccountAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const code = value(formData, "code");
  const name = value(formData, "name");
  const accountTypeId = requireUuid(value(formData, "account_type_id"), "account type");
  const parentAccountId = optionalUuid(value(formData, "parent_account_id"), "parent account");
  const currency = (value(formData, "currency") || "USD").toUpperCase();
  const allowPosting = formData.get("allow_posting") === "on";
  const notes = value(formData, "notes");

  if (!code) fail("Account code is required.");
  if (!name) fail("Account name is required.");
  if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a three-letter code.");

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into account(
         code,name,account_type_id,parent_account_id,currency,
         allow_posting,notes,created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       returning id`,
      [
        code,
        name,
        accountTypeId,
        parentAccountId,
        currency,
        allowPosting,
        notes || null,
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "account_created",
      entityType: "account",
      entityId: inserted.rows[0].id,
      after: { code, name, accountTypeId, parentAccountId, currency, allowPosting },
    });
  });

  success("Account created.");
}

export async function updateAccountStatusAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const accountId = requireUuid(value(formData, "account_id"), "account");
  const status = value(formData, "status");
  if (!["active", "inactive"].includes(status)) fail("Invalid account status.");

  await withTransaction(async (client) => {
    const before = await client.query("select * from account where id=$1 for update", [accountId]);
    if (!before.rowCount) fail("Account not found.");

    await client.query(
      "update account set status=$2,updated_at=now(),updated_by=$3 where id=$1",
      [accountId, status, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "account_status_changed",
      entityType: "account",
      entityId: accountId,
      before: before.rows[0],
      after: { status },
    });
  });

  success("Account status updated.");
}

export async function createAccountingPeriodAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const name = value(formData, "name");
  const startsOn = requireDate(value(formData, "starts_on"), "period start date");
  const endsOn = requireDate(value(formData, "ends_on"), "period end date");

  if (!name) fail("Accounting period name is required.");
  if (endsOn < startsOn) fail("Accounting period end date cannot be before the start date.");

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into accounting_period(name,starts_on,ends_on,created_by)
       values ($1,$2,$3,$4)
       returning id`,
      [name, startsOn, endsOn, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "accounting_period_created",
      entityType: "accounting_period",
      entityId: inserted.rows[0].id,
      after: { name, startsOn, endsOn, status: "open" },
    });
  });

  success("Accounting period created.");
}

export async function setAccountingPeriodStatusAction(formData: FormData) {
  const auth = await requirePermission("accounting.period_lock");
  const periodId = requireUuid(value(formData, "period_id"), "accounting period");
  const status = value(formData, "status");
  const note = value(formData, "note");

  if (!["open", "locked"].includes(status)) fail("Invalid accounting period status.");
  if (status === "locked" && !note) fail("Enter a lock note.");

  await withTransaction(async (client) => {
    const before = await client.query(
      "select * from accounting_period where id=$1 for update",
      [periodId],
    );
    if (!before.rowCount) fail("Accounting period not found.");

    if (status === "locked") {
      await client.query(
        `update accounting_period
         set status='locked',locked_at=now(),locked_by=$2,lock_note=$3
         where id=$1`,
        [periodId, auth.userId, note],
      );
    } else {
      await client.query(
        `update accounting_period
         set status='open',locked_at=null,locked_by=null,lock_note=null
         where id=$1`,
        [periodId],
      );
    }

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: status === "locked" ? "accounting_period_locked" : "accounting_period_reopened",
      entityType: "accounting_period",
      entityId: periodId,
      before: before.rows[0],
      after: { status, note: note || null },
    });
  });

  success(status === "locked" ? "Accounting period locked." : "Accounting period reopened.");
}

export async function createJournalAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const code = value(formData, "code").toUpperCase();
  const name = value(formData, "name");
  const description = value(formData, "description");

  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) fail("Journal code must use letters, numbers, underscores, or hyphens.");
  if (!name) fail("Journal name is required.");

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into journal(code,name,description,created_by)
       values ($1,$2,$3,$4)
       returning id`,
      [code, name, description || null, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "journal_created",
      entityType: "journal",
      entityId: inserted.rows[0].id,
      after: { code, name, description: description || null },
    });
  });

  success("Journal created.");
}

export async function updateAccountingMappingAction(formData: FormData) {
  const auth = await requirePermission("accounting.mapping");
  const roleKey = value(formData, "role_key");
  const accountId = requireUuid(value(formData, "account_id"), "mapped account");

  await withTransaction(async (client) => {
    const definition = await client.query(
      "select role_key,name,required_category from accounting_role_definition where role_key=$1",
      [roleKey],
    );
    if (!definition.rowCount) fail("Accounting role not found.");

    await client.query(
      `insert into accounting_mapping(role_key,account_id,updated_by)
       values ($1,$2,$3)
       on conflict (role_key) do update
       set account_id=excluded.account_id,updated_at=now(),updated_by=excluded.updated_by`,
      [roleKey, accountId, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "accounting_mapping_updated",
      entityType: "accounting_mapping",
      entityId: roleKey,
      after: { roleKey, accountId },
    });
  });

  success("Billing accounting mapping updated.");
}

export async function createManualJournalAction(formData: FormData) {
  const auth = await requirePermission("accounting.manage");
  const journalId = requireUuid(value(formData, "journal_id"), "journal");
  const postingDate = requireDate(value(formData, "posting_date"), "posting date");
  const description = value(formData, "description");
  const transactionReference = value(formData, "transaction_reference");
  const actionMode = value(formData, "action_mode") || "draft";

  if (!description) fail("Journal description is required.");
  if (!["draft", "post"].includes(actionMode)) fail("Invalid journal action.");
  if (actionMode === "post" && !auth.permissions.includes("accounting.post")) {
    redirect("/forbidden");
  }

  const accountIds = formData.getAll("line_account_id").map((item) => String(item).trim());
  const descriptions = formData.getAll("line_description").map((item) => String(item).trim());
  const debits = formData.getAll("line_debit").map((item) => String(item).trim());
  const credits = formData.getAll("line_credit").map((item) => String(item).trim());

  const lines: Array<{ accountId: string; description: string | null; debit: string; credit: string }> = [];
  for (let index = 0; index < accountIds.length; index += 1) {
    const rawAccount = accountIds[index];
    const rawDebit = debits[index] || "";
    const rawCredit = credits[index] || "";
    if (!rawAccount && !rawDebit && !rawCredit) continue;
    const accountId = requireUuid(rawAccount, `account on line ${index + 1}`);
    const debit = rawDebit ? money(rawDebit, `debit on line ${index + 1}`) : "0.00";
    const credit = rawCredit ? money(rawCredit, `credit on line ${index + 1}`) : "0.00";
    if ((Number(debit) > 0) === (Number(credit) > 0)) {
      fail(`Line ${index + 1} must have either a debit or a credit, not both.`);
    }
    lines.push({
      accountId,
      description: descriptions[index] || null,
      debit,
      credit,
    });
  }

  if (lines.length < 2) fail("A journal entry needs at least two lines.");

  await withTransaction(async (client) => {
    const currency = await accountCurrency(client, lines.map((line) => line.accountId));
    const created = await createAndMaybePost(client, {
      journalId,
      entryKind: "manual",
      postingDate,
      currency,
      description,
      transactionReference: transactionReference || null,
      actorUserId: auth.userId,
      postNow: actionMode === "post",
      lines,
    });

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: actionMode === "post" ? "manual_journal_posted" : "manual_journal_drafted",
      entityType: "journal_entry",
      entityId: created.entryId,
      after: {
        entryNumber: created.entryNumber,
        postingDate,
        description,
        transactionReference: transactionReference || null,
        lines: lines.length,
      },
    });
  });

  success(actionMode === "post" ? "Manual journal posted." : "Manual journal saved as draft.");
}

export async function postDraftJournalAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const entryId = requireUuid(value(formData, "journal_entry_id"), "journal entry");

  await withTransaction(async (client) => {
    const before = await client.query(
      "select id,status,posting_date,description from journal_entry where id=$1 for update",
      [entryId],
    );
    if (!before.rowCount) fail("Journal entry not found.");
    const posted = await client.query<{ entry_number: string }>(
      "select post_journal_entry($1,$2) as entry_number",
      [entryId, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "journal_entry_posted",
      entityType: "journal_entry",
      entityId: entryId,
      before: before.rows[0],
      after: { entryNumber: posted.rows[0].entry_number, status: "posted" },
    });
  });

  success("Journal entry posted.");
}

export async function reverseJournalAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const entryId = requireUuid(value(formData, "journal_entry_id"), "journal entry");
  const postingDate = requireDate(value(formData, "posting_date"), "reversal posting date");
  const reason = value(formData, "reason");
  if (!reason) fail("Reversal reason is required.");

  await withTransaction(async (client) => {
    const reversal = await client.query<{ reversal_id: string }>(
      "select reverse_journal_entry($1,$2,$3,$4) as reversal_id",
      [entryId, postingDate, auth.userId, reason],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "journal_entry_reversed",
      entityType: "journal_entry",
      entityId: entryId,
      after: { reversalId: reversal.rows[0].reversal_id, postingDate, reason },
    });
  });

  success("Journal entry reversed.");
}

export async function createOpeningBalanceAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const journalId = requireUuid(value(formData, "journal_id"), "journal");
  const accountId = requireUuid(value(formData, "account_id"), "balance account");
  const offsetAccountId = requireUuid(value(formData, "offset_account_id"), "offset account");
  const postingDate = requireDate(value(formData, "posting_date"), "posting date");
  const amount = money(value(formData, "amount"), "opening balance");
  const side = value(formData, "side");
  const reference = value(formData, "transaction_reference");

  if (accountId === offsetAccountId) fail("Opening balance and offset accounts must be different.");
  if (!["debit", "credit"].includes(side)) fail("Select debit or credit for the opening balance.");

  await withTransaction(async (client) => {
    const currency = await accountCurrency(client, [accountId, offsetAccountId]);
    const debitTarget = side === "debit";
    const created = await createAndMaybePost(client, {
      journalId,
      entryKind: "opening_balance",
      postingDate,
      currency,
      description: "Opening balance",
      transactionReference: reference || null,
      actorUserId: auth.userId,
      postNow: true,
      lines: [
        {
          accountId,
          description: "Opening balance",
          debit: debitTarget ? amount : "0.00",
          credit: debitTarget ? "0.00" : amount,
        },
        {
          accountId: offsetAccountId,
          description: "Opening balance offset",
          debit: debitTarget ? "0.00" : amount,
          credit: debitTarget ? amount : "0.00",
        },
      ],
    });
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "opening_balance_posted",
      entityType: "journal_entry",
      entityId: created.entryId,
      after: { entryNumber: created.entryNumber, accountId, offsetAccountId, amount, side },
    });
  });

  success("Opening balance posted.");
}

export async function recordAccountingReceiptAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const journalId = requireUuid(value(formData, "journal_id"), "journal");
  const receiveAccountId = requireUuid(value(formData, "receive_account_id"), "receiving account");
  const sourceAccountId = requireUuid(value(formData, "source_account_id"), "credit account");
  const postingDate = requireDate(value(formData, "posting_date"), "posting date");
  const amount = money(value(formData, "amount"), "receipt amount");
  const description = value(formData, "description");
  const reference = value(formData, "transaction_reference");

  if (!description) fail("Receipt description is required.");
  if (receiveAccountId === sourceAccountId) fail("Receipt accounts must be different.");

  await withTransaction(async (client) => {
    const currency = await accountCurrency(client, [receiveAccountId, sourceAccountId]);
    const created = await createAndMaybePost(client, {
      journalId,
      entryKind: "receipt",
      postingDate,
      currency,
      description,
      transactionReference: reference || null,
      actorUserId: auth.userId,
      postNow: true,
      lines: [
        { accountId: receiveAccountId, description, debit: amount, credit: "0.00" },
        { accountId: sourceAccountId, description, debit: "0.00", credit: amount },
      ],
    });
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "accounting_receipt_posted",
      entityType: "journal_entry",
      entityId: created.entryId,
      after: { entryNumber: created.entryNumber, amount, receiveAccountId, sourceAccountId },
    });
  });

  success("Receipt posted.");
}

export async function recordExpenseAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const journalId = requireUuid(value(formData, "journal_id"), "journal");
  const expenseAccountId = requireUuid(value(formData, "expense_account_id"), "expense account");
  const paymentAccountId = requireUuid(value(formData, "payment_account_id"), "payment account");
  const postingDate = requireDate(value(formData, "posting_date"), "posting date");
  const amount = money(value(formData, "amount"), "expense amount");
  const description = value(formData, "description");
  const reference = value(formData, "transaction_reference");

  if (!description) fail("Expense description is required.");
  if (expenseAccountId === paymentAccountId) fail("Expense and payment accounts must be different.");

  await withTransaction(async (client) => {
    const category = await client.query<{ category: string }>(
      `select t.category
       from account a join account_type t on t.id=a.account_type_id
       where a.id=$1`,
      [expenseAccountId],
    );
    if (category.rows[0]?.category !== "expense") fail("The debit account must be an expense account.");

    const currency = await accountCurrency(client, [expenseAccountId, paymentAccountId]);
    const created = await createAndMaybePost(client, {
      journalId,
      entryKind: "expense",
      postingDate,
      currency,
      description,
      transactionReference: reference || null,
      actorUserId: auth.userId,
      postNow: true,
      lines: [
        { accountId: expenseAccountId, description, debit: amount, credit: "0.00" },
        { accountId: paymentAccountId, description, debit: "0.00", credit: amount },
      ],
    });
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "expense_posted",
      entityType: "journal_entry",
      entityId: created.entryId,
      after: { entryNumber: created.entryNumber, amount, expenseAccountId, paymentAccountId },
    });
  });

  success("Expense posted.");
}

export async function recordTransferAction(formData: FormData) {
  const auth = await requirePermission("accounting.post");
  const journalId = requireUuid(value(formData, "journal_id"), "journal");
  const fromAccountId = requireUuid(value(formData, "from_account_id"), "source account");
  const toAccountId = requireUuid(value(formData, "to_account_id"), "destination account");
  const postingDate = requireDate(value(formData, "posting_date"), "posting date");
  const amount = money(value(formData, "amount"), "transfer amount");
  const description = value(formData, "description") || "Account transfer";
  const reference = value(formData, "transaction_reference");

  if (fromAccountId === toAccountId) fail("Transfer accounts must be different.");

  await withTransaction(async (client) => {
    const categories = await client.query<{ id: string; category: string }>(
      `select a.id,t.category
       from account a join account_type t on t.id=a.account_type_id
       where a.id=any($1::uuid[])`,
      [[fromAccountId, toAccountId]],
    );
    if (categories.rowCount !== 2 || categories.rows.some((row) => row.category !== "asset")) {
      fail("Transfers require two asset accounts.");
    }

    const currency = await accountCurrency(client, [fromAccountId, toAccountId]);
    const created = await createAndMaybePost(client, {
      journalId,
      entryKind: "transfer",
      postingDate,
      currency,
      description,
      transactionReference: reference || null,
      actorUserId: auth.userId,
      postNow: true,
      lines: [
        { accountId: toAccountId, description, debit: amount, credit: "0.00" },
        { accountId: fromAccountId, description, debit: "0.00", credit: amount },
      ],
    });
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "transfer_posted",
      entityType: "journal_entry",
      entityId: created.entryId,
      after: { entryNumber: created.entryNumber, amount, fromAccountId, toAccountId },
    });
  });

  success("Transfer posted.");
}
