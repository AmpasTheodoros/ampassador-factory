import { redirect } from "next/navigation";
import { authMode, getSession } from "@/lib/auth";
import { login } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSession()) redirect("/overview");
  const mode = authMode();
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-4 text-2xl font-semibold">Command Center</h1>
      {mode === "unconfigured" ? (
        <p role="alert" className="card p-4 text-sm">Sign-in is not configured. Set <code>AAF_ADMIN_PASSWORD</code> (and <code>AAF_SESSION_SECRET</code>) in the environment. Access is closed until then.</p>
      ) : (
        <form action={login} className="card space-y-3 p-4">
          <label className="block text-sm" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required autoFocus className="field" />
          {error && <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>Wrong password.</p>}
          <button className="btn btn-primary w-full" type="submit">Sign in</button>
        </form>
      )}
    </main>
  );
}
