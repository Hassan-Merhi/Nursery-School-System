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
        <p className="eyebrow">Montikids</p>
        <h1>School management</h1>
        <p className="muted">
          Sign in with an account created by an administrator.
        </p>
        {error ? <div className="notice error">{error}</div> : null}
        <form action={loginAction} className="stack">
          <label>
            Email
            <input type="email" name="email" autoComplete="username" required />
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
