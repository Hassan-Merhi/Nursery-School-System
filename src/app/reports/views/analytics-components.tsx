import type { ReactNode } from "react";

export function money(amount:number|null|undefined,currency="USD"){
  if(amount===null||amount===undefined)return "—";
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);}
  catch{return currency+" "+amount.toFixed(2);}
}
export function percent(value:number|null|undefined){
  return value===null||value===undefined?"—":value.toFixed(2)+"%";
}
export function signed(value:number|null|undefined,suffix=""){
  if(value===null||value===undefined)return "—";
  return (value>0?"+":"")+value.toFixed(2)+suffix;
}
export function monthLabel(value:string){
  const [year,month]=value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US",{month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(Date.UTC(year,month-1,1)));
}
export function MetricCard({label,value,note}:{label:string;value:ReactNode;note?:string}){
  return <article className="panel analytics-metric">
    <p className="eyebrow">{label}</p><h2 className="metric-value">{value}</h2>
    {note?<p className="muted compact-text">{note}</p>:null}
  </article>;
}
export function MoneyStack({rows,field}:{rows:Array<{currency:string}&Record<string,any>>;field:string}){
  if(!rows.length)return <span>—</span>;
  return <span className="money-stack">{rows.map((row)=><span key={row.currency}>{money(Number(row[field]??0),row.currency)}</span>)}</span>;
}
export function MiniBars({points}:{points:Array<{label:string;value:number;display:string}>}){
  if(!points.length)return <p className="muted">No data in this period.</p>;
  const max=Math.max(1,...points.map((point)=>Math.abs(point.value)));
  return <div className="analytics-bars" role="img" aria-label={points.map((p)=>p.label+" "+p.display).join(", ")}>
    {points.map((point)=><div className="analytics-bar-row" key={point.label}>
      <span className="analytics-bar-label">{point.label}</span>
      <span className="analytics-bar-track"><span className="analytics-bar-fill" style={{width:Math.max(1,Math.abs(point.value)/max*100)+"%"}} /></span>
      <strong>{point.display}</strong>
    </div>)}
  </div>;
}
export function EmptyState({children="No data in this period."}:{children?:ReactNode}){
  return <p className="muted analytics-empty">{children}</p>;
}
