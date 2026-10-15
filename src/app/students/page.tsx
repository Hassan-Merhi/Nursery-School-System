import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/security";
import { deriveUiProfile } from "@/lib/ui-profile";
import {
  HubHeader,
  Notices,
  ViewSwitcher,
  flattenParams,
  pickView,
  type HubView,
  type SearchParams,
} from "@/components/hub";
import { StudentsDirectoryView } from "./views/directory";
import { EnrollChildView } from "./views/enroll";
import { ClassroomView } from "./views/classroom";

const DIRECTORY_PERMISSIONS = [
  "families.view","families.manage","students.view","students.manage","classes.view","classes.manage",
  "enrollments.view","enrollments.manage","student_documents.view","student_documents.manage","student_history.view",
];

export default async function StudentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const auth = await requireUser();
  const params = flattenParams(await searchParams);
  const profile = deriveUiProfile(auth.permissions, auth.roles);
  const can = (permission: string) => auth.permissions.includes(permission);
  const any = (items: string[]) => items.some(can);
  // Teachers only ever see the classroom-safe roster, never family or financial administration.
  const teacher = profile.kind === "teacher";
  const canEnroll = can("families.manage") && can("students.manage") && can("enrollments.manage");

  const views: HubView[] = [
    { key: "directory", label: "Directory", show: !teacher && any(DIRECTORY_PERMISSIONS) },
    { key: "enroll", label: "Enroll a child", show: !teacher && canEnroll },
    { key: "classroom", label: "Classroom", show: any(["students.view","classes.view","enrollments.view"]) },
  ].filter((view) => view.show);

  if (!views.length) redirect("/forbidden");
  const view = pickView(views, params.view);

  return (
    <main className="app-shell hub-shell">
      <HubHeader
        eyebrow={teacher ? "Teacher workspace" : "Students"}
        title={teacher ? "Classroom" : "Students"}
        description={
          view.key === "classroom"
            ? "Class rosters and student information without financial administration."
            : view.key === "enroll"
              ? "Family, child and class in one guided step."
              : "Families, students, classes, enrollment, documents and history."
        }
        actions={canEnroll && view.key !== "enroll"
          ? <Link className="button-link students-primary-action" href="/students?view=enroll">Enroll a child</Link>
          : null}
      />
      <ViewSwitcher base="/students" views={views} active={view.key} label="Student sections" />
      <Notices error={params.error} success={params.success} />

      {view.key === "directory" ? <StudentsDirectoryView auth={auth} params={params} /> : null}
      {view.key === "enroll" ? <EnrollChildView auth={auth} params={params} /> : null}
      {view.key === "classroom" ? <ClassroomView auth={auth} params={params} /> : null}
    </main>
  );
}
