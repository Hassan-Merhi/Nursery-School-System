import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getAuthContext } from "@/lib/security";
import { removeStoredFile, storeFile } from "@/lib/storage";

export const runtime="nodejs";

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function back(request:Request,kind:"error"|"success",message:string){
  return NextResponse.redirect(new URL("/rentals?"+kind+"="+encodeURIComponent(message),request.url),303);
}

export async function POST(request:Request){
  const auth=await getAuthContext();
  if(!auth)return new Response("Unauthorized",{status:401});
  if(!auth.permissions.includes("rental_documents.manage"))return new Response("Forbidden",{status:403});

  const formData=await request.formData();
  const agreementId=String(formData.get("rental_agreement_id")??"").trim();
  const documentType=String(formData.get("document_type")??"").trim();
  const notes=String(formData.get("notes")??"").trim()||null;
  const file=formData.get("file");

  if(!UUID_RE.test(agreementId))return back(request,"error","Invalid rental agreement.");
  if(!documentType||documentType.length>120)return back(request,"error","Document type is required and must be under 120 characters.");
  if(!(file instanceof File))return back(request,"error","No file selected.");

  let stored:Awaited<ReturnType<typeof storeFile>>|null=null;
  try{
    stored=await storeFile(file);
    await withTransaction(async c=>{
      const agreement=await c.query("select id from rental_agreement where id=$1",[agreementId]);
      if(!agreement.rowCount)throw new Error("Rental agreement not found.");

      const document=await c.query<{id:string}>(
        `insert into stored_document(storage_key,original_name,mime_type,size_bytes,sha256,uploaded_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [stored!.storageKey,stored!.originalName,stored!.mimeType,stored!.sizeBytes,stored!.sha256,auth.userId],
      );
      const link=await c.query<{id:string}>(
        `insert into rental_attachment(rental_agreement_id,document_id,document_type,notes,attached_by)
         values ($1,$2,$3,$4,$5) returning id`,
        [agreementId,document.rows[0].id,documentType,notes,auth.userId],
      );
      await writeAudit(c,{
        actorUserId:auth.userId,
        action:"rental_attachment_uploaded",
        entityType:"rental_attachment",
        entityId:link.rows[0].id,
        after:{
          rentalAgreementId:agreementId,
          documentId:document.rows[0].id,
          documentType,
          originalName:stored!.originalName,
          sizeBytes:stored!.sizeBytes,
          sha256:stored!.sha256,
        },
      });
    });
  }catch(error){
    if(stored)await removeStoredFile(stored.storageKey).catch(()=>undefined);
    return back(request,"error",error instanceof Error?error.message:"Upload failed.");
  }

  return back(request,"success","Rental attachment uploaded.");
}
