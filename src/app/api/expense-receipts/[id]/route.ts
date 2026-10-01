import { query } from "@/lib/db";
import { getAuthContext } from "@/lib/security";
import { loadFile } from "@/lib/storage";

export const runtime="nodejs";

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await getAuthContext();
  if(!auth)return new Response("Unauthorized",{status:401});
  if(!["expenses.view","expenses.manage","expenses.approve","expenses.post","report_documents.view"].some((p)=>auth.permissions.includes(p)))return new Response("Forbidden",{status:403});
  const {id}=await params;
  const r=await query<{storage_key:string;original_name:string;mime_type:string}>("select d.storage_key,d.original_name,d.mime_type from expense_receipt er join stored_document d on d.id=er.document_id where d.id=$1",[id]);
  const doc=r.rows[0];if(!doc)return new Response("Not found",{status:404});
  try{
    const bytes=await loadFile(doc.storage_key);
    const safe=doc.original_name.replace(/[\\r\\n"]/g,"_");
    return new Response(bytes,{headers:{"Content-Type":doc.mime_type,"Content-Disposition":'attachment; filename="'+safe+'"',"Content-Length":String(bytes.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
  }catch{return new Response("Stored file is unavailable",{status:404});}
}
