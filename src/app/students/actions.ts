"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/security";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function checked(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

function fail(message: string): never {
  redirect(`/students?error=${encodeURIComponent(message)}`);
}

function success(message: string): never {
  revalidatePath("/students");
  redirect(`/students?success=${encodeURIComponent(message)}`);
}

function requireUuid(raw: string, label: string) {
  if (!UUID_RE.test(raw)) fail(`Invalid ${label}.`);
  return raw;
}

function requireDate(raw: string, label: string) {
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    fail(`Enter a valid ${label}.`);
  }
  return raw;
}

function optionalEmail(raw: string) {
  if (raw && !/^\S+@\S+\.\S+$/.test(raw)) fail("Enter a valid email address.");
  return raw || null;
}

function uuidList(formData: FormData, key: string) {
  const raw = formData.getAll(key).map(String);
  if (raw.some((item) => !UUID_RE.test(item))) fail("Invalid selection.");
  return raw;
}

export async function createFamilyAction(formData: FormData) {
  const auth = await requirePermission("families.manage");
  const displayName = value(formData, "display_name");
  if (!displayName) fail("Family display name is required.");

  await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string; family_number: string }>(
      `insert into family(display_name,home_phone,address,notes,created_by,updated_by)
       values ($1,$2,$3,$4,$5,$5)
       returning id,family_number`,
      [
        displayName,
        value(formData, "home_phone") || null,
        value(formData, "address") || null,
        value(formData, "notes") || null,
        auth.userId,
      ],
    );
    const row = inserted.rows[0];
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "family_created",
      entityType: "family",
      entityId: row.id,
      after: { familyNumber: row.family_number, displayName },
    });
  });

  success("Family created.");
}

export async function createGuardianAction(formData: FormData) {
  const auth = await requirePermission("families.manage");
  const familyId = requireUuid(value(formData, "family_id"), "family");
  const firstName = value(formData, "first_name");
  const lastName = value(formData, "last_name");
  const phone = value(formData, "phone");
  const relationship = value(formData, "relationship");
  const email = optionalEmail(value(formData, "email"));
  const isPrimary = checked(formData, "is_primary");

  if (!firstName || !lastName) fail("Guardian first and last name are required.");
  if (!phone) fail("Guardian phone is required.");
  if (!relationship) fail("Guardian relationship is required.");

  await withTransaction(async (client) => {
    const family = await client.query("select id from family where id=$1 for update", [familyId]);
    if (!family.rowCount) fail("Family not found.");

    if (isPrimary) {
      await client.query("update family_guardian set is_primary=false where family_id=$1", [familyId]);
    }

    const inserted = await client.query<{ id: string }>(
      `insert into guardian(
         first_name,last_name,email,phone,alternate_phone,address,occupation,created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
      [
        firstName,
        lastName,
        email,
        phone,
        value(formData, "alternate_phone") || null,
        value(formData, "address") || null,
        value(formData, "occupation") || null,
        auth.userId,
      ],
    );
    const guardianId = inserted.rows[0].id;
    await client.query(
      `insert into family_guardian(
         family_id,guardian_id,relationship,is_primary,has_legal_custody,pickup_authorized,created_by
       ) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        familyId,
        guardianId,
        relationship,
        isPrimary,
        checked(formData, "has_legal_custody"),
        checked(formData, "pickup_authorized"),
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "guardian_created",
      entityType: "guardian",
      entityId: guardianId,
      after: { familyId, firstName, lastName, relationship, isPrimary },
    });
  });

  success("Parent / guardian added to family.");
}

export async function createStudentAction(formData: FormData) {
  const auth = await requirePermission("students.manage");
  const familyId = requireUuid(value(formData, "family_id"), "family");
  const firstName = value(formData, "first_name");
  const lastName = value(formData, "last_name");
  const dateOfBirth = requireDate(value(formData, "date_of_birth"), "date of birth");
  const gender = value(formData, "gender") || null;

  if (!firstName || !lastName) fail("Student first and last name are required.");
  if (gender && !["female", "male", "other", "unspecified"].includes(gender)) {
    fail("Invalid gender selection.");
  }

  await withTransaction(async (client) => {
    const family = await client.query("select id from family where id=$1", [familyId]);
    if (!family.rowCount) fail("Family not found.");

    const inserted = await client.query<{ id: string; student_number: string }>(
      `insert into student(
         family_id,first_name,last_name,preferred_name,date_of_birth,gender,nationality,notes,
         created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       returning id,student_number`,
      [
        familyId,
        firstName,
        lastName,
        value(formData, "preferred_name") || null,
        dateOfBirth,
        gender,
        value(formData, "nationality") || null,
        value(formData, "notes") || null,
        auth.userId,
      ],
    );
    const row = inserted.rows[0];
    await client.query(
      `insert into student_history(student_id,event_type,event_date,summary,details,actor_user_id)
       values ($1,'student_created',current_date,$2,$3::jsonb,$4)`,
      [
        row.id,
        `Student record ${row.student_number} created`,
        JSON.stringify({ familyId, firstName, lastName }),
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "student_created",
      entityType: "student",
      entityId: row.id,
      after: { studentNumber: row.student_number, familyId, firstName, lastName },
    });
  });

  success("Student added to family.");
}

export async function createEmergencyContactAction(formData: FormData) {
  const auth = await requirePermission("families.manage");
  const familyId = requireUuid(value(formData, "family_id"), "family");
  const studentRaw = value(formData, "student_id");
  const studentId = studentRaw ? requireUuid(studentRaw, "student") : null;
  const fullName = value(formData, "full_name");
  const relationship = value(formData, "relationship");
  const phone = value(formData, "phone");
  const priority = Number(value(formData, "priority") || "1");

  if (!fullName || !relationship || !phone) fail("Emergency contact name, relationship, and phone are required.");
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) fail("Priority must be from 1 to 9.");

  await withTransaction(async (client) => {
    const family = await client.query("select id from family where id=$1", [familyId]);
    if (!family.rowCount) fail("Family not found.");
    if (studentId) {
      const student = await client.query(
        "select id from student where id=$1 and family_id=$2",
        [studentId, familyId],
      );
      if (!student.rowCount) fail("The selected student does not belong to this family.");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into emergency_contact(
         family_id,student_id,full_name,relationship,phone,alternate_phone,notes,priority,created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        familyId,
        studentId,
        fullName,
        relationship,
        phone,
        value(formData, "alternate_phone") || null,
        value(formData, "notes") || null,
        priority,
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "emergency_contact_created",
      entityType: "emergency_contact",
      entityId: inserted.rows[0].id,
      after: { familyId, studentId, fullName, relationship, priority },
    });
  });

  success("Emergency contact added.");
}

export async function createClassAction(formData: FormData) {
  const auth = await requirePermission("classes.manage");
  const schoolYearId = requireUuid(value(formData, "school_year_id"), "school year");
  const name = value(formData, "name");
  const capacityRaw = value(formData, "capacity");
  const capacity = capacityRaw ? Number(capacityRaw) : null;
  const status = value(formData, "status") || "active";

  if (!name) fail("Class name is required.");
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 500)) {
    fail("Class capacity must be a whole number from 1 to 500.");
  }
  if (!["planned", "active", "archived"].includes(status)) fail("Invalid class status.");

  await withTransaction(async (client) => {
    const year = await client.query("select id from school_year where id=$1", [schoolYearId]);
    if (!year.rowCount) fail("School year not found.");

    const inserted = await client.query<{ id: string }>(
      `insert into school_class(
         school_year_id,name,room,lead_teacher,capacity,status,created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`,
      [
        schoolYearId,
        name,
        value(formData, "room") || null,
        value(formData, "lead_teacher") || null,
        capacity,
        status,
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "class_created",
      entityType: "school_class",
      entityId: inserted.rows[0].id,
      after: { schoolYearId, name, capacity, status },
    });
  });

  success("Class created.");
}

export async function createEnrollmentAction(formData: FormData) {
  const auth = await requirePermission("enrollments.manage");
  const studentId = requireUuid(value(formData, "student_id"), "student");
  const schoolYearId = requireUuid(value(formData, "school_year_id"), "school year");
  const classId = requireUuid(value(formData, "class_id"), "class");
  const startsOn = requireDate(value(formData, "starts_on"), "enrollment start date");
  const termIds = uuidList(formData, "term_id");
  if (!termIds.length) fail("Select at least one term.");

  await withTransaction(async (client) => {
    const student = await client.query<{ status: string }>(
      "select status from student where id=$1 for update",
      [studentId],
    );
    if (!student.rowCount) fail("Student not found.");
    if (student.rows[0].status === "graduated") fail("A graduated student cannot be enrolled.");

    const classResult = await client.query<{
      name: string;
      capacity: number | null;
      year_starts_on: string;
      year_ends_on: string;
      class_status: string;
    }>(
      `select c.name,c.capacity,c.status as class_status,
         y.starts_on::text as year_starts_on,y.ends_on::text as year_ends_on
       from school_class c
       join school_year y on y.id=c.school_year_id
       where c.id=$1 and c.school_year_id=$2
       for update of c`,
      [classId, schoolYearId],
    );
    const classRow = classResult.rows[0];
    if (!classRow) fail("Class does not belong to the selected school year.");
    if (classRow.class_status === "archived") fail("Archived classes cannot accept enrollments.");
    if (startsOn < classRow.year_starts_on || startsOn > classRow.year_ends_on) {
      fail("Enrollment start date must fall within the selected school year.");
    }

    const duplicate = await client.query(
      `select 1 from student_enrollment
       where student_id=$1 and school_year_id=$2 and status='enrolled' limit 1`,
      [studentId, schoolYearId],
    );
    if (duplicate.rowCount) fail("Student already has an open enrollment for this school year.");

    if (classRow.capacity !== null) {
      const count = await client.query<{ count: number }>(
        `select count(*)::int as count from student_enrollment
         where class_id=$1 and status='enrolled'`,
        [classId],
      );
      if (count.rows[0].count >= classRow.capacity) fail("This class is already at capacity.");
    }

    const terms = await client.query<{
      id: string;
      name: string;
      sequence: number;
      starts_on: string;
      ends_on: string;
    }>(
      `select id,name,sequence,starts_on::text,ends_on::text
       from school_term
       where school_year_id=$1 and id=any($2::uuid[])
       order by sequence`,
      [schoolYearId, termIds],
    );
    if (terms.rowCount !== termIds.length) fail("One or more selected terms are invalid for this school year.");
    if (terms.rows.some((term) => startsOn > term.ends_on)) {
      fail("Enrollment start date is after one of the selected terms has ended.");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into student_enrollment(
         student_id,school_year_id,class_id,starts_on,notes,created_by,updated_by
       ) values ($1,$2,$3,$4,$5,$6,$6) returning id`,
      [studentId, schoolYearId, classId, startsOn, value(formData, "notes") || null, auth.userId],
    );
    const enrollmentId = inserted.rows[0].id;

    for (const term of terms.rows) {
      const termStart = startsOn > term.starts_on ? startsOn : term.starts_on;
      await client.query(
        `insert into student_term_enrollment(
           enrollment_id,school_year_id,term_id,starts_on,ends_on,created_by,updated_by
         ) values ($1,$2,$3,$4,$5,$6,$6)`,
        [enrollmentId, schoolYearId, term.id, termStart, term.ends_on, auth.userId],
      );
    }

    await client.query(
      `update student
       set status='active', admission_date=coalesce(admission_date,$2::date), exit_date=null,
           updated_at=now(), updated_by=$3
       where id=$1`,
      [studentId, startsOn, auth.userId],
    );
    await client.query(
      `insert into student_history(
         student_id,enrollment_id,event_type,event_date,summary,details,actor_user_id
       ) values ($1,$2,'enrollment_created',$3,$4,$5::jsonb,$6)`,
      [
        studentId,
        enrollmentId,
        startsOn,
        `Enrolled in ${classRow.name}`,
        JSON.stringify({ schoolYearId, classId, termIds, startsOn }),
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "student_enrolled",
      entityType: "student_enrollment",
      entityId: enrollmentId,
      after: { studentId, schoolYearId, classId, termIds, startsOn },
    });
  });

  success("Student enrolled and term enrollment recorded.");
}

export async function withdrawEnrollmentAction(formData: FormData) {
  const auth = await requirePermission("enrollments.manage");
  const enrollmentId = requireUuid(value(formData, "enrollment_id"), "enrollment");
  const withdrawalOn = requireDate(value(formData, "withdrawal_on"), "withdrawal date");
  const reason = value(formData, "withdrawal_reason");
  if (!reason) fail("Withdrawal reason is required.");

  await withTransaction(async (client) => {
    const enrollment = await client.query<{
      student_id: string;
      starts_on: string;
      year_ends_on: string;
      status: string;
      class_name: string;
    }>(
      `select e.student_id,e.starts_on::text,e.status,c.name as class_name,
         y.ends_on::text as year_ends_on
       from student_enrollment e
       join school_year y on y.id=e.school_year_id
       join school_class c on c.id=e.class_id
       where e.id=$1 for update of e`,
      [enrollmentId],
    );
    const row = enrollment.rows[0];
    if (!row) fail("Enrollment not found.");
    if (row.status !== "enrolled") fail("Only an open enrollment can be withdrawn.");
    if (withdrawalOn < row.starts_on || withdrawalOn > row.year_ends_on) {
      fail("Withdrawal date must fall within the enrollment period.");
    }

    await client.query(
      `update student_enrollment
       set status='withdrawn',withdrawal_on=$2,withdrawal_reason=$3,
           updated_at=now(),updated_by=$4
       where id=$1`,
      [enrollmentId, withdrawalOn, reason, auth.userId],
    );
    await client.query(
      `update student_term_enrollment
       set status=case when starts_on>$2::date then 'cancelled' else 'withdrawn' end,
           ends_on=case when starts_on>$2::date then ends_on else least(ends_on,$2::date) end,
           updated_at=now(),updated_by=$3
       where enrollment_id=$1 and status='enrolled'`,
      [enrollmentId, withdrawalOn, auth.userId],
    );

    const otherOpen = await client.query(
      `select 1 from student_enrollment
       where student_id=$1 and id<>$2 and status='enrolled' limit 1`,
      [row.student_id, enrollmentId],
    );
    if (!otherOpen.rowCount) {
      await client.query(
        `update student
         set status='withdrawn',exit_date=$2,updated_at=now(),updated_by=$3
         where id=$1`,
        [row.student_id, withdrawalOn, auth.userId],
      );
    }

    await client.query(
      `insert into student_history(
         student_id,enrollment_id,event_type,event_date,summary,details,actor_user_id
       ) values ($1,$2,'withdrawal',$3,$4,$5::jsonb,$6)`,
      [
        row.student_id,
        enrollmentId,
        withdrawalOn,
        `Withdrawn from ${row.class_name}`,
        JSON.stringify({ reason }),
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "student_withdrawn",
      entityType: "student_enrollment",
      entityId: enrollmentId,
      after: { studentId: row.student_id, withdrawalOn, reason },
    });
  });

  success("Withdrawal recorded. Student and enrollment history were preserved.");
}

export async function updateStudentStatusAction(formData: FormData) {
  const auth = await requirePermission("students.manage");
  const studentId = requireUuid(value(formData, "student_id"), "student");
  const status = value(formData, "status");
  const effectiveOn = requireDate(value(formData, "effective_on"), "effective date");
  const note = value(formData, "note");

  if (!["prospective", "inactive", "graduated"].includes(status)) {
    fail("Active and withdrawn statuses are controlled by enrollment actions.");
  }

  await withTransaction(async (client) => {
    const current = await client.query<{ status: string }>(
      "select status from student where id=$1 for update",
      [studentId],
    );
    if (!current.rowCount) fail("Student not found.");
    const open = await client.query(
      "select 1 from student_enrollment where student_id=$1 and status='enrolled' limit 1",
      [studentId],
    );
    if (open.rowCount) fail("Close the student's open enrollment before changing status manually.");

    await client.query(
      `update student
       set status=$2,
           exit_date=case when $2 in ('inactive','graduated') then $3::date else null end,
           updated_at=now(),updated_by=$4
       where id=$1`,
      [studentId, status, effectiveOn, auth.userId],
    );
    await client.query(
      `insert into student_history(student_id,event_type,event_date,summary,details,actor_user_id)
       values ($1,'status_changed',$2,$3,$4::jsonb,$5)`,
      [
        studentId,
        effectiveOn,
        `Student status changed to ${status}`,
        JSON.stringify({ from: current.rows[0].status, to: status, note: note || null }),
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "student_status_updated",
      entityType: "student",
      entityId: studentId,
      before: { status: current.rows[0].status },
      after: { status, effectiveOn, note: note || null },
    });
  });

  success("Student status updated and added to history.");
}
