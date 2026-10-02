export default function DashboardLoading() {
  return (
    <main className="app-shell">
      <section className="panel section-block" role="status" aria-live="polite">
        <p className="eyebrow">Montikids</p>
        <h1>Loading your dashboard…</h1>
        <p className="muted">Your sign-in succeeded. Preparing school data and permissions.</p>
      </section>
    </main>
  );
}
