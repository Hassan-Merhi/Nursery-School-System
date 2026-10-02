import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { guidedEnrollmentAction } from "./actions";

type Row=Record<string,any>;
export default async function AdmissionsPage({searchParams}:{searchParams:Promise<{error?:string}>}){
 const auth=await requireUser();
 for(const p of ["families.manage","students.manage","enrollments.manage"])if(!auth.permissions.includes(p))redirect("/forbidden");
 const {error}=await searchParams;
 const today=(await query<{today:string}>("select (now() at time zone 'Asia/Beirut')::date::text today")).rows[0]?.today??new Date().toISOString().slice(0,10);
 const [familiesR,yearsR]=await Promise.all([
  query<Row>("select id,family_number,display_name from family order by display_name limit 500"),
  query<Row>(`select y.id,y.name,y.starts_on::text,y.ends_on::text,y.status,
    coalesce(json_agg(json_build_object('id',t.id,'name',t.name,'sequence',t.sequence,'starts_on',t.starts_on::text,'ends_on',t.ends_on::text,'status',t.status) order by t.sequence) filter(where t.id is not null),'[]') terms
    from school_year y left join school_term t on t.school_year_id=y.id
    where y.status<>'closed' group by y.id order by case y.status when 'current' then 1 else 2 end,y.starts_on desc`),
 ]);
 const families=familiesR.rows,years=yearsR.rows;
 const classes=(await query<Row>(`select c.id,c.school_year_id,c.name,c.room,c.capacity,c.status,
   (select count(*)::int from student_enrollment e where e.class_id=c.id and e.status='enrolled') enrolled_count
   from school_class c join school_year y on y.id=c.school_year_id
   where c.status<>'archived' and y.status<>'closed' order by y.starts_on desc,c.name`)).rows;
 return <main className="app-shell admissions-shell">
  <header className="topbar"><div><p className="eyebrow">Reception · Admissions</p><h1>Enroll a child</h1><p className="muted">One form creates the family contact when needed, the child record, and the school-year enrollment.</p></div><Link className="button-link secondary-link" href="/students">Back to Students</Link></header>
  {error?<div className="notice error">{error}</div>:null}
  <form action={guidedEnrollmentAction} className="guided-task-form">
   <section className="panel guided-step"><div className="guided-step-number">1</div><div className="guided-step-body"><div className="section-heading"><div><p className="eyebrow">Family</p><h2>Choose an existing family or create a new one</h2></div></div>
    <label>Existing family<select name="family_id" defaultValue=""><option value="">Create a new family below</option>{families.map(f=><option key={f.id} value={f.id}>{f.family_number} · {f.display_name}</option>)}</select></label>
    <details className="hub-details" open><summary>New family details</summary><div className="form-grid hub-action-form"><label>Family display name<input name="family_display_name" placeholder="e.g. Merhi Family"/></label><label>Primary guardian relationship<input name="guardian_relationship" placeholder="Mother, Father, Guardian"/></label><label>Guardian first name<input name="guardian_first_name"/></label><label>Guardian last name<input name="guardian_last_name"/></label><label>Guardian phone<input name="guardian_phone"/></label><label>Guardian email<input name="guardian_email" type="email"/></label><label className="span-2">Address<input name="family_address"/></label></div></details>
   </div></section>
   <section className="panel guided-step"><div className="guided-step-number">2</div><div className="guided-step-body"><div className="section-heading"><div><p className="eyebrow">Child</p><h2>Student details</h2></div></div><div className="form-grid">
    <label>First name<input name="student_first_name" required/></label><label>Last name<input name="student_last_name" required/></label><label>Preferred name<input name="preferred_name"/></label><label>Date of birth<input name="date_of_birth" type="date" max={today} required/></label><label>Gender<select name="gender" defaultValue=""><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unspecified">Unspecified</option></select></label><label>Nationality<input name="nationality"/></label>
   </div></div></section>
   <section className="panel guided-step"><div className="guided-step-number">3</div><div className="guided-step-body"><div className="section-heading"><div><p className="eyebrow">Enrollment</p><h2>Class and terms</h2></div></div>
    {years.map((y,index)=><div className="admission-year" key={y.id}><label className="admission-year-choice"><input type="radio" name="school_year_id" value={y.id} defaultChecked={index===0}/><strong>{y.name}</strong><span>{y.status}</span></label><div className="form-grid"><label>Class<select name={index===0?"class_id":"class_id_unused"} defaultValue=""><option value="">Select class for this year</option>{classes.filter(c=>c.school_year_id===y.id).map(c=><option key={c.id} value={c.id}>{c.name}{c.room?` · ${c.room}`:""} · {c.enrolled_count}{c.capacity?`/${c.capacity}`:""}</option>)}</select></label><div><span className="field-label">Terms</span><div className="check-grid">{(y.terms as Row[]).map(t=><label className="check" key={t.id}><input type="checkbox" name="term_id" value={t.id} disabled={t.status==="closed"}/>{t.name}</label>)}</div></div></div></div>)}
    <div className="form-grid"><label>Starts on<input name="starts_on" type="date" defaultValue={today} required/></label><label>Enrollment notes<input name="enrollment_notes"/></label></div>
   </div></section>
   <div className="guided-submit"><div><strong>Ready to enroll?</strong><p className="muted">The child will be active immediately and the complete history will be preserved.</p></div><button type="submit">Enroll child</button></div>
  </form>
 </main>;
}