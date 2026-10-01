import { query } from "@/lib/db";
import { getAuthContext } from "@/lib/security";
import { loadFile } from "@/lib/storage";

export const runtime="nodejs";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await getAuthContext();
  if(!auth)return new Response("Unauthorized",{status:401});
  if(!auth.permissions.includes("rental_documents.view"))return new Response("Forbidden",{status:403});

  const {id}=await params;
  if(!UUID_RE.test(id))return new Response("Not found",{status:404});

  const r=await query<{storage_key:string;original_name:string;mime_type:string}>(
    `select d.storage_key,d.original_name,d.mime_type
     from rental_attachment ra
     join stored_document d on d.id=ra.document_id
     where ra.id=$1`,
    [id],
  );
  const doc=r.rows[0];
  if(!doc)return new Response("Not found",{status:404});

  try{
    const bytes=await loadFile(doc.storage_key);
    const safe=doc.original_name.replace(/[\r\n"]/g,"_");
    return new Response(bytes,{headers:{
      "Content-Type":doc.mime_type,
      "Content-Disposition":'attachment; filename="'+safe+'"',
      "Content-Length":String(bytes.length),
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff",
      "Content-Security-Policy":"default-src 'none'; sandbox",
    }});
  }catch{
    return new Response("Stored file is unavailable",{status:404});
  }
}
