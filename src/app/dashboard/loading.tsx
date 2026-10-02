export default function DashboardLoading() {
  return (
    <main className="app-shell">
      <section className="panel section-block" role="status" aria-live="polite">
        <p className="eyebrow">Montikids</p>
        <h1>Loading today’s school snapshot…</h1>
        <p className="muted">Preparing current fees, cash, payroll, rent and alerts.</p>
      </section>
    </main>
  );
}
