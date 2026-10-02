import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
type Row=Record<string,any>;
function iso(v:unknown){return String(v??"").slice(0,10);}
function money(v:unknown,c="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:c,minimumFractionDigits:2}).format(n);}catch{return c+" "+n.toFixed(2);}}
export default async function FoodPlansPage(){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["food.view","food.manage"].some(can))redirect("/forbidden");
 const rows=(await query<Row>(`select x.*,s.family_id,s.student_number,concat_ws(' ',s.first_name,s.last_name) student_name,
   f.display_name family_name,p.code package_code,p.name package_name,p.package_kind,p.package_price,p.currency package_currency,
   t.name term_name,y.name year_name
   from student_food_selection x join student s on s.id=x.student_id join family f on f.id=x.family_id
   join food_package p on p.id=x.food_package_id join school_term t on t.id=x.term_id join school_year y on y.id=x.school_year_id
   order by case x.status when 'active' then 1 else 2 end,s.last_name,s.first_name,x.created_at desc`)).rows;
 const active=rows.filter(r=>r.status==="active");
 return <main className="app-shell food-workspace"><header className="topbar"><div><p className="eyebrow">Food · Students</p><h1>Student food plans</h1><p className="muted">A clean roster of each child’s food package. Changes are made from the family record so food stays with the student.</p></div>{can("food.manage")?<Link className="button-link secondary-link" href="/students">Find student / family</Link>:null}</header><FoodNavigation/>
 <section className="money-summary-grid"><article className="panel"><p className="eyebrow">Active plans</p><h2>{active.length}</h2><p className="muted">{new Set(active.map(r=>r.student_id)).size} students currently enrolled in food.</p></article><article className="panel"><p className="eyebrow">All plan records</p><h2>{rows.length}</h2><p className="muted">Ended and cancelled plans remain visible for history.</p></article></section>
 <section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Roster</p><h2>Plans by student</h2></div></div>
 <div className="responsive-card-table"><table><thead><tr><th>Student</th><th>Package</th><th>Term</th><th>Dates</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td data-label="Student"><strong>{r.student_number} · {r.student_name}</strong><small>{r.family_name}</small></td><td data-label="Package">{r.package_code} · {r.package_name}<small>{r.package_kind} · qty {r.quantity}</small></td><td data-label="Term">{r.year_name} · {r.term_name}</td><td data-label="Dates">{iso(r.starts_on)} → {iso(r.ends_on)}</td><td data-label="Price">{money(r.unit_price,r.currency)}</td><td data-label="Status"><span className="badge">{r.status}</span></td><td data-label="Action"><Link className="button-link secondary-link compact-button" href={`/students/families/${r.family_id}#food`}>Open student food</Link></td></tr>)}{!rows.length?<tr><td colSpan={7}><div className="empty-state"><strong>No student food plans yet</strong><span>Open a family record to add a food package for a child.</span></div></td></tr>:null}</tbody></table></div></section></main>;
}