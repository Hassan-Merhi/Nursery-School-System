import type { PoolClient } from "pg";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export const PAYROLL_ROLES=new Set(["payroll_expense","salary_payable","salary_advance"]);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE=/^\d+(?:\.\d{1,2})?$/;

export function v(d:FormData,k:string){return String(d.get(k)??"").trim();}
export function bad(m:string):never{redirect("/payroll?error="+encodeURIComponent(m));}
export function good(m:string,d?:FormData):never{
  revalidatePath("/payroll");revalidatePath("/staff");revalidatePath("/accounting");revalidatePath("/operations");revalidatePath("/dashboard");
  const returnTo=d?String(d.get("return_to")??"").trim():"";
  if(/^\/staff\/[0-9a-f-]{36}$/i.test(returnTo)){revalidatePath(returnTo);redirect(returnTo+"?success="+encodeURIComponent(m));}
  if(returnTo==="/staff"){redirect("/staff?success="+encodeURIComponent(m));}
  redirect("/payroll?success="+encodeURIComponent(m));
}
export function id(raw:string,label:string){if(!UUID_RE.test(raw))bad("Invalid "+label+".");return raw;}
export function oid(raw:string,label:string){return raw?id(raw,label):null;}
export function day(raw:string,label:string){if(!DATE_RE.test(raw)||Number.isNaN(Date.parse(raw+"T00:00:00Z")))bad("Enter a valid "+label+".");return raw;}
export function amt(raw:string,label:string){if(!MONEY_RE.test(raw))bad("Enter a valid "+label+" with at most two decimals.");const n=Number(raw);if(!Number.isFinite(n)||n<=0||n>999999999.99)bad(label+" must be greater than zero.");return n.toFixed(2);}
export function cur(raw:string){const c=(raw||"USD").toUpperCase();if(!/^[A-Z]{3}$/.test(c))bad("Currency must be a three-letter code.");return c;}
export function integer(raw:string,label:string,min:number,max:number){const n=Number.parseInt(raw,10);if(!Number.isInteger(n)||String(n)!==raw||n<min||n>max)bad(label+" must be between "+min+" and "+max+".");return n;}
export async function nextNo(c:PoolClient,t:string,u:string){
  const r=await c.query<{prefix:string;number:string}>("update document_sequence set next_number=next_number+1,updated_at=now(),updated_by=$2 where document_type=$1 returning prefix,(next_number-1)::text as number",[t,u]);
  if(!r.rows[0])bad("Document sequence "+t+" is not configured.");
  return r.rows[0].prefix+"-"+String(r.rows[0].number).padStart(6,"0");
}
export async function openPeriod(c:PoolClient,d:string){if(!(await c.query("select 1 from accounting_period where status='open' and $1::date between starts_on and ends_on",[d])).rowCount)bad("Posting date is not inside an open accounting period.");}
export async function payrollReady(c:PoolClient,date:string,roles:string[]){
  await openPeriod(c,date);
  if(!(await c.query("select 1 from accounting_configuration x join journal j on j.id=x.payroll_journal_id where x.id=1 and j.status='active'")).rowCount)bad("Configure an active Payroll journal before posting payroll transactions.");
  for(const role of roles)if(!(await c.query("select 1 from accounting_mapping m join account a on a.id=m.account_id where m.role_key=$1 and a.status='active' and a.allow_posting=true",[role])).rowCount)bad("Accounting mapping "+role+" is not configured.");
}
