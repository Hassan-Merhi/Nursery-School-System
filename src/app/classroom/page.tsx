import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";

type Row=Record<string,any>;
function iso(v:unknown){return String(v??"").slice(0,10);}
function yearsOld(dob:unknown,today:string){
  const birth=new Date(String(dob).slice(0,10)+"T00:00:00Z");
  const now=new Date(today+"T00:00:00Z");
  let years=now.getUTCFullYear()-birth.getUTCFullYear();
  const birthdayPassed=now.getUTCMonth()>birth.getUTCMonth()||(now.getUTCMonth()===birth.getUTCMonth()&&now.getUTCDate()>=birth.getUTCDate());
  if(!birthdayPassed)years--;
  return Math.max(0,years);
}

export default async function ClassroomPage({
  searchParams,
}:{
  searchParams:Promise<{class_id?:string;q?:string}>;
}){
  const auth=await requireUser();
  const can=(p:string)=>auth.permissions.includes(p);
  if(!can("students.view")&&!can("classes.view")&&!can("enrollments.view"))redirect("/forbidden");
  const profile=deriveUiProfile(auth.permissions,auth.roles);
  const {class_id="",q=""}=await searchParams;
  const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today??new Date().toISOString().slice(0,10);

  const currentYear=(await query<Row>("select id,name from school_year where status='current' order by starts_on desc limit 1")).rows[0]??null;
  const classes=currentYear?(await query<Row>(
    "select id,name,room,lead_teacher,capacity from school_class where school_year_id=$1 and status='active' order by name",
    [currentYear.id],
  )).rows:[];

  const assigned=profile.kind==="teacher"
    ? classes.filter((c)=>String(c.lead_teacher??"").trim().toLowerCase()===auth.fullName.trim().toLowerCase())
    : classes;
  const visibleClasses=profile.kind==="teacher"&&assigned.length?assigned:classes;
  const selectedClass=visibleClasses.some((c)=>c.id===class_id)?class_id:"";

  const rows=currentYear?(await query<Row>(
    `select s.id,s.student_number,s.first_name,s.last_name,s.preferred_name,s.date_of_birth::text,
       s.status,s.admission_date::text,e.starts_on::text,c.id class_id,c.name class_name,c.room,
       coalesce((
         select string_agg(t.name,', ' order by t.sequence)
         from student_term_enrollment te join school_term t on t.id=te.term_id
         where te.enrollment_id=e.id and te.status='enrolled'
       ),'') active_terms,
       (select p.name
          from student_food_selection fs join food_package p on p.id=fs.food_package_id
          where fs.student_id=s.id and fs.status='active' and $5::boolean
          order by fs.created_at desc limit 1) food_plan
     from student s
     join student_enrollment e on e.student_id=s.id and e.school_year_id=$1 and e.status='enrolled'
     join school_class c on c.id=e.class_id
     where s.status='active'
       and ($2='' or c.id::text=$2)
       and ($3='' or s.student_number ilike '%'||$3||'%' or concat_ws(' ',s.first_name,s.last_name) ilike '%'||$3||'%')
       and ($4::uuid[] is null or c.id=any($4::uuid[]))
     order by c.name,s.last_name,s.first_name`,
    [
      currentYear.id,
      selectedClass,
      String(q).trim(),
      profile.kind==="teacher"&&assigned.length?assigned.map((c)=>c.id):null,
      can("food.view"),
    ],
  )).rows:[];

  return <main className="app-shell classroom-shell">
    <header className="topbar">
      <div>
        <p className="eyebrow">{profile.kind==="teacher"?"Teacher workspace":"Classroom"}</p>
        <h1>Classroom roster</h1>
        <p className="muted">{currentYear?.name??"No current school year"} · student information only. Financial and administrative details are intentionally excluded.</p>
      </div>
      {profile.kind!=="teacher"&&can("students.manage")?<Link className="button-link secondary-link" href="/students">Full student administration</Link>:null}
    </header>

    {profile.kind==="teacher"&&!assigned.length?<div className="notice">
      Your account is not matched to a class by lead-teacher name, so the permitted active-class roster is shown. An administrator can set the class lead teacher to your account name to narrow this automatically.
    </div>:null}

    <section className="panel classroom-filter">
      <form method="get" action="/classroom" className="billing-search-form">
        <label>Class<select name="class_id" defaultValue={selectedClass}><option value="">All permitted classes</option>{visibleClasses.map((c)=><option key={c.id} value={c.id}>{c.name}{c.room?` · ${c.room}`:""}</option>)}</select></label>
        <label>Find student<input name="q" defaultValue={q} placeholder="Name or student number"/></label>
        <button type="submit">Show roster</button>
      </form>
    </section>

    <section className="money-summary-grid">
      <article className="panel"><p className="eyebrow">Students shown</p><h2>{rows.length}</h2><p className="muted">Active current-year enrollments.</p></article>
      <article className="panel"><p className="eyebrow">Classes available</p><h2>{visibleClasses.length}</h2><p className="muted">{assigned.length&&profile.kind==="teacher"?"Matched to your lead-teacher assignment.":"Based on your permissions."}</p></article>
    </section>

    <section className="classroom-card-grid">
      {rows.map((s)=><Link className="classroom-student-card" href={`/classroom/${s.id}`} key={s.id}>
        <div className="row-between"><div><p className="eyebrow">{s.student_number}</p><h2>{s.preferred_name||s.first_name} {s.last_name}</h2></div><span className="badge">{s.class_name}</span></div>
        <div className="classroom-student-facts">
          <span><small>Age</small><strong>{yearsOld(s.date_of_birth,today)}</strong></span>
          <span><small>Date of birth</small><strong>{iso(s.date_of_birth)}</strong></span>
          <span><small>Room</small><strong>{s.room||"—"}</strong></span>
          <span><small>Terms</small><strong>{s.active_terms||"—"}</strong></span>
        </div>
        {s.food_plan?<p className="muted">Food plan: {s.food_plan}</p>:null}
        <span className="section-card-action">Open student →</span>
      </Link>)}
      {!rows.length?<section className="panel empty-state"><strong>No students match this view</strong><span>Change the class or search filter.</span></section>:null}
    </section>
  </main>;
}
