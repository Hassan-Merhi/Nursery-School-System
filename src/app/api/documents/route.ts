import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/security";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { removeStoredFile, storeFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) return new Response("Unauthorized", { status: 401 });
  if (!auth.permissions.includes("documents.manage")) {
    return new Response("Forbidden", { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.redirect(new URL("/dashboard?error=No%20file%20selected.", request.url), 303);
  }

  let stored: Awaited<ReturnType<typeof storeFile>> | null = null;
  try {
    stored = await storeFile(file);
    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into stored_document
           (storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [
          stored!.storageKey,
          stored!.originalName,
          stored!.mimeType,
          stored!.sizeBytes,
          stored!.sha256,
          auth.userId,
        ],
      );
      await writeAudit(client, {
        actorUserId: auth.userId,
        action: "document_uploaded",
        entityType: "document",
        entityId: inserted.rows[0].id,
        after: {
          name: stored!.originalName,
          mimeType: stored!.mimeType,
          sizeBytes: stored!.sizeBytes,
          sha256: stored!.sha256,
        },
      });
    });
  } catch (error) {
    if (stored) await removeStoredFile(stored.storageKey).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Upload failed.";
    return NextResponse.redirect(
      new URL(`/dashboard?error=${encodeURIComponent(message)}`, request.url),
      303,
    );
  }

  return NextResponse.redirect(
    new URL("/dashboard?success=Document%20uploaded.", request.url),
    303,
  );
}
