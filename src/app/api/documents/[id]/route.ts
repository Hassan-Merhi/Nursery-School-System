import { query } from "@/lib/db";
import { getAuthContext } from "@/lib/security";
import { loadFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthContext();
  if (!auth) return new Response("Unauthorized", { status: 401 });
  if (!auth.permissions.includes("documents.view")) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await params;
  const result = await query<{
    storage_key: string;
    original_name: string;
    mime_type: string;
  }>(
    "select storage_key,original_name,mime_type from stored_document where id=$1",
    [id],
  );
  const document = result.rows[0];
  if (!document) return new Response("Not found", { status: 404 });

  try {
    const bytes = await loadFile(document.storage_key);
    const safeName = document.original_name.replace(/[\r\n"]/g, "_");
    return new Response(bytes, {
      headers: {
        "Content-Type": document.mime_type,
        "Content-Disposition": `attachment; filename="${safeName}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new Response("Stored file is unavailable", { status: 404 });
  }
}
