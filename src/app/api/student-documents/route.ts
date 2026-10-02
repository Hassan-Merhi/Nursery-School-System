import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { getAuthContext } from "@/lib/security";
import { removeStoredFile, storeFile } from "@/lib/storage";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function back(request: Request, kind: "error" | "success", message: string, returnTo?: string) {
  const safeReturn = returnTo && /^\/students\/families\/[0-9a-f-]{36}$/i.test(returnTo)
    ? returnTo
    : "/students";
  return NextResponse.redirect(
    new URL(`${safeReturn}?${kind}=${encodeURIComponent(message)}#documents`, request.url),
    303,
  );
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) return new Response("Unauthorized", { status: 401 });
  if (!auth.permissions.includes("student_documents.manage")) {
    return new Response("Forbidden", { status: 403 });
  }

  const formData = await request.formData();
  const studentId = String(formData.get("student_id") ?? "").trim();
  const documentType = String(formData.get("document_type") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const returnTo = String(formData.get("return_to") ?? "").trim();
  const file = formData.get("file");

  if (!UUID_RE.test(studentId)) return back(request, "error", "Invalid student.", returnTo);
  if (!documentType || documentType.length > 120) {
    return back(request, "error", "Document type is required and must be under 120 characters.", returnTo);
  }
  if (!(file instanceof File)) return back(request, "error", "No file selected.", returnTo);

  let stored: Awaited<ReturnType<typeof storeFile>> | null = null;
  try {
    stored = await storeFile(file);
    await withTransaction(async (client) => {
      const student = await client.query("select id from student where id=$1", [studentId]);
      if (!student.rowCount) throw new Error("Student not found.");

      const document = await client.query<{ id: string }>(
        `insert into stored_document(
           storage_key,original_name,mime_type,size_bytes,sha256,uploaded_by
         ) values ($1,$2,$3,$4,$5,$6) returning id`,
        [
          stored!.storageKey,
          stored!.originalName,
          stored!.mimeType,
          stored!.sizeBytes,
          stored!.sha256,
          auth.userId,
        ],
      );
      const documentId = document.rows[0].id;
      const link = await client.query<{ id: string }>(
        `insert into student_document(student_id,document_id,document_type,notes,created_by)
         values ($1,$2,$3,$4,$5) returning id`,
        [studentId, documentId, documentType, notes, auth.userId],
      );

      await client.query(
        `insert into student_history(student_id,event_type,event_date,summary,details,actor_user_id)
         values ($1,'document_added',current_date,$2,$3::jsonb,$4)`,
        [
          studentId,
          `${documentType} document added`,
          JSON.stringify({ documentLinkId: link.rows[0].id, originalName: stored!.originalName }),
          auth.userId,
        ],
      );
      await writeAudit(client, {
        actorUserId: auth.userId,
        action: "student_document_uploaded",
        entityType: "student_document",
        entityId: link.rows[0].id,
        after: {
          studentId,
          documentId,
          documentType,
          originalName: stored!.originalName,
          sizeBytes: stored!.sizeBytes,
          sha256: stored!.sha256,
        },
      });
    });
  } catch (error) {
    if (stored) await removeStoredFile(stored.storageKey).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Upload failed.";
    return back(request, "error", message, returnTo);
  }

  return back(request, "success", "Student document uploaded and added to history.", returnTo);
}
