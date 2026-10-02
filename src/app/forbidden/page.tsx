import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="center-card">
      <section className="panel">
        <p className="eyebrow">Access denied</p>
        <h1>You don't have access to this page</h1>
        <p className="muted">
          If you need it for your work, ask an administrator to give your account access.
        </p>
        <Link className="button-link" href="/dashboard">Go to Home</Link>
      </section>
    </main>
  );
}
