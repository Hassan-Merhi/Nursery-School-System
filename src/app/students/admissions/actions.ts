"use server";

import type { PoolClient } from "pg";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireUser } from "@/lib/security";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
function fail(m:string):never{redirect("/students/admissions?error="+encodeURIComponent(m));}
function id(raw:string,label:string){if(!UUID_RE.test(raw))fail("Invalid "+label+".");return raw;}
function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))fail("Enter a valid "+label+".");return raw;}
function list(d:FormData,k:string){const values=d.getAll(k).map(String);if(values.some(x=>!UUID_RE.test(x)))fail("Invalid term selection.");return values;}
async function assertPermissions(){
  const auth=await requireUser();
  for(const p of ["families.manage","students.manage","enrollments.manage"]){
    if(!auth.permissions.includes(p))redirect("/forbidden");
  }
  return auth;
}
async function validateEnrollment(c:PoolClient,studentId:string,yearId:string,classId:string,startsOn:string,termIds:string[]){
  const classR=await c.query<{
    name:string;capacity:number|null;year_starts_on:string;year_ends_on:string;class_status:string;year_status:string
  }>(`select c.name,c.capacity,c.status class_status,y.status year_status,
       y.starts_on::text year_starts_on,y.ends_on::text year_ends_on
     from school_class c join school_year y on y.id=c.school_year_id
     where c.id=$1 and c.school_year_id=$2 for update of c`,[classId,yearId]);
  const row=classR.rows[0];
  if(!row)fail("Class does not belong to the selected school year.");
  if(row.class_status==="archived"||row.year_status==="closed")fail("The selected class or school year is closed.");
  if(startsOn<row.year_starts_on||startsOn>row.year_ends_on)fail("Enrollment date must fall inside the school year.");
  if(row.capacity!==null){
    const count=(await c.query<{count:number}>("select count(*)::int count from student_enrollment where class_id=$1 and status='enrolled'",[classId])).rows[0]?.count??0;
    if(count>=row.capacity)fail("The selected class is already at capacity.");
  }
  if(!termIds.length)fail("Select at least one term.");
  const terms=await c.query<{id:string;name:string;starts_on:string;ends_on:string;status:string}>(
    "select id,name,starts_on::text,ends_on::text,status from school_term where school_year_id=$1 and id=any($2::uuid[]) order by sequence",
    [yearId,termIds],
  );
  if(terms.rowCount!==termIds.length)fail("One or more terms are invalid for the selected year.");
  if(terms.rows.some(t=>t.status==="closed"||startsOn>t.ends_on))fail("One or more selected terms cannot accept this enrollment.");
  return {classRow:row,terms:terms.rows};
}

export async function guidedEnrollmentAction(d:FormData){
  const auth=await assertPermissions();
  const existingFamily=v(d,"family_id");
  const first=v(d,"student_first_name"),last=v(d,"student_last_name");
  const dob=day(v(d,"date_of_birth"),"date of birth");
  const gender=v(d,"gender")||null;
  if(!first||!last)fail("Student first and last name are required.");
  if(gender&&!["female","male","other","unspecified"].includes(gender))fail("Invalid gender.");
  const yearId=id(v(d,"school_year_id"),"school year");
  const classId=id(v(d,"class_id"),"class");
  const startsOn=day(v(d,"starts_on"),"enrollment start date");
  const termIds=list(d,"term_id");

  let familyId="",studentId="";
  await withTransaction(async c=>{
    if(existingFamily){
      familyId=id(existingFamily,"family");
      if(!(await c.query("select 1 from family where id=$1",[familyId])).rowCount)fail("Family not found.");
    }else{
      const display=v(d,"family_display_name"),gFirst=v(d,"guardian_first_name"),gLast=v(d,"guardian_last_name"),phone=v(d,"guardian_phone"),relationship=v(d,"guardian_relationship");
      if(!display)fail("Enter a family display name or choose an existing family.");
      if(!gFirst||!gLast||!phone||!relationship)fail("Primary guardian name, relationship and phone are required for a new family.");
      const email=v(d,"guardian_email");
      if(email&&!/^\S+@\S+\.\S+$/.test(email))fail("Enter a valid guardian email.");
      const family=await c.query<{id:string;family_number:string}>(
        "insert into family(display_name,home_phone,address,notes,created_by,updated_by) values($1,$2,$3,$4,$5,$5) returning id,family_number",
        [display,phone,v(d,"family_address")||null,v(d,"family_notes")||null,auth.userId],
      );
      familyId=family.rows[0].id;
      const guardian=await c.query<{id:string}>(
        "insert into guardian(first_name,last_name,email,phone,created_by,updated_by) values($1,$2,$3,$4,$5,$5) returning id",
        [gFirst,gLast,email||null,phone,auth.userId],
      );
      await c.query(
        "insert into family_guardian(family_id,guardian_id,relationship,is_primary,has_legal_custody,pickup_authorized,created_by) values($1,$2,$3,true,true,true,$4)",
        [familyId,guardian.rows[0].id,relationship,auth.userId],
      );
      await writeAudit(c,{actorUserId:auth.userId,action:"family_created",entityType:"family",entityId:familyId,after:{familyNumber:family.rows[0].family_number,displayName:display,source:"guided_enrollment"}});
    }

    const student=await c.query<{id:string;student_number:string}>(
      `insert into student(family_id,first_name,last_name,preferred_name,date_of_birth,gender,nationality,notes,created_by,updated_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id,student_number`,
      [familyId,first,last,v(d,"preferred_name")||null,dob,gender,v(d,"nationality")||null,v(d,"student_notes")||null,auth.userId],
    );
    studentId=student.rows[0].id;

    const {classRow,terms}=await validateEnrollment(c,studentId,yearId,classId,startsOn,termIds);
    const enrollment=await c.query<{id:string}>(
      "insert into student_enrollment(student_id,school_year_id,class_id,starts_on,notes,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$6) returning id",
      [studentId,yearId,classId,startsOn,v(d,"enrollment_notes")||null,auth.userId],
    );
    for(const term of terms){
      await c.query(
        "insert into student_term_enrollment(enrollment_id,school_year_id,term_id,starts_on,ends_on,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$6)",
        [enrollment.rows[0].id,yearId,term.id,startsOn>term.starts_on?startsOn:term.starts_on,term.ends_on,auth.userId],
      );
    }
    await c.query("update student set status='active',admission_date=$2,updated_at=now(),updated_by=$3 where id=$1",[studentId,startsOn,auth.userId]);
    await c.query(
      "insert into student_history(student_id,enrollment_id,event_type,event_date,summary,details,actor_user_id) values($1,$2,'enrollment_created',$3,$4,$5::jsonb,$6)",
      [studentId,enrollment.rows[0].id,startsOn,`Enrolled in ${classRow.name}`,JSON.stringify({yearId,classId,termIds,source:"guided_enrollment"}),auth.userId],
    );
    await writeAudit(c,{actorUserId:auth.userId,action:"guided_student_enrollment_completed",entityType:"student_enrollment",entityId:enrollment.rows[0].id,after:{familyId,studentId,studentNumber:student.rows[0].student_number,classId,yearId,termIds,startsOn}});
  });

  revalidatePath("/students");revalidatePath("/dashboard");revalidatePath(`/students/families/${familyId}`);
  redirect(`/students/families/${familyId}?success=${encodeURIComponent("Child enrolled successfully. Family, student and enrollment are ready.")}#enrollment`);
}
