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
  redirect(`/billing?error=${encodeURIComponent(message)}`);
}

function success(message: string): never {
  revalidatePath("/billing");
  redirect(`/billing?success=${encodeURIComponent(message)}`);
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
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999.99) {
    fail(`${label} must be greater than zero.`);
  }
  return amount.toFixed(2);
}

function decimal(raw: string, label: string, min: number, max: number) {
  if (!MONEY_RE.test(raw)) fail(`Enter a valid ${label}.`);
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    fail(`${label} must be between ${min} and ${max}.`);
  }
  return amount.toFixed(2);
}

function toCents(raw: string | number) {
  const text = Number(raw).toFixed(2);
  const [whole, fraction = "00"] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function fromCents(cents: number) {
  return (cents / 100).toFixed(2);
}

async function nextDocumentNumber(
  client: PoolClient,
  documentType: "invoice" | "receipt" | "credit_note",
  actorUserId: string,
) {
  const result = await client.query<{ prefix: string; number: string }>(
    `update document_sequence
     set next_number=next_number+1,updated_at=now(),updated_by=$2
     where document_type=$1
     returning prefix,(next_number-1)::text as number`,
    [documentType, actorUserId],
  );
  const row = result.rows[0];
  if (!row) fail(`Document sequence ${documentType} is not configured.`);
  return `${row.prefix}-${String(row.number).padStart(6, "0")}`;
}

async function activeInvoiceBalance(client: PoolClient, invoiceId: string) {
  const result = await client.query<{
    family_id: string;
    student_id: string;
    currency: string;
    status: string;
    balance_amount: string;
  }>(
    `select i.family_id,i.student_id,i.currency,i.status,b.balance_amount
     from invoice i
     join invoice_balance b on b.id=i.id
     where i.id=$1
     for update of i`,
    [invoiceId],
  );
  const row = result.rows[0];
  if (!row) fail("Invoice not found.");
  return row;
}

export async function createFeeScheduleAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const termId = requireUuid(value(formData, "term_id"), "term");
  const name = value(formData, "name");
  const standardFee = money(value(formData, "standard_fee"), "standard nursery fee");
  const currency = (value(formData, "currency") || "USD").toUpperCase();

  if (!name) fail("Fee schedule name is required.");
  if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a three-letter code.");

  await withTransaction(async (client) => {
    const term = await client.query<{ school_year_id: string }>(
      "select school_year_id from school_term where id=$1",
      [termId],
    );
    if (!term.rowCount) fail("Term not found.");

    const inserted = await client.query<{ id: string }>(
      `insert into fee_schedule(
         school_year_id,term_id,name,standard_fee,currency,created_by
       ) values ($1,$2,$3,$4,$5,$6)
       returning id`,
      [term.rows[0].school_year_id, termId, name, standardFee, currency, auth.userId],
    );

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "fee_schedule_created",
      entityType: "fee_schedule",
      entityId: inserted.rows[0].id,
      after: { termId, name, standardFee, currency },
    });
  });

  success("Fee schedule created as draft.");
}

export async function activateFeeScheduleAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const scheduleId = requireUuid(value(formData, "fee_schedule_id"), "fee schedule");

  await withTransaction(async (client) => {
    const schedule = await client.query<{ id: string; term_id: string; status: string }>(
      "select id,term_id,status from fee_schedule where id=$1 for update",
      [scheduleId],
    );
    const row = schedule.rows[0];
    if (!row) fail("Fee schedule not found.");
    if (row.status === "archived") fail("Archived fee schedules cannot be reactivated.");

    await client.query(
      `update fee_schedule
       set status='archived'
       where term_id=$1 and status='active' and id<>$2`,
      [row.term_id, scheduleId],
    );
    await client.query(
      `update fee_schedule
       set status='active',activated_at=now(),activated_by=$2
       where id=$1`,
      [scheduleId, auth.userId],
    );

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "fee_schedule_activated",
      entityType: "fee_schedule",
      entityId: scheduleId,
      after: { termId: row.term_id },
    });
  });

  success("Fee schedule activated.");
}

export async function updateDiscountConfigurationAction(formData: FormData) {
  const auth = await requirePermission("discounts.approve");
  const mode = value(formData, "discount_combination_mode");
  const maxDiscountPercent = decimal(
    value(formData, "max_discount_percent") || "100",
    "maximum discount percentage",
    0.01,
    100,
  );

  if (!["best_single", "additive", "sequential"].includes(mode)) {
    fail("Invalid discount combination rule.");
  }

  await withTransaction(async (client) => {
    const before = await client.query(
      "select discount_combination_mode,max_discount_percent from billing_configuration where id=1 for update",
    );
    await client.query(
      `update billing_configuration
       set discount_combination_mode=$1,max_discount_percent=$2,updated_at=now(),updated_by=$3
       where id=1`,
      [mode, maxDiscountPercent, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "discount_configuration_updated",
      entityType: "billing_configuration",
      entityId: "1",
      before: before.rows[0],
      after: { discountCombinationMode: mode, maxDiscountPercent },
    });
  });

  success("Discount combination rule updated.");
}

export async function requestDiscountAction(formData: FormData) {
  const auth = await requirePermission("discounts.manage");
  const studentId = requireUuid(value(formData, "student_id"), "student");
  const termId = requireUuid(value(formData, "term_id"), "term");
  const definitionCode = value(formData, "discount_code").toUpperCase();
  const eligibilityNote = value(formData, "eligibility_note");
  const customName = value(formData, "custom_name");
  const customKind = value(formData, "custom_kind");
  const customValueRaw = value(formData, "custom_value");
  const priorityRaw = value(formData, "priority");

  if (!definitionCode) fail("Select a discount type.");

  await withTransaction(async (client) => {
    const scope = await client.query<{
      school_year_id: string;
      family_id: string;
    }>(
      `select t.school_year_id,s.family_id
       from student s
       join student_enrollment e
         on e.student_id=s.id
        and e.school_year_id=(select school_year_id from school_term where id=$2)
        and e.status<>'cancelled'
       join student_term_enrollment ste
         on ste.enrollment_id=e.id
        and ste.term_id=$2
        and ste.status<>'cancelled'
       join school_term t on t.id=ste.term_id
       where s.id=$1
       limit 1`,
      [studentId, termId],
    );
    const target = scope.rows[0];
    if (!target) fail("Student is not enrolled in the selected term.");

    const definition = await client.query<{
      id: string;
      system_key: string | null;
      discount_kind: string;
      default_value: string;
    }>(
      `select id,system_key,discount_kind,default_value
       from discount_definition
       where code=$1 and is_active=true`,
      [definitionCode],
    );
    const def = definition.rows[0];
    if (!def) fail("Discount definition not found.");

    let overrideKind: string | null = null;
    let overrideValue: string | null = null;
    let overrideName: string | null = null;

    if (def.system_key === "custom") {
      if (!customName) fail("Custom discount name is required.");
      if (!["percentage", "fixed"].includes(customKind)) fail("Select a valid custom discount type.");
      overrideName = customName;
      overrideKind = customKind;
      overrideValue =
        customKind === "percentage"
          ? decimal(customValueRaw, "custom discount percentage", 0.01, 100)
          : money(customValueRaw, "custom discount amount");
    } else {
      const duplicate = await client.query(
        `select 1
         from student_discount
         where student_id=$1 and term_id=$2 and discount_definition_id=$3
           and status in ('pending','approved')
         limit 1`,
        [studentId, termId, def.id],
      );
      if (duplicate.rowCount) fail("That system discount is already pending or approved for this student and term.");
    }

    if (def.system_key === "sibling") {
      const sibling = await client.query(
        `select 1
         from student target
         join student sibling on sibling.family_id=target.family_id and sibling.id<>target.id
         join student_enrollment e on e.student_id=sibling.id and e.school_year_id=$2 and e.status<>'cancelled'
         join student_term_enrollment ste on ste.enrollment_id=e.id and ste.term_id=$3 and ste.status<>'cancelled'
         where target.id=$1
         limit 1`,
        [studentId, target.school_year_id, termId],
      );
      if (!sibling.rowCount) {
        fail("Sibling discount requires another child in the same family enrolled in the same term.");
      }
    }

    const priority = priorityRaw
      ? Number.parseInt(priorityRaw, 10)
      : null;
    if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 1000)) {
      fail("Discount priority must be between 1 and 1000.");
    }

    const inserted = await client.query<{
      id: string;
      status: string;
    }>(
      `insert into student_discount(
         student_id,school_year_id,term_id,discount_definition_id,
         custom_name,override_kind,override_value,priority_override,
         status,eligibility_note,requested_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
       returning id,status`,
      [
        studentId,
        target.school_year_id,
        termId,
        def.id,
        overrideName,
        overrideKind,
        overrideValue,
        priority,
        eligibilityNote || null,
        auth.userId,
      ],
    );
    const discountId = inserted.rows[0].id;

    const snapshot = await client.query(
      "select * from student_discount_effective where id=$1",
      [discountId],
    );
    await client.query(
      `insert into discount_history(student_discount_id,event_type,snapshot,note,actor_user_id)
       values ($1,'requested',$2::jsonb,$3,$4)`,
      [discountId, JSON.stringify(snapshot.rows[0]), eligibilityNote || null, auth.userId],
    );

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "discount_requested",
      entityType: "student_discount",
      entityId: discountId,
      after: snapshot.rows[0],
    });
  });

  success("Discount submitted for approval.");
}

export async function reviewDiscountAction(formData: FormData) {
  const auth = await requirePermission("discounts.approve");
  const discountId = requireUuid(value(formData, "discount_id"), "discount");
  const decision = value(formData, "decision");
  const note = value(formData, "review_note");

  if (!["approved", "rejected"].includes(decision)) fail("Invalid discount review decision.");

  await withTransaction(async (client) => {
    const current = await client.query(
      "select * from student_discount where id=$1 for update",
      [discountId],
    );
    const row = current.rows[0];
    if (!row) fail("Discount not found.");
    if (row.status !== "pending") fail("Only pending discounts can be reviewed.");

    await client.query(
      `update student_discount
       set status=$2,reviewed_at=now(),reviewed_by=$3,review_note=$4
       where id=$1`,
      [discountId, decision, auth.userId, note || null],
    );
    const snapshot = await client.query(
      "select * from student_discount_effective where id=$1",
      [discountId],
    );
    await client.query(
      `insert into discount_history(student_discount_id,event_type,snapshot,note,actor_user_id)
       values ($1,$2,$3::jsonb,$4,$5)`,
      [discountId, decision, JSON.stringify(snapshot.rows[0]), note || null, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: `discount_${decision}`,
      entityType: "student_discount",
      entityId: discountId,
      before: row,
      after: snapshot.rows[0],
    });
  });

  success(`Discount ${decision}.`);
}

export async function revokeDiscountAction(formData: FormData) {
  const auth = await requirePermission("discounts.manage");
  const discountId = requireUuid(value(formData, "discount_id"), "discount");
  const note = value(formData, "note") || "Discount revoked";

  await withTransaction(async (client) => {
    const current = await client.query(
      "select * from student_discount where id=$1 for update",
      [discountId],
    );
    const row = current.rows[0];
    if (!row) fail("Discount not found.");
    if (row.status !== "approved") fail("Only approved discounts can be revoked.");

    await client.query(
      `update student_discount
       set status='revoked',revoked_at=now(),revoked_by=$2
       where id=$1`,
      [discountId, auth.userId],
    );
    const snapshot = await client.query(
      "select * from student_discount_effective where id=$1",
      [discountId],
    );
    await client.query(
      `insert into discount_history(student_discount_id,event_type,snapshot,note,actor_user_id)
       values ($1,'revoked',$2::jsonb,$3,$4)`,
      [discountId, JSON.stringify(snapshot.rows[0]), note, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "discount_revoked",
      entityType: "student_discount",
      entityId: discountId,
      before: row,
      after: snapshot.rows[0],
    });
  });

  success("Discount revoked. Existing issued invoices are unchanged.");
}

export async function generateTermInvoiceAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const studentId = requireUuid(value(formData, "student_id"), "student");
  const termId = requireUuid(value(formData, "term_id"), "term");
  const notes = value(formData, "notes");

  await withTransaction(async (client) => {
    const target = await client.query<{
      family_id: string;
      school_year_id: string;
      term_name: string;
      term_starts_on: string;
      fee_schedule_id: string;
      standard_fee: string;
      currency: string;
    }>(
      `select
         s.family_id,
         t.school_year_id,
         t.name as term_name,
         ste.starts_on::text as term_starts_on,
         fs.id as fee_schedule_id,
         fs.standard_fee::text,
         fs.currency
       from student s
       join student_enrollment e
         on e.student_id=s.id
        and e.school_year_id=(select school_year_id from school_term where id=$2)
        and e.status<>'cancelled'
       join student_term_enrollment ste
         on ste.enrollment_id=e.id
        and ste.term_id=$2
        and ste.status<>'cancelled'
       join school_term t on t.id=ste.term_id
       join fee_schedule fs on fs.term_id=t.id and fs.status='active'
       where s.id=$1
       limit 1`,
      [studentId, termId],
    );
    const row = target.rows[0];
    if (!row) fail("Student needs a term enrollment and an active fee schedule before invoicing.");

    const existing = await client.query(
      `select invoice_number
       from invoice
       where student_id=$1 and term_id=$2 and status<>'void'
       limit 1`,
      [studentId, termId],
    );
    if (existing.rowCount) {
      fail(`A live invoice already exists for this student and term (${existing.rows[0].invoice_number}).`);
    }

    const invoiceNumber = await nextDocumentNumber(client, "invoice", auth.userId);
    const invoice = await client.query<{ id: string }>(
      `insert into invoice(
         invoice_number,family_id,student_id,school_year_id,term_id,fee_schedule_id,
         currency,due_on,notes,created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       returning id`,
      [
        invoiceNumber,
        row.family_id,
        studentId,
        row.school_year_id,
        termId,
        row.fee_schedule_id,
        row.currency,
        row.term_starts_on,
        notes || null,
        auth.userId,
      ],
    );
    const invoiceId = invoice.rows[0].id;

    const line = await client.query<{ id: string }>(
      `insert into invoice_line(
         invoice_id,line_type,description,gross_amount,created_by
       ) values ($1,'nursery_fee',$2,$3,$4)
       returning id`,
      [invoiceId, `Standard nursery fee — ${row.term_name}`, row.standard_fee, auth.userId],
    );
    const lineId = line.rows[0].id;

    const discounts = await client.query<{
      student_discount_id: string;
      discount_label: string;
      discount_kind: string;
      discount_value: string;
      priority: number;
      application_order: number;
      applied_amount: string;
      combination_mode: string;
    }>(
      "select * from billing_discount_breakdown($1,$2,$3::numeric)",
      [studentId, termId, row.standard_fee],
    );

    let discountCents = 0;
    for (const discount of discounts.rows) {
      discountCents += toCents(discount.applied_amount);
      await client.query(
        `insert into invoice_line_discount(
           invoice_line_id,student_discount_id,discount_label,discount_kind,
           discount_value,priority,application_order,applied_amount,combination_mode
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          lineId,
          discount.student_discount_id,
          discount.discount_label,
          discount.discount_kind,
          discount.discount_value,
          discount.priority,
          discount.application_order,
          discount.applied_amount,
          discount.combination_mode,
        ],
      );
    }

    await client.query(
      "update invoice_line set discount_amount=$2 where id=$1",
      [lineId, fromCents(discountCents)],
    );

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "term_invoice_generated",
      entityType: "invoice",
      entityId: invoiceId,
      after: {
        invoiceNumber,
        studentId,
        termId,
        standardFee: row.standard_fee,
        discountAmount: fromCents(discountCents),
        status: "draft",
      },
    });
  });

  success("Draft term invoice generated. Add any extra charges, then issue it.");
}

export async function addInvoiceChargeAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const invoiceId = requireUuid(value(formData, "invoice_id"), "invoice");
  const description = value(formData, "description");
  const amount = money(value(formData, "amount"), "charge amount");

  if (!description) fail("Charge description is required.");

  await withTransaction(async (client) => {
    const invoice = await client.query<{ status: string }>(
      "select status from invoice where id=$1 for update",
      [invoiceId],
    );
    if (!invoice.rowCount) fail("Invoice not found.");
    if (invoice.rows[0].status !== "draft") {
      fail("Additional charges can only be added before an invoice is issued.");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into invoice_line(invoice_id,line_type,description,gross_amount,created_by)
       values ($1,'additional_charge',$2,$3,$4)
       returning id`,
      [invoiceId, description, amount, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "invoice_charge_added",
      entityType: "invoice_line",
      entityId: inserted.rows[0].id,
      after: { invoiceId, description, amount },
    });
  });

  success("Additional charge added.");
}

export async function issueInvoiceAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const invoiceId = requireUuid(value(formData, "invoice_id"), "invoice");

  await withTransaction(async (client) => {
    const invoice = await client.query<{
      status: string;
      invoice_number: string;
      total_amount: string;
    }>(
      "select status,invoice_number,total_amount::text from invoice where id=$1 for update",
      [invoiceId],
    );
    const row = invoice.rows[0];
    if (!row) fail("Invoice not found.");
    if (row.status !== "draft") fail("Only draft invoices can be issued.");

    const lines = await client.query("select 1 from invoice_line where invoice_id=$1 limit 1", [invoiceId]);
    if (!lines.rowCount) fail("Cannot issue an invoice with no lines.");

    await client.query(
      `update invoice
       set status='issued',issued_on=current_date,updated_at=now(),updated_by=$2
       where id=$1`,
      [invoiceId, auth.userId],
    );
    await client.query("select refresh_invoice_status($1)", [invoiceId]);

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "invoice_issued",
      entityType: "invoice",
      entityId: invoiceId,
      after: { invoiceNumber: row.invoice_number, totalAmount: row.total_amount },
    });
  });

  success("Invoice issued.");
}

export async function voidDraftInvoiceAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const invoiceId = requireUuid(value(formData, "invoice_id"), "invoice");
  const reason = value(formData, "reason") || "Draft invoice voided";

  await withTransaction(async (client) => {
    const invoice = await client.query(
      "select * from invoice where id=$1 for update",
      [invoiceId],
    );
    const row = invoice.rows[0];
    if (!row) fail("Invoice not found.");
    if (row.status !== "draft") fail("Only draft invoices can be voided. Use a credit note for issued invoices.");

    await client.query(
      "update invoice set status='void',notes=concat_ws(E'\n',notes,$2),updated_at=now(),updated_by=$3 where id=$1",
      [invoiceId, `VOID: ${reason}`, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "invoice_voided",
      entityType: "invoice",
      entityId: invoiceId,
      before: row,
      after: { status: "void", reason },
    });
  });

  success("Draft invoice voided.");
}

export async function recordPaymentAction(formData: FormData) {
  const auth = await requirePermission("payments.manage");
  const familyId = requireUuid(value(formData, "family_id"), "family");
  const studentId = optionalUuid(value(formData, "student_id"), "student");
  const invoiceId = optionalUuid(value(formData, "invoice_id"), "invoice");
  const amount = money(value(formData, "amount"), "payment amount");
  const paymentKind = value(formData, "payment_kind") || "payment";
  const method = value(formData, "method");
  const receivedOn = requireDate(value(formData, "received_on"), "payment date");
  const reference = value(formData, "reference");
  const notes = value(formData, "notes");
  let currency = (value(formData, "currency") || "USD").toUpperCase();

  if (!["payment", "prepayment"].includes(paymentKind)) fail("Invalid payment type.");
  if (!["cash", "card", "bank_transfer", "check", "other"].includes(method)) {
    fail("Select a valid payment method.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a three-letter code.");

  await withTransaction(async (client) => {
    const family = await client.query("select id from family where id=$1", [familyId]);
    if (!family.rowCount) fail("Family not found.");
    if (studentId) {
      const student = await client.query(
        "select id from student where id=$1 and family_id=$2",
        [studentId, familyId],
      );
      if (!student.rowCount) fail("Selected student does not belong to this family.");
    }

    let invoiceBalance: Awaited<ReturnType<typeof activeInvoiceBalance>> | null = null;
    if (invoiceId) {
      invoiceBalance = await activeInvoiceBalance(client, invoiceId);
      if (invoiceBalance.family_id !== familyId) fail("Invoice belongs to a different family.");
      if (studentId && invoiceBalance.student_id !== studentId) {
        fail("Student-specific payment cannot target another student's invoice.");
      }
      if (!["issued", "partially_paid"].includes(invoiceBalance.status)) {
        fail("Selected invoice does not have an open issued balance.");
      }
      currency = invoiceBalance.currency;
    }

    const receiptNumber = await nextDocumentNumber(client, "receipt", auth.userId);
    const inserted = await client.query<{ id: string }>(
      `insert into payment(
         receipt_number,family_id,student_id,payment_kind,amount,currency,
         received_on,method,reference,notes,created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id`,
      [
        receiptNumber,
        familyId,
        studentId,
        paymentKind,
        amount,
        currency,
        receivedOn,
        method,
        reference || null,
        notes || null,
        auth.userId,
      ],
    );
    const paymentId = inserted.rows[0].id;

    if (invoiceId && invoiceBalance) {
      const allocationCents = Math.min(toCents(amount), toCents(invoiceBalance.balance_amount));
      if (allocationCents > 0) {
        await client.query(
          `insert into payment_allocation(payment_id,invoice_id,amount,created_by)
           values ($1,$2,$3,$4)`,
          [paymentId, invoiceId, fromCents(allocationCents), auth.userId],
        );
      }
    }

    const balance = await client.query(
      "select allocated_amount,unallocated_amount,balance_type from payment_balance where id=$1",
      [paymentId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "payment_recorded",
      entityType: "payment",
      entityId: paymentId,
      after: {
        receiptNumber,
        familyId,
        studentId,
        invoiceId,
        amount,
        currency,
        paymentKind,
        balance: balance.rows[0],
      },
    });
  });

  success("Payment recorded. Any amount above the invoice balance remains available as family credit.");
}

export async function allocatePaymentAction(formData: FormData) {
  const auth = await requirePermission("payments.manage");
  const paymentId = requireUuid(value(formData, "payment_id"), "payment");
  const invoiceId = requireUuid(value(formData, "invoice_id"), "invoice");
  const amount = money(value(formData, "amount"), "allocation amount");

  await withTransaction(async (client) => {
    await client.query(
      `insert into payment_allocation(payment_id,invoice_id,amount,created_by)
       values ($1,$2,$3,$4)`,
      [paymentId, invoiceId, amount, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "payment_allocated",
      entityType: "payment",
      entityId: paymentId,
      after: { invoiceId, amount },
    });
  });

  success("Payment credit allocated.");
}

export async function reversePaymentAction(formData: FormData) {
  const auth = await requirePermission("payments.manage");
  const paymentId = requireUuid(value(formData, "payment_id"), "payment");
  const reason = value(formData, "reason");

  if (!reason) fail("Reversal reason is required.");

  await withTransaction(async (client) => {
    const payment = await client.query(
      "select * from payment where id=$1 for update",
      [paymentId],
    );
    const row = payment.rows[0];
    if (!row) fail("Payment not found.");
    if (row.status !== "posted") fail("Payment is already reversed.");

    await client.query(
      `update payment
       set status='reversed',reversed_at=now(),reversed_by=$2,reversal_reason=$3
       where id=$1`,
      [paymentId, auth.userId, reason],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "payment_reversed",
      entityType: "payment",
      entityId: paymentId,
      before: row,
      after: { status: "reversed", reason },
    });
  });

  success("Payment reversed and affected invoice balances recalculated.");
}

export async function createCreditNoteAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  let familyId = requireUuid(value(formData, "family_id"), "family");
  let studentId = optionalUuid(value(formData, "student_id"), "student");
  const invoiceId = optionalUuid(value(formData, "invoice_id"), "invoice");
  const amount = money(value(formData, "amount"), "credit amount");
  const reason = value(formData, "reason");
  const issuedOn = requireDate(value(formData, "issued_on"), "credit-note date");
  let currency = (value(formData, "currency") || "USD").toUpperCase();

  if (!reason) fail("Credit reason is required.");
  if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a three-letter code.");

  await withTransaction(async (client) => {
    let invoiceBalance: Awaited<ReturnType<typeof activeInvoiceBalance>> | null = null;
    if (invoiceId) {
      invoiceBalance = await activeInvoiceBalance(client, invoiceId);
      if (invoiceBalance.family_id !== familyId) fail("Invoice belongs to a different family.");
      familyId = invoiceBalance.family_id;
      studentId = invoiceBalance.student_id;
      currency = invoiceBalance.currency;
    } else if (studentId) {
      const student = await client.query(
        "select id from student where id=$1 and family_id=$2",
        [studentId, familyId],
      );
      if (!student.rowCount) fail("Selected student does not belong to this family.");
    }

    const creditNumber = await nextDocumentNumber(client, "credit_note", auth.userId);
    const inserted = await client.query<{ id: string }>(
      `insert into credit_note(
         credit_note_number,family_id,student_id,original_invoice_id,
         amount,currency,reason,issued_on,created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      [
        creditNumber,
        familyId,
        studentId,
        invoiceId,
        amount,
        currency,
        reason,
        issuedOn,
        auth.userId,
      ],
    );
    const creditId = inserted.rows[0].id;

    if (invoiceId && invoiceBalance && ["issued", "partially_paid"].includes(invoiceBalance.status)) {
      const allocationCents = Math.min(toCents(amount), toCents(invoiceBalance.balance_amount));
      if (allocationCents > 0) {
        await client.query(
          `insert into credit_note_allocation(credit_note_id,invoice_id,amount,created_by)
           values ($1,$2,$3,$4)`,
          [creditId, invoiceId, fromCents(allocationCents), auth.userId],
        );
      }
    }

    const balance = await client.query(
      "select allocated_amount,unallocated_amount from credit_note_balance where id=$1",
      [creditId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "credit_note_issued",
      entityType: "credit_note",
      entityId: creditId,
      after: {
        creditNumber,
        familyId,
        studentId,
        invoiceId,
        amount,
        currency,
        reason,
        balance: balance.rows[0],
      },
    });
  });

  success("Credit note issued. Any unused credit remains available to the family.");
}

export async function allocateCreditNoteAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const creditNoteId = requireUuid(value(formData, "credit_note_id"), "credit note");
  const invoiceId = requireUuid(value(formData, "invoice_id"), "invoice");
  const amount = money(value(formData, "amount"), "credit allocation amount");

  await withTransaction(async (client) => {
    await client.query(
      `insert into credit_note_allocation(credit_note_id,invoice_id,amount,created_by)
       values ($1,$2,$3,$4)`,
      [creditNoteId, invoiceId, amount, auth.userId],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "credit_note_allocated",
      entityType: "credit_note",
      entityId: creditNoteId,
      after: { invoiceId, amount },
    });
  });

  success("Credit allocated.");
}

export async function reverseCreditNoteAction(formData: FormData) {
  const auth = await requirePermission("billing.manage");
  const creditNoteId = requireUuid(value(formData, "credit_note_id"), "credit note");
  const reason = value(formData, "reason");

  if (!reason) fail("Reversal reason is required.");

  await withTransaction(async (client) => {
    const credit = await client.query(
      "select * from credit_note where id=$1 for update",
      [creditNoteId],
    );
    const row = credit.rows[0];
    if (!row) fail("Credit note not found.");
    if (row.status !== "issued") fail("Credit note is already reversed.");

    await client.query(
      `update credit_note
       set status='reversed',reversed_at=now(),reversed_by=$2,reversal_reason=$3
       where id=$1`,
      [creditNoteId, auth.userId, reason],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "credit_note_reversed",
      entityType: "credit_note",
      entityId: creditNoteId,
      before: row,
      after: { status: "reversed", reason },
    });
  });

  success("Credit note reversed and affected invoice balances recalculated.");
}
