import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query("begin");

  const requiredPermissions = [
    "families.view",
    "families.manage",
    "students.view",
    "students.manage",
    "classes.view",
    "classes.manage",
    "enrollments.view",
    "enrollments.manage",
    "student_documents.view",
    "student_documents.manage",
    "student_history.view",
  ];
  const adminPermissions = await client.query(
    `select rp.permission_key
     from role_permission rp
     join role r on r.id=rp.role_id
     where lower(r.name)='administrator' and rp.permission_key=any($1::text[])`,
    [requiredPermissions],
  );
  assert.equal(
    adminPermissions.rowCount,
    requiredPermissions.length,
    "Administrator must receive every Step 2 permission",
  );

  const family = await client.query(
    `insert into family(display_name,home_phone)
     values ('CI Family','555-0100') returning id,family_number`,
  );
  const familyId = family.rows[0].id;

  const guardian = await client.query(
    `insert into guardian(first_name,last_name,phone)
     values ('CI','Parent','555-0101') returning id`,
  );
  await client.query(
    `insert into family_guardian(family_id,guardian_id,relationship,is_primary)
     values ($1,$2,'Parent',true)`,
    [familyId, guardian.rows[0].id],
  );

  const child1 = await client.query(
    `insert into student(family_id,first_name,last_name,date_of_birth)
     values ($1,'Child','One','2022-02-01') returning id,student_number`,
    [familyId],
  );
  const child2 = await client.query(
    `insert into student(family_id,first_name,last_name,date_of_birth)
     values ($1,'Child','Two','2023-03-01') returning id,student_number`,
    [familyId],
  );
  const child1Id = child1.rows[0].id;
  const child2Id = child2.rows[0].id;

  const siblings = await client.query(
    `select student_id,sibling_id from student_sibling_relationship
     where student_id=any($1::uuid[]) and sibling_id=any($1::uuid[])`,
    [[child1Id, child2Id]],
  );
  assert.equal(siblings.rowCount, 2, "Children in the same family must be siblings in both directions");

  const otherFamily = await client.query(
    "insert into family(display_name) values ('CI Other Family') returning id",
  );
  await client.query("savepoint emergency_family_guard");
  let mismatchedContactBlocked = false;
  try {
    await client.query(
      `insert into emergency_contact(family_id,student_id,full_name,relationship,phone)
       values ($1,$2,'Wrong Family Contact','Friend','555-0199')`,
      [otherFamily.rows[0].id, child1Id],
    );
  } catch {
    mismatchedContactBlocked = true;
    await client.query("rollback to savepoint emergency_family_guard");
  }
  assert.equal(mismatchedContactBlocked, true, "Student-specific emergency contacts must match the student's family");

  await client.query(
    `insert into emergency_contact(family_id,student_id,full_name,relationship,phone,priority)
     values ($1,$2,'CI Emergency','Aunt','555-0102',1)`,
    [familyId, child1Id],
  );

  const year = await client.query(
    `insert into school_year(name,starts_on,ends_on,status)
     values ($1,'2026-09-01','2027-06-30','planned') returning id`,
    [`CI-2026-2027-${randomUUID()}`],
  );
  const schoolYearId = year.rows[0].id;
  const terms = await client.query(
    `insert into school_term(school_year_id,sequence,name,starts_on,ends_on)
     values
       ($1,1,'September–December','2026-09-01','2026-12-31'),
       ($1,2,'January–March','2027-01-01','2027-03-31'),
       ($1,3,'April–June','2027-04-01','2027-06-30')
     returning id,sequence`,
    [schoolYearId],
  );
  const term1Id = terms.rows.find((row) => row.sequence === 1).id;

  const schoolClass = await client.query(
    `insert into school_class(school_year_id,name,capacity,status)
     values ($1,'CI Casa',10,'active') returning id`,
    [schoolYearId],
  );
  const classId = schoolClass.rows[0].id;

  async function enroll(studentId, startsOn) {
    const enrollment = await client.query(
      `insert into student_enrollment(student_id,school_year_id,class_id,starts_on)
       values ($1,$2,$3,$4) returning id`,
      [studentId, schoolYearId, classId, startsOn],
    );
    const enrollmentId = enrollment.rows[0].id;
    const termStart = startsOn > "2026-09-01" ? startsOn : "2026-09-01";
    await client.query(
      `insert into student_term_enrollment(
         enrollment_id,school_year_id,term_id,starts_on,ends_on
       ) values ($1,$2,$3,$4,'2026-12-31')`,
      [enrollmentId, schoolYearId, term1Id, termStart],
    );
    await client.query(
      `update student set status='active',admission_date=coalesce(admission_date,$2::date)
       where id=$1`,
      [studentId, startsOn],
    );
    await client.query(
      `insert into student_history(student_id,enrollment_id,event_type,event_date,summary)
       values ($1,$2,'enrollment_created',$3,'CI enrollment')`,
      [studentId, enrollmentId, startsOn],
    );
    return enrollmentId;
  }

  const enrollment1 = await enroll(child1Id, "2026-09-01");
  await enroll(child2Id, "2026-10-15");

  const milestone = await client.query(
    `select s.id,s.status,te.starts_on::text as term_starts_on
     from student s
     join student_enrollment e on e.student_id=s.id and e.school_year_id=$1
     join student_term_enrollment te on te.enrollment_id=e.id and te.term_id=$2
     where s.id=any($3::uuid[])
     order by s.id`,
    [schoolYearId, term1Id, [child1Id, child2Id]],
  );
  assert.equal(milestone.rowCount, 2, "Both siblings must be enrolled in 2026-2027 Term 1");
  const midTerm = milestone.rows.find((row) => row.id === child2Id);
  assert.equal(midTerm.term_starts_on, "2026-10-15", "Mid-term enrollment must preserve the actual start date");

  await client.query(
    `update student_enrollment
     set status='withdrawn',withdrawal_on='2026-11-10',withdrawal_reason='CI withdrawal'
     where id=$1`,
    [enrollment1],
  );
  await client.query(
    `update student_term_enrollment
     set status='withdrawn',ends_on='2026-11-10'
     where enrollment_id=$1`,
    [enrollment1],
  );
  await client.query(
    "update student set status='withdrawn',exit_date='2026-11-10' where id=$1",
    [child1Id],
  );
  await client.query(
    `insert into student_history(student_id,enrollment_id,event_type,event_date,summary)
     values ($1,$2,'withdrawal','2026-11-10','CI withdrawal')`,
    [child1Id, enrollment1],
  );

  const retained = await client.query(
    `select s.status,e.status as enrollment_status,count(h.id)::int as history_count
     from student s
     join student_enrollment e on e.student_id=s.id
     left join student_history h on h.student_id=s.id
     where s.id=$1 and e.id=$2
     group by s.status,e.status`,
    [child1Id, enrollment1],
  );
  assert.equal(retained.rows[0].status, "withdrawn");
  assert.equal(retained.rows[0].enrollment_status, "withdrawn");
  assert.ok(retained.rows[0].history_count >= 2, "Withdrawal must preserve earlier student history");

  const historyRow = await client.query(
    "select id from student_history where student_id=$1 order by id limit 1",
    [child1Id],
  );
  await client.query("savepoint history_immutability");
  let historyMutationBlocked = false;
  try {
    await client.query("update student_history set summary='tampered' where id=$1", [historyRow.rows[0].id]);
  } catch {
    historyMutationBlocked = true;
    await client.query("rollback to savepoint history_immutability");
  }
  assert.equal(historyMutationBlocked, true, "Student history must reject updates");

  await client.query("rollback");
  console.log("Families, students, sibling, enrollment, withdrawal, and history invariants verified.");
} finally {
  client.release();
  await pool.end();
}
