import { redirect } from "next/navigation";
import { currentUser } from "@/lib/runtime";
import { authProviderName, getEnv } from "@/lib/config";
import { login } from "@/lib/actions";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  "1": "Email or password is incorrect.",
  rate: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "Sign-in is temporarily unavailable.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/overview");
  const env = getEnv();
  const provider = authProviderName(env);
  const { error } = await searchParams;
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-4 text-2xl font-semibold">Command Center</h1>
      {provider === "none" ? (
        <p role="alert" className="card p-4 text-sm">Sign-in is not configured. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Access stays closed until then.</p>
      ) : (
        <form action={login} className="card space-y-3 p-4">
          {provider === "local" && <p className="text-xs" style={{ color: "var(--warn)" }}>Development sign-in (not Supabase).</p>}
          <label className="block text-sm" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus className="field" />
          <label className="block text-sm" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="field" />
          {error && <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>{MESSAGES[error] ?? MESSAGES["1"]}</p>}
          <button className="btn btn-primary w-full" type="submit">Sign in</button>
        </form>
      )}
    </main>
  );
}
