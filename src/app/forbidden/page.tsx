import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="center-card">
      <section className="panel">
        <p className="eyebrow">Access denied</p>
        <h1>You do not have permission to open that area.</h1>
        <p className="muted">
          Ask an administrator to update your role if you need access.
        </p>
        <Link className="button-link" href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}
