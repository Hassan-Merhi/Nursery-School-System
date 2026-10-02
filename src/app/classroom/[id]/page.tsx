import Link from "next/link";
import { notFound,redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";

type Row=Record<string,any>;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function iso(v:unknown){return String(v??"").slice(0,10);}

export default async function ClassroomStudentPage({params}:{params:Promise<{id:string}>}){
  const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
  const profile=deriveUiProfile(auth.permissions,auth.roles);
  if(!can("students.view"))redirect("/forbidden");
  const {id}=await params;if(!UUID_RE.test(id))notFound();
  const student=(await query<Row>(
    `select s.id,s.student_number,s.first_name,s.last_name,s.preferred_name,s.date_of_birth::text,s.gender,
       s.nationality,s.status,s.admission_date::text,
       e.starts_on::text,c.name class_name,c.room,c.lead_teacher,y.name year_name,
       coalesce((select string_agg(t.name,', ' order by t.sequence) from student_term_enrollment te join school_term t on t.id=te.term_id where te.enrollment_id=e.id and te.status='enrolled'),'') terms
     from student s
     left join student_enrollment e on e.student_id=s.id and e.status='enrolled'
     left join school_class c on c.id=e.class_id
     left join school_year y on y.id=e.school_year_id
     where s.id=$1
     order by y.starts_on desc nulls last limit 1`,
    [id],
  )).rows[0];
  if(!student)notFound();
  if(profile.kind==="teacher"&&String(student.lead_teacher??"").trim().toLowerCase()!==auth.fullName.trim().toLowerCase())redirect("/classroom");

  const [foodR,historyR,contactsR]=await Promise.all([
    can("food.view")?query<Row>(
      `select p.name,p.package_kind,x.starts_on::text,x.ends_on::text,x.status
       from student_food_selection x join food_package p on p.id=x.food_package_id
       where x.student_id=$1 order by x.created_at desc limit 20`,[id]):Promise.resolve({rows:[] as Row[]}),
    can("student_history.view")?query<Row>(
      "select event_type,event_date::text,summary from student_history where student_id=$1 order by occurred_at desc limit 20",[id]):Promise.resolve({rows:[] as Row[]}),
    can("families.view")?query<Row>(
      `select ec.full_name,ec.relationship,ec.phone,ec.priority
       from emergency_contact ec join student s on s.family_id=ec.family_id
       where s.id=$1 and (ec.student_id is null or ec.student_id=$1)
       order by ec.priority,ec.full_name limit 8`,[id]):Promise.resolve({rows:[] as Row[]}),
  ]);

  return <main className="app-shell classroom-shell">
    <header className="topbar"><div><p className="eyebrow">Classroom student</p><h1>{student.preferred_name||student.first_name} {student.last_name}</h1><p className="muted">{student.student_number} · {student.class_name||"No active class"}{student.room?` · ${student.room}`:""}</p></div><Link className="button-link secondary-link" href="/classroom">Back to classroom</Link></header>
    <section className="panel"><div className="record-grid"><div><small>Date of birth</small><strong>{iso(student.date_of_birth)}</strong></div><div><small>Status</small><strong>{student.status}</strong></div><div><small>School year</small><strong>{student.year_name||"—"}</strong></div><div><small>Terms</small><strong>{student.terms||"—"}</strong></div><div><small>Admission date</small><strong>{student.admission_date?iso(student.admission_date):"—"}</strong></div><div><small>Lead teacher</small><strong>{student.lead_teacher||"—"}</strong></div></div></section>
    {contactsR.rows.length?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Safety</p><h2>Emergency contacts</h2></div></div><div className="money-list">{contactsR.rows.map((c,i)=><article className="money-list-row" key={i}><div><strong>#{c.priority} {c.full_name}</strong><small>{c.relationship}</small></div><strong>{c.phone}</strong></article>)}</div></section>:null}
    {foodR.rows.length?<section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Food</p><h2>Food plans</h2></div></div><div className="money-list">{foodR.rows.map((f,i)=><article className="money-list-row" key={i}><div><strong>{f.name}</strong><small>{f.package_kind} · {iso(f.starts_on)} → {iso(f.ends_on)}</small></div><span className="badge">{f.status}</span></article>)}</div></section>:null}
    {historyR.rows.length?<section className="panel section-block"><details className="hub-details"><summary>Student history ({historyR.rows.length})</summary><div className="history-timeline">{historyR.rows.map((h,i)=><article className="history-event" key={i}><strong>{iso(h.event_date)} · {String(h.event_type).replaceAll("_"," ")}</strong><p>{h.summary}</p></article>)}</div></details></section>:null}
  </main>;
}
