import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function StudentHubRedirect({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  const profile = deriveUiProfile(auth.permissions, auth.roles);
  const allowed = [
    "families.view","families.manage","students.view","students.manage",
    "enrollments.view","enrollments.manage","student_documents.view","student_documents.manage",
    "student_history.view","billing.view","billing.manage","payments.view","payments.manage",
    "food.view","food.manage","food.billing","food.payments",
  ].some((permission) => auth.permissions.includes(permission));
  if (!allowed) redirect("/forbidden");

  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  if (profile.kind === "teacher") redirect(`/classroom/${id}`);
  const result = await query<{ family_id: string }>("select family_id from student where id=$1", [id]);
  const student = result.rows[0];
  if (!student) notFound();
  redirect(`/students/families/${student.family_id}#student-${id}`);
}
