import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/security";
import { loginAction } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getAuthContext()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">M</div>
        <p className="eyebrow">Montikids school system</p>
        <h1>Welcome back</h1>
        <p className="muted">
          Sign in with the email and password your administrator gave you.
        </p>
        {error ? <div className="notice error">{error}</div> : null}
        <form action={loginAction} className="stack">
          <label>
            Email
            <input type="email" name="email" autoComplete="username" placeholder="you@example.com" required autoFocus />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
