import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { FoodNavigation } from "@/components/food-navigation";
type Row=Record<string,any>;
function money(v:unknown,c="USD"){const n=Number(v??0);try{return new Intl.NumberFormat("en-US",{style:"currency",currency:c,minimumFractionDigits:2}).format(n);}catch{return c+" "+n.toFixed(2);}}
export default async function FoodPackagesPage(){
 const auth=await requireUser(),can=(p:string)=>auth.permissions.includes(p);
 if(!["food.view","food.manage"].some(can))redirect("/forbidden");
 const rows=(await query<Row>(`select p.*,t.name term_name,t.sequence,y.name year_name,
   (select count(*)::int from student_food_selection s where s.food_package_id=p.id and s.status='active') active_students,
   coalesce(json_agg(json_build_object('name',i.name,'quantity',pi.quantity) order by i.name) filter(where i.id is not null),'[]'::json) contents
   from food_package p join school_term t on t.id=p.term_id join school_year y on y.id=p.school_year_id
   left join food_package_item pi on pi.food_package_id=p.id left join food_item i on i.id=pi.food_item_id
   group by p.id,t.id,y.id order by case p.status when 'active' then 1 when 'draft' then 2 else 3 end,y.starts_on desc,t.sequence,p.name`)).rows;
 return <main className="app-shell food-workspace"><header className="topbar"><div><p className="eyebrow">Food · Packages</p><h1>Food packages</h1><p className="muted">Simple package list for daily, weekly, monthly and term options.</p></div>{can("food.manage")?<Link className="button-link secondary-link" href="/food/admin">Create or edit packages</Link>:null}</header><FoodNavigation/>
 <section className="food-area-grid compact-area-grid">{["daily","weekly","monthly","term"].map(kind=><article className="food-area-card static-card" key={kind}><div><p className="eyebrow">{kind}</p><h2>{rows.filter(r=>r.package_kind===kind&&r.status==="active").length}</h2><p className="muted">active package{rows.filter(r=>r.package_kind===kind&&r.status==="active").length===1?"":"s"}</p></div></article>)}</section>
 <section className="panel section-block"><div className="section-heading"><div><p className="eyebrow">Package list</p><h2>Current & historical packages</h2></div></div><div className="responsive-card-table"><table><thead><tr><th>Package</th><th>Type</th><th>Term</th><th>Price</th><th>Students</th><th>Contents</th><th>Status</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}><td data-label="Package"><strong>{p.code} · {p.name}</strong></td><td data-label="Type">{p.package_kind}</td><td data-label="Term">{p.year_name} · T{p.sequence} · {p.term_name}</td><td data-label="Price">{money(p.package_price,p.currency)}</td><td data-label="Students">{p.active_students}</td><td data-label="Contents">{(p.contents as Row[]).length?(p.contents as Row[]).map((x,i)=><span className="table-line" key={i}>{x.quantity} × {x.name}</span>):"—"}</td><td data-label="Status"><span className="badge">{p.status}</span></td></tr>)}{!rows.length?<tr><td colSpan={7}><div className="empty-state"><strong>No packages yet</strong><span>Create the first package from Advanced Food.</span></div></td></tr>:null}</tbody></table></div></section></main>;
}