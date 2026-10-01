import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/security";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { removeStoredFile, storeFile } from "@/lib/storage";

export const runtime="nodejs";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await getAuthContext();
  if(!auth)return new Response("Unauthorized",{status:401});
  if(!auth.permissions.includes("expenses.manage"))return new Response("Forbidden",{status:403});
  const {id}=await params;
  const data=await request.formData();
  const file=data.get("file");
  if(!(file instanceof File))return NextResponse.redirect(new URL("/operations?error=No%20file%20selected.",request.url),303);

  let stored:Awaited<ReturnType<typeof storeFile>>|null=null;
  try{
    stored=await storeFile(file);
    await withTransaction(async client=>{
      const expense=await client.query("select expense_number from expense where id=$1",[id]);
      if(!expense.rowCount)throw new Error("Expense not found.");
      const doc=await client.query<{id:string}>("insert into stored_document(storage_key,original_name,mime_type,size_bytes,sha256,uploaded_by) values ($1,$2,$3,$4,$5,$6) returning id",[stored!.storageKey,stored!.originalName,stored!.mimeType,stored!.sizeBytes,stored!.sha256,auth.userId]);
      await client.query("insert into expense_receipt(expense_id,document_id,attached_by) values ($1,$2,$3)",[id,doc.rows[0].id,auth.userId]);
      await writeAudit(client,{actorUserId:auth.userId,action:"expense_receipt_uploaded",entityType:"expense",entityId:id,after:{documentId:doc.rows[0].id,name:stored!.originalName,sha256:stored!.sha256}});
    });
  }catch(error){
    if(stored)await removeStoredFile(stored.storageKey).catch(()=>undefined);
    const message=error instanceof Error?error.message:"Upload failed.";
    return NextResponse.redirect(new URL("/operations?error="+encodeURIComponent(message),request.url),303);
  }
  return NextResponse.redirect(new URL("/operations?success=Expense%20receipt%20uploaded.",request.url),303);
}
