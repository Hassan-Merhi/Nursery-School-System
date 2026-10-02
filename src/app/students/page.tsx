import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";
import {
  createClassAction,
  createEmergencyContactAction,
  createEnrollmentAction,
  createFamilyAction,
  createGuardianAction,
  createStudentAction,
  updateStudentStatusAction,
  withdrawEnrollmentAction,
} from "./actions";

type Guardian = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  relationship: string;
  is_primary: boolean;
};

type FamilyStudent = {
  id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  status: string;
};

type EmergencyContact = {
  id: string;
  full_name: string;
  relationship: string;
  phone: string;
  priority: number;
  student_name: string | null;
};

type FamilyRow = {
  id: string;
  family_number: string;
  display_name: string;
  home_phone: string | null;
  address: string | null;
  guardians: Guardian[];
  students: FamilyStudent[];
  emergency_contacts: EmergencyContact[];
};

type Sibling = {
  id: string;
  student_number: string;
  name: string;
};

type StudentRow = {
  id: string;
  family_id: string;
  family_number: string;
  family_name: string;
  student_number: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string;
  status: string;
  admission_date: string | null;
  exit_date: string | null;
  siblings: Sibling[];
};

type YearRow = {
  id: string;
  name: string;
  status: string;
  starts_on: string;
  ends_on: string;
  terms: { id: string; sequence: number; name: string; starts_on: string; ends_on: string; status: string }[];
};

type ClassRow = {
  id: string;
  school_year_id: string;
  school_year_name: string;
  name: string;
  room: string | null;
  lead_teacher: string | null;
  capacity: number | null;
  status: string;
  enrolled_count: number;
};

type EnrollmentRow = {
  id: string;
  student_id: string;
  student_number: string;
  student_name: string;
  school_year_name: string;
  class_name: string;
  status: string;
  enrolled_on: string;
  starts_on: string;
  withdrawal_on: string | null;
  withdrawal_reason: string | null;
  terms: { id: string; name: string; status: string; starts_on: string; ends_on: string }[];
};

type DocumentRow = {
  id: string;
  student_id: string;
  student_number: string;
  student_name: string;
  document_type: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  created_at: Date;
};

type HistoryRow = {
  id: string;
  student_number: string;
  student_name: string;
  event_type: string;
  event_date: string;
  summary: string;
  occurred_at: Date;
  actor_name: string | null;
};

const STEP2_PERMISSIONS = [
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

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const profile = deriveUiProfile(auth.permissions, auth.roles);
  if (profile.kind === "teacher") redirect("/classroom");
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  if (!STEP2_PERMISSIONS.some(can)) redirect("/forbidden");

  const needsFamilies =
    can("families.view") || can("families.manage") || can("students.manage");
  const needsStudents =
    can("students.view") || can("students.manage") ||
    can("enrollments.view") || can("enrollments.manage") ||
    can("student_documents.view") || can("student_documents.manage") ||
    can("student_history.view") || can("families.manage");
  const needsYears = can("classes.view") || can("classes.manage") || can("enrollments.manage");
  const needsClasses = can("classes.view") || can("classes.manage") || can("enrollments.view") || can("enrollments.manage");

  const families: FamilyRow[] = needsFamilies
    ? (await query<FamilyRow>(
        `select f.id,f.family_number,f.display_name,f.home_phone,f.address,
           coalesce((
             select json_agg(json_build_object(
               'id',g.id,'first_name',g.first_name,'last_name',g.last_name,
               'phone',g.phone,'email',g.email,'relationship',fg.relationship,
               'is_primary',fg.is_primary
             ) order by fg.is_primary desc,g.last_name,g.first_name)
             from family_guardian fg
             join guardian g on g.id=fg.guardian_id
             where fg.family_id=f.id
           ),'[]'::json) as guardians,
           coalesce((
             select json_agg(json_build_object(
               'id',s.id,'student_number',s.student_number,'first_name',s.first_name,
               'last_name',s.last_name,'status',s.status
             ) order by s.last_name,s.first_name)
             from student s where s.family_id=f.id
           ),'[]'::json) as students,
           coalesce((
             select json_agg(json_build_object(
               'id',ec.id,'full_name',ec.full_name,'relationship',ec.relationship,
               'phone',ec.phone,'priority',ec.priority,
               'student_name',case when s.id is null then null else s.first_name || ' ' || s.last_name end
             ) order by ec.priority,ec.full_name)
             from emergency_contact ec
             left join student s on s.id=ec.student_id
             where ec.family_id=f.id
           ),'[]'::json) as emergency_contacts
         from family f
         order by f.display_name,f.family_number`,
      )).rows
    : [];

  const students: StudentRow[] = needsStudents
    ? (await query<StudentRow>(
        `select s.id,s.family_id,f.family_number,f.display_name as family_name,
           s.student_number,s.first_name,s.last_name,s.preferred_name,
           s.date_of_birth::text,s.status,s.admission_date::text,s.exit_date::text,
           coalesce((
             select json_agg(json_build_object(
               'id',sib.id,'student_number',sib.student_number,
               'name',sib.first_name || ' ' || sib.last_name
             ) order by sib.last_name,sib.first_name)
             from student_sibling_relationship sr
             join student sib on sib.id=sr.sibling_id
             where sr.student_id=s.id
           ),'[]'::json) as siblings
         from student s
         join family f on f.id=s.family_id
         order by s.last_name,s.first_name,s.student_number`,
      )).rows
    : [];

  const years: YearRow[] = needsYears
    ? (await query<YearRow>(
        `select y.id,y.name,y.status,y.starts_on::text,y.ends_on::text,
           coalesce(json_agg(json_build_object(
             'id',t.id,'sequence',t.sequence,'name',t.name,'status',t.status,
             'starts_on',t.starts_on::text,'ends_on',t.ends_on::text
           ) order by t.sequence) filter (where t.id is not null),'[]'::json) as terms
         from school_year y
         left join school_term t on t.school_year_id=y.id
         group by y.id
         order by y.starts_on desc`,
      )).rows
    : [];

  const classes: ClassRow[] = needsClasses
    ? (await query<ClassRow>(
        `select c.id,c.school_year_id,y.name as school_year_name,c.name,c.room,c.lead_teacher,
           c.capacity,c.status,
           (select count(*)::int from student_enrollment e
             where e.class_id=c.id and e.status='enrolled') as enrolled_count
         from school_class c
         join school_year y on y.id=c.school_year_id
         order by y.starts_on desc,c.name`,
      )).rows
    : [];

  const teacherUsers: { id: string; full_name: string; email: string }[] = can("classes.manage")
    ? (await query<{ id: string; full_name: string; email: string }>(
        `select distinct u.id,u.full_name,u.email
         from app_user u
         join user_role ur on ur.user_id=u.id
         join role r on r.id=ur.role_id
         where u.status='active' and lower(r.name)='teacher'
         order by u.full_name,u.email`,
      )).rows
    : [];

  const enrollments: EnrollmentRow[] = can("enrollments.view") || can("enrollments.manage")
    ? (await query<EnrollmentRow>(
        `select e.id,e.student_id,s.student_number,
           s.first_name || ' ' || s.last_name as student_name,
           y.name as school_year_name,c.name as class_name,e.status,
           e.enrolled_on::text,e.starts_on::text,e.withdrawal_on::text,e.withdrawal_reason,
           coalesce((
             select json_agg(json_build_object(
               'id',te.id,'name',t.name,'status',te.status,
               'starts_on',te.starts_on::text,'ends_on',te.ends_on::text
             ) order by t.sequence)
             from student_term_enrollment te
             join school_term t on t.id=te.term_id
             where te.enrollment_id=e.id
           ),'[]'::json) as terms
         from student_enrollment e
         join student s on s.id=e.student_id
         join school_year y on y.id=e.school_year_id
         join school_class c on c.id=e.class_id
         order by y.starts_on desc,e.created_at desc`,
      )).rows
    : [];

  const documents: DocumentRow[] = can("student_documents.view")
    ? (await query<DocumentRow>(
        `select sd.id,sd.student_id,s.student_number,
           s.first_name || ' ' || s.last_name as student_name,
           sd.document_type,d.original_name,d.mime_type,d.size_bytes,sd.created_at
         from student_document sd
         join student s on s.id=sd.student_id
         join stored_document d on d.id=sd.document_id
         order by sd.created_at desc limit 100`,
      )).rows
    : [];

  const history: HistoryRow[] = can("student_history.view")
    ? (await query<HistoryRow>(
        `select h.id,s.student_number,s.first_name || ' ' || s.last_name as student_name,
           h.event_type,h.event_date::text,h.summary,h.occurred_at,u.full_name as actor_name
         from student_history h
         join student s on s.id=h.student_id
         left join app_user u on u.id=h.actor_user_id
         order by h.occurred_at desc,h.id desc limit 200`,
      )).rows
    : [];

  const openEnrollments = enrollments.filter((item) => item.status === "enrolled").length;

  return (
    <main className="app-shell students-workspace-shell">
      <header className="students-workspace-header">
        <div>
          <p className="eyebrow">Students</p>
          <h1>Families & enrollment</h1>
          <p className="muted">Everything about children, families, classes and enrollment in one place.</p>
        </div>
        {can("families.manage") && can("students.manage") && can("enrollments.manage") ? (
          <Link className="button-link students-primary-action" href="/students/admissions">Enroll a child</Link>
        ) : null}
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <section className="students-summary-strip" aria-label="Student overview">
        <a href="#families">
          <span>Families</span>
          <strong>{families.length}</strong>
        </a>
        <a href="#students">
          <span>Students</span>
          <strong>{students.length}</strong>
        </a>
        <a href="#enrollment">
          <span>Enrolled</span>
          <strong>{openEnrollments}</strong>
        </a>
        <a href="#classes">
          <span>Classes</span>
          <strong>{classes.length}</strong>
        </a>
      </section>

      <nav className="students-jump-nav" aria-label="Student workspace sections">
        {(can("families.view") || can("families.manage")) ? <a href="#families">Families</a> : null}
        {(can("students.view") || can("students.manage")) ? <a href="#students">Students</a> : null}
        {(can("classes.view") || can("classes.manage")) ? <a href="#classes">Classes</a> : null}
        {(can("enrollments.view") || can("enrollments.manage")) ? <a href="#enrollment">Enrollment</a> : null}
        {(can("student_documents.view") || can("student_documents.manage")) ? <a href="#documents">Documents</a> : null}
        {can("student_history.view") ? <a href="#history">History</a> : null}
      </nav>

      <div className="students-module-list">
        {can("families.view") || can("families.manage") ? (
          <details className="students-module" id="families">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">F</span>
                <span>
                  <strong>Families</strong>
                  <small>Parents, guardians and emergency contacts</small>
                </span>
              </span>
              <span className="students-module-count">{families.length}</span>
            </summary>
            <div className="students-module-body">
              {can("families.manage") ? (
                <div className="students-action-row">
                  <details className="students-action">
                    <summary>Add family</summary>
                    <form action={createFamilyAction} className="form-grid students-compact-form">
                      <label>Family name<input name="display_name" placeholder="Merhi family" required /></label>
                      <label>Home phone<input name="home_phone" /></label>
                      <label className="span-2">Address<textarea name="address" /></label>
                      <label className="span-2">Notes<textarea name="notes" /></label>
                      <button type="submit">Create family</button>
                    </form>
                  </details>

                  <details className="students-action">
                    <summary>Add parent / guardian</summary>
                    <form action={createGuardianAction} className="form-grid students-compact-form">
                      <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.display_name}</option>)}</select></label>
                      <label>Relationship<input name="relationship" placeholder="Mother, father, guardian…" required /></label>
                      <label>First name<input name="first_name" required /></label>
                      <label>Last name<input name="last_name" required /></label>
                      <label>Phone<input name="phone" required /></label>
                      <label>Alternate phone<input name="alternate_phone" /></label>
                      <label>Email<input name="email" type="email" /></label>
                      <label>Occupation<input name="occupation" /></label>
                      <label className="span-2">Address<textarea name="address" /></label>
                      <fieldset className="span-2">
                        <legend>Permissions</legend>
                        <div className="check-grid">
                          <label className="check"><input type="checkbox" name="is_primary" /> Primary guardian</label>
                          <label className="check"><input type="checkbox" name="has_legal_custody" defaultChecked /> Legal custody</label>
                          <label className="check"><input type="checkbox" name="pickup_authorized" defaultChecked /> Pickup authorized</label>
                        </div>
                      </fieldset>
                      <button type="submit">Add guardian</button>
                    </form>
                  </details>

                  <details className="students-action">
                    <summary>Add emergency contact</summary>
                    <form action={createEmergencyContactAction} className="form-grid students-compact-form">
                      <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.display_name}</option>)}</select></label>
                      <label>Student (optional)<select name="student_id" defaultValue=""><option value="">Whole family</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select></label>
                      <label>Contact name<input name="full_name" required /></label>
                      <label>Relationship<input name="relationship" required /></label>
                      <label>Phone<input name="phone" required /></label>
                      <label>Alternate phone<input name="alternate_phone" /></label>
                      <label>Priority<input name="priority" type="number" min="1" max="9" defaultValue="1" required /></label>
                      <label>Notes<input name="notes" /></label>
                      <button type="submit">Add contact</button>
                    </form>
                  </details>
                </div>
              ) : null}

              {families.length ? (
                <div className="students-record-list">
                  {families.map((family) => (
                    <Link className="students-record-row" href={`/students/families/${family.id}`} key={family.id}>
                      <span>
                        <strong>{family.display_name}</strong>
                        <small>{family.family_number}{family.home_phone ? ` · ${family.home_phone}` : ""}</small>
                      </span>
                      <span className="students-row-meta">
                        <span>{family.students.length} child{family.students.length === 1 ? "" : "ren"}</span>
                        <span aria-hidden="true">→</span>
                      </span>
                    </Link>
                  ))}
                </div>
              ) : <div className="students-empty-state">No families yet.</div>}
            </div>
          </details>
        ) : null}

        {can("students.view") || can("students.manage") ? (
          <details className="students-module" id="students">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">S</span>
                <span>
                  <strong>Students</strong>
                  <small>Student records and sibling relationships</small>
                </span>
              </span>
              <span className="students-module-count">{students.length}</span>
            </summary>
            <div className="students-module-body">
              {can("students.manage") ? (
                <details className="students-action students-single-action">
                  <summary>Add student</summary>
                  <form action={createStudentAction} className="form-grid students-compact-form">
                    <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.display_name}</option>)}</select></label>
                    <label>Date of birth<input name="date_of_birth" type="date" required /></label>
                    <label>First name<input name="first_name" required /></label>
                    <label>Last name<input name="last_name" required /></label>
                    <label>Preferred name<input name="preferred_name" /></label>
                    <label>Gender<select name="gender" defaultValue=""><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unspecified">Prefer not to say</option></select></label>
                    <label>Nationality<input name="nationality" /></label>
                    <label>Notes<input name="notes" /></label>
                    <button type="submit">Add student</button>
                  </form>
                </details>
              ) : null}

              {students.length ? (
                <div className="students-record-list">
                  {students.map((student) => (
                    <div className="students-record-row students-record-row-static" key={student.id}>
                      <Link className="students-row-link" href={`/students/${student.id}`}>
                        <span>
                          <strong>{student.first_name} {student.last_name}</strong>
                          <small>{student.student_number} · {student.family_name}</small>
                        </span>
                        <span className="badge">{student.status}</span>
                      </Link>
                      {can("students.manage") && student.status !== "active" ? (
                        <details className="students-inline-edit">
                          <summary>Update status</summary>
                          <form action={updateStudentStatusAction} className="inline-form compact-form">
                            <input type="hidden" name="student_id" value={student.id} />
                            <label>Status<select name="status" defaultValue={student.status === "withdrawn" ? "inactive" : student.status}><option value="prospective">Prospective</option><option value="inactive">Inactive</option><option value="graduated">Graduated</option></select></label>
                            <label>Effective date<input name="effective_on" type="date" required /></label>
                            <label>Note<input name="note" /></label>
                            <button className="secondary" type="submit">Save</button>
                          </form>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : <div className="students-empty-state">No students yet.</div>}
            </div>
          </details>
        ) : null}

        {can("classes.view") || can("classes.manage") ? (
          <details className="students-module" id="classes">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">C</span>
                <span>
                  <strong>Classes</strong>
                  <small>School-year classrooms and capacity</small>
                </span>
              </span>
              <span className="students-module-count">{classes.length}</span>
            </summary>
            <div className="students-module-body">
              {can("classes.manage") ? (
                <details className="students-action students-single-action">
                  <summary>Create class</summary>
                  <form action={createClassAction} className="form-grid students-compact-form">
                    <label>School year<select name="school_year_id" required defaultValue=""><option value="" disabled>Select year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name} · {year.status}</option>)}</select></label>
                    <label>Class name<input name="name" placeholder="Casa 1" required /></label>
                    <label>Room<input name="room" /></label>
                    <label>Lead teacher<input name="lead_teacher" list="teacher-user-names" placeholder="Teacher name" /><datalist id="teacher-user-names">{teacherUsers.map((teacher) => <option key={teacher.id} value={teacher.full_name}>{teacher.email}</option>)}</datalist></label>
                    <label>Capacity<input name="capacity" type="number" min="1" max="500" /></label>
                    <label>Status<select name="status" defaultValue="active"><option value="planned">Planned</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
                    <button type="submit">Create class</button>
                  </form>
                </details>
              ) : null}
              {classes.length ? (
                <div className="responsive-card-table students-table">
                  <table>
                    <thead><tr><th>Class</th><th>Year</th><th>Teacher</th><th>Room</th><th>Enrollment</th><th>Status</th></tr></thead>
                    <tbody>{classes.map((item) => <tr key={item.id}><td data-label="Class"><strong>{item.name}</strong></td><td data-label="Year">{item.school_year_name}</td><td data-label="Teacher">{item.lead_teacher ?? "—"}</td><td data-label="Room">{item.room ?? "—"}</td><td data-label="Enrollment">{item.enrolled_count}{item.capacity ? ` / ${item.capacity}` : ""}</td><td data-label="Status">{item.status}</td></tr>)}</tbody>
                  </table>
                </div>
              ) : <div className="students-empty-state">No classes yet.</div>}
            </div>
          </details>
        ) : null}

        {can("enrollments.view") || can("enrollments.manage") ? (
          <details className="students-module" id="enrollment">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">E</span>
                <span>
                  <strong>Enrollment</strong>
                  <small>School-year and term enrollment</small>
                </span>
              </span>
              <span className="students-module-count">{openEnrollments}</span>
            </summary>
            <div className="students-module-body">
              {can("enrollments.manage") ? (
                <details className="students-action students-single-action">
                  <summary>Enroll student</summary>
                  <form action={createEnrollmentAction} className="form-grid students-compact-form">
                    <label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select student</option>{students.filter((student) => student.status !== "graduated").map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select></label>
                    <label>School year<select name="school_year_id" required defaultValue=""><option value="" disabled>Select year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
                    <label>Class<select name="class_id" required defaultValue=""><option value="" disabled>Select class</option>{classes.filter((item) => item.status !== "archived").map((item) => <option key={item.id} value={item.id}>{item.school_year_name} · {item.name}</option>)}</select></label>
                    <label>Start date<input name="starts_on" type="date" required /></label>
                    <fieldset className="span-2"><legend>Terms</legend><div className="permission-grid">{years.flatMap((year) => year.terms.map((term) => <label className="check permission-item" key={term.id}><input type="checkbox" name="term_id" value={term.id} disabled={term.status === "closed" || year.status === "closed"} /><span><strong>{year.name} · Term {term.sequence}</strong><small>{term.name} · {term.starts_on} to {term.ends_on}</small></span></label>))}</div></fieldset>
                    <label className="span-2">Notes<textarea name="notes" /></label>
                    <button type="submit">Enroll student</button>
                  </form>
                </details>
              ) : null}

              {enrollments.length ? (
                <div className="students-record-list">
                  {enrollments.map((enrollment) => (
                    <div className="students-record-row students-record-row-static" key={enrollment.id}>
                      <div className="students-row-link">
                        <span>
                          <strong>{enrollment.student_name}</strong>
                          <small>{enrollment.school_year_name} · {enrollment.class_name} · started {enrollment.starts_on}</small>
                        </span>
                        <span className="badge">{enrollment.status}</span>
                      </div>
                      {can("enrollments.manage") && enrollment.status === "enrolled" ? (
                        <details className="students-inline-edit">
                          <summary>Withdraw</summary>
                          <form action={withdrawEnrollmentAction} className="inline-form compact-form">
                            <input type="hidden" name="enrollment_id" value={enrollment.id} />
                            <label>Date<input name="withdrawal_on" type="date" min={enrollment.starts_on} required /></label>
                            <label>Reason<input name="withdrawal_reason" required /></label>
                            <button className="secondary" type="submit">Record withdrawal</button>
                          </form>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : <div className="students-empty-state">No enrollment records yet.</div>}
            </div>
          </details>
        ) : null}

        {can("student_documents.view") || can("student_documents.manage") ? (
          <details className="students-module" id="documents">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">D</span>
                <span>
                  <strong>Documents</strong>
                  <small>Birth certificates, IDs, consent forms and more</small>
                </span>
              </span>
              <span className="students-module-count">{documents.length}</span>
            </summary>
            <div className="students-module-body">
              {can("student_documents.manage") ? (
                <details className="students-action students-single-action">
                  <summary>Upload document</summary>
                  <form action="/api/student-documents" method="post" encType="multipart/form-data" className="form-grid students-compact-form">
                    <label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.first_name} {student.last_name}</option>)}</select></label>
                    <label>Document type<input name="document_type" placeholder="Birth certificate, ID, consent…" required /></label>
                    <label>File<input type="file" name="file" required /></label>
                    <label>Notes<input name="notes" /></label>
                    <button type="submit">Upload</button>
                  </form>
                </details>
              ) : null}
              {can("student_documents.view") && documents.length ? (
                <div className="responsive-card-table students-table">
                  <table><thead><tr><th>Student</th><th>Type</th><th>File</th><th>Uploaded</th><th /></tr></thead><tbody>{documents.map((document) => <tr key={document.id}><td data-label="Student">{document.student_name}</td><td data-label="Type">{document.document_type}</td><td data-label="File">{document.original_name}</td><td data-label="Uploaded">{new Date(document.created_at).toLocaleDateString("en-GB")}</td><td data-label="Action"><a href={`/api/student-documents/${document.id}`}>Open</a></td></tr>)}</tbody></table>
                </div>
              ) : <div className="students-empty-state">No student documents yet.</div>}
            </div>
          </details>
        ) : null}

        {can("student_history.view") ? (
          <details className="students-module" id="history">
            <summary>
              <span className="students-module-title">
                <span className="students-module-icon">H</span>
                <span>
                  <strong>History</strong>
                  <small>Permanent student activity log</small>
                </span>
              </span>
              <span className="students-module-count">{history.length}</span>
            </summary>
            <div className="students-module-body">
              {history.length ? (
                <div className="responsive-card-table students-table">
                  <table><thead><tr><th>Date</th><th>Student</th><th>Event</th><th>Summary</th><th>Recorded by</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td data-label="Date">{item.event_date}</td><td data-label="Student">{item.student_name}</td><td data-label="Event">{item.event_type}</td><td data-label="Summary">{item.summary}</td><td data-label="Recorded by">{item.actor_name ?? "System"}</td></tr>)}</tbody></table>
                </div>
              ) : <div className="students-empty-state">No history yet.</div>}
            </div>
          </details>
        ) : null}
      </div>
    </main>
  );
}
