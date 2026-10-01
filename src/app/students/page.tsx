import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
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
  terms: { id: string; sequence: number; name: string; starts_on: string; ends_on: string }[];
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
             'id',t.id,'sequence',t.sequence,'name',t.name,
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
          <h1>Families, Students & Enrollment</h1>
          <p className="muted">
            Family records are the source of truth for sibling relationships and future sibling discounts.
          </p>
        </div>
        <Link className="button-link secondary-link" href="/dashboard">Foundation dashboard</Link>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <section className="status-grid">
        <article className="panel">
          <p className="eyebrow">Families</p>
          <h2>{families.length} family records</h2>
          <p className="muted">Parents, guardians, children and emergency contacts stay connected.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Students</p>
          <h2>{students.length} students</h2>
          <p className="muted">Sibling relationships are derived from shared family membership.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Enrollment</p>
          <h2>{enrollments.filter((item) => item.status === "enrolled").length} open enrollments</h2>
          <p className="muted">Term and mid-term start dates are preserved as historical records.</p>
        </article>
      </section>

      {can("families.view") || can("families.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Family structure</p>
              <h2>Families, parents & emergency contacts</h2>
              <p className="muted">Create the family first, then attach parents/guardians and children.</p>
            </div>
          </div>

          {can("families.manage") ? (
            <>
              <form action={createFamilyAction} className="form-grid create-box">
                <label>Family display name<input name="display_name" placeholder="Merhi family" required /></label>
                <label>Home phone<input name="home_phone" /></label>
                <label className="span-2">Address<textarea name="address" /></label>
                <label className="span-2">Notes<textarea name="notes" /></label>
                <button type="submit">Create family</button>
              </form>

              <form action={createGuardianAction} className="form-grid create-box">
                <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.family_number} · {family.display_name}</option>)}</select></label>
                <label>Relationship<input name="relationship" placeholder="Mother, father, guardian…" required /></label>
                <label>First name<input name="first_name" required /></label>
                <label>Last name<input name="last_name" required /></label>
                <label>Phone<input name="phone" required /></label>
                <label>Alternate phone<input name="alternate_phone" /></label>
                <label>Email<input name="email" type="email" /></label>
                <label>Occupation<input name="occupation" /></label>
                <label className="span-2">Address<textarea name="address" /></label>
                <fieldset className="span-2">
                  <legend>Guardian permissions</legend>
                  <div className="check-grid">
                    <label className="check"><input type="checkbox" name="is_primary" /> Primary guardian</label>
                    <label className="check"><input type="checkbox" name="has_legal_custody" defaultChecked /> Legal custody</label>
                    <label className="check"><input type="checkbox" name="pickup_authorized" defaultChecked /> Pickup authorized</label>
                  </div>
                </fieldset>
                <button type="submit">Add parent / guardian</button>
              </form>

              <form action={createEmergencyContactAction} className="form-grid create-box">
                <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.family_number} · {family.display_name}</option>)}</select></label>
                <label>Student (optional)<select name="student_id" defaultValue=""><option value="">Whole family</option>{students.map((student) => <option key={student.id} value={student.id}>{student.student_number} · {student.first_name} {student.last_name}</option>)}</select></label>
                <label>Contact name<input name="full_name" required /></label>
                <label>Relationship<input name="relationship" required /></label>
                <label>Phone<input name="phone" required /></label>
                <label>Alternate phone<input name="alternate_phone" /></label>
                <label>Priority<input name="priority" type="number" min="1" max="9" defaultValue="1" required /></label>
                <label>Notes<input name="notes" /></label>
                <button type="submit">Add emergency contact</button>
              </form>
            </>
          ) : null}

          <div className="card-list">
            {families.map((family) => (
              <article className="subcard" key={family.id}>
                <div className="row-between">
                  <div><strong>{family.display_name}</strong><div className="muted">{family.family_number}{family.home_phone ? ` · ${family.home_phone}` : ""}</div></div>
                  <span className="badge">{family.students.length} child{family.students.length === 1 ? "" : "ren"}</span>
                </div>
                {family.address ? <p className="muted">{family.address}</p> : null}
                <div className="record-grid">
                  <div><strong>Parents / guardians</strong>{family.guardians.length ? family.guardians.map((guardian) => <p className="muted compact-text" key={guardian.id}>{guardian.first_name} {guardian.last_name} · {guardian.relationship}{guardian.is_primary ? " · Primary" : ""} · {guardian.phone}</p>) : <p className="muted compact-text">None yet</p>}</div>
                  <div><strong>Children</strong>{family.students.length ? family.students.map((student) => <p className="muted compact-text" key={student.id}>{student.student_number} · {student.first_name} {student.last_name} · {student.status}</p>) : <p className="muted compact-text">None yet</p>}</div>
                  <div><strong>Emergency contacts</strong>{family.emergency_contacts.length ? family.emergency_contacts.map((contact) => <p className="muted compact-text" key={contact.id}>#{contact.priority} {contact.full_name} · {contact.relationship} · {contact.phone}{contact.student_name ? ` · ${contact.student_name}` : ""}</p>) : <p className="muted compact-text">None yet</p>}</div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {can("students.view") || can("students.manage") ? (
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Student records</p><h2>Students & sibling relationships</h2></div></div>
          {can("students.manage") ? (
            <form action={createStudentAction} className="form-grid create-box">
              <label>Family<select name="family_id" required defaultValue=""><option value="" disabled>Select family</option>{families.map((family) => <option key={family.id} value={family.id}>{family.family_number} · {family.display_name}</option>)}</select></label>
              <label>Date of birth<input name="date_of_birth" type="date" required /></label>
              <label>First name<input name="first_name" required /></label>
              <label>Last name<input name="last_name" required /></label>
              <label>Preferred name<input name="preferred_name" /></label>
              <label>Gender<select name="gender" defaultValue=""><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unspecified">Prefer not to say</option></select></label>
              <label>Nationality<input name="nationality" /></label>
              <label>Notes<input name="notes" /></label>
              <button type="submit">Add student</button>
            </form>
          ) : null}

          <div className="card-list">
            {students.map((student) => (
              <article className="subcard" key={student.id}>
                <div className="row-between">
                  <div><strong>{student.first_name} {student.last_name}</strong><div className="muted">{student.student_number} · {student.family_number} · {student.family_name}</div></div>
                  <span className="badge">{student.status}</span>
                </div>
                <p className="muted">Born {student.date_of_birth}{student.preferred_name ? ` · Preferred name: ${student.preferred_name}` : ""}</p>
                <div className="chips">
                  {student.siblings.length ? student.siblings.map((sibling) => <span className="chip" key={sibling.id}>Sibling: {sibling.name} ({sibling.student_number})</span>) : <span className="chip">No sibling currently in this family record</span>}
                </div>
                {can("students.manage") && !["active"].includes(student.status) ? (
                  <form action={updateStudentStatusAction} className="inline-form compact-form">
                    <input type="hidden" name="student_id" value={student.id} />
                    <label>Status<select name="status" defaultValue={student.status === "withdrawn" ? "inactive" : student.status}><option value="prospective">Prospective</option><option value="inactive">Inactive</option><option value="graduated">Graduated</option></select></label>
                    <label>Effective date<input name="effective_on" type="date" required /></label>
                    <label>Note<input name="note" /></label>
                    <button className="secondary" type="submit">Update status</button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {can("classes.view") || can("classes.manage") ? (
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Class structure</p><h2>Classes by school year</h2></div></div>
          {can("classes.manage") ? (
            <form action={createClassAction} className="form-grid create-box">
              <label>School year<select name="school_year_id" required defaultValue=""><option value="" disabled>Select year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name} · {year.status}</option>)}</select></label>
              <label>Class name<input name="name" placeholder="Casa 1" required /></label>
              <label>Room<input name="room" /></label>
              <label>Lead teacher<input name="lead_teacher" /></label>
              <label>Capacity<input name="capacity" type="number" min="1" max="500" /></label>
              <label>Status<select name="status" defaultValue="active"><option value="planned">Planned</option><option value="active">Active</option><option value="archived">Archived</option></select></label>
              <button type="submit">Create class</button>
            </form>
          ) : null}
          <div className="table-wrap"><table><thead><tr><th>Year</th><th>Class</th><th>Teacher</th><th>Room</th><th>Enrollment</th><th>Status</th></tr></thead><tbody>{classes.map((item) => <tr key={item.id}><td>{item.school_year_name}</td><td>{item.name}</td><td>{item.lead_teacher ?? "—"}</td><td>{item.room ?? "—"}</td><td>{item.enrolled_count}{item.capacity ? ` / ${item.capacity}` : ""}</td><td>{item.status}</td></tr>)}</tbody></table></div>
        </section>
      ) : null}

      {can("enrollments.view") || can("enrollments.manage") ? (
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Enrollment</p><h2>School-year & term enrollment</h2><p className="muted">For mid-term enrollment, set the actual first attendance date. Selected term coverage starts on that date.</p></div></div>
          {can("enrollments.manage") ? (
            <form action={createEnrollmentAction} className="form-grid create-box">
              <label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select student</option>{students.filter((student) => student.status !== "graduated").map((student) => <option key={student.id} value={student.id}>{student.student_number} · {student.first_name} {student.last_name}</option>)}</select></label>
              <label>School year<select name="school_year_id" required defaultValue=""><option value="" disabled>Select year</option>{years.map((year) => <option key={year.id} value={year.id}>{year.name}</option>)}</select></label>
              <label>Class<select name="class_id" required defaultValue=""><option value="" disabled>Select class</option>{classes.filter((item) => item.status !== "archived").map((item) => <option key={item.id} value={item.id}>{item.school_year_name} · {item.name}</option>)}</select></label>
              <label>Actual start date<input name="starts_on" type="date" required /></label>
              <fieldset className="span-2"><legend>Term enrollment</legend><div className="permission-grid">{years.flatMap((year) => year.terms.map((term) => <label className="check permission-item" key={term.id}><input type="checkbox" name="term_id" value={term.id} /><span><strong>{year.name} · Term {term.sequence}</strong><small>{term.name} · {term.starts_on} to {term.ends_on}</small></span></label>))}</div></fieldset>
              <label className="span-2">Notes<textarea name="notes" /></label>
              <button type="submit">Enroll student</button>
            </form>
          ) : null}

          <div className="card-list">
            {enrollments.map((enrollment) => (
              <article className="subcard" key={enrollment.id}>
                <div className="row-between"><div><strong>{enrollment.student_name}</strong><div className="muted">{enrollment.student_number} · {enrollment.school_year_name} · {enrollment.class_name}</div></div><span className="badge">{enrollment.status}</span></div>
                <p className="muted">Started {enrollment.starts_on}{enrollment.withdrawal_on ? ` · Withdrawn ${enrollment.withdrawal_on}` : ""}</p>
                <div className="term-grid">{enrollment.terms.map((term) => <div key={term.id}><strong>{term.name}</strong><small>{term.starts_on} → {term.ends_on}</small><small>{term.status}</small></div>)}</div>
                {enrollment.withdrawal_reason ? <p className="muted">Withdrawal reason: {enrollment.withdrawal_reason}</p> : null}
                {can("enrollments.manage") && enrollment.status === "enrolled" ? (
                  <form action={withdrawEnrollmentAction} className="inline-form compact-form">
                    <input type="hidden" name="enrollment_id" value={enrollment.id} />
                    <label>Withdrawal date<input name="withdrawal_on" type="date" min={enrollment.starts_on} required /></label>
                    <label>Reason<input name="withdrawal_reason" required /></label>
                    <button className="secondary" type="submit">Record withdrawal</button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {can("student_documents.view") || can("student_documents.manage") ? (
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Documents</p><h2>Student documents</h2></div></div>
          {can("student_documents.manage") ? (
            <form action="/api/student-documents" method="post" encType="multipart/form-data" className="form-grid create-box">
              <label>Student<select name="student_id" required defaultValue=""><option value="" disabled>Select student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.student_number} · {student.first_name} {student.last_name}</option>)}</select></label>
              <label>Document type<input name="document_type" placeholder="Birth certificate, ID, consent…" required /></label>
              <label>File<input type="file" name="file" required /></label>
              <label>Notes<input name="notes" /></label>
              <button type="submit">Upload student document</button>
            </form>
          ) : null}
          {can("student_documents.view") ? <div className="table-wrap"><table><thead><tr><th>Student</th><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th /></tr></thead><tbody>{documents.map((document) => <tr key={document.id}><td>{document.student_number} · {document.student_name}</td><td>{document.document_type}</td><td>{document.original_name}</td><td>{Math.ceil(Number(document.size_bytes) / 1024)} KB</td><td>{new Date(document.created_at).toLocaleString("en-GB")}</td><td><a href={`/api/student-documents/${document.id}`}>Open</a></td></tr>)}</tbody></table></div> : null}
        </section>
      ) : null}

      {can("student_history.view") ? (
        <section className="panel section-block">
          <div className="section-heading"><div><p className="eyebrow">Permanent history</p><h2>Student history</h2><p className="muted">This log is append-only. Withdrawal changes status but does not erase prior records.</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>Date</th><th>Student</th><th>Event</th><th>Summary</th><th>Recorded by</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td>{item.event_date}</td><td>{item.student_number} · {item.student_name}</td><td><code>{item.event_type}</code></td><td>{item.summary}</td><td>{item.actor_name ?? "System / unknown"}</td></tr>)}</tbody></table></div>
        </section>
      ) : null}

      <section className="panel section-block">
        <p className="eyebrow">Milestone 2 workflow</p>
        <h2>Family → Parent → Child 1 + Child 2 → 2026–2027 Term 1</h2>
        <p className="muted">Create the 2026–2027 school year in the Foundation dashboard if it does not exist, create a class here, then enroll both children with the September–December term selected. Their sibling relationship appears automatically because both children share the same family.</p>
      </section>
    </main>
  );
}
