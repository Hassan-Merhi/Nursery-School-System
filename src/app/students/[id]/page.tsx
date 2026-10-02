import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";

export default async function StudentHubRedirect({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const result = await query<{ family_id: string }>("select family_id from student where id=$1", [id]);
  const student = result.rows[0];
  if (!student) notFound();
  redirect(`/students/families/${student.family_id}#student-${id}`);
}
