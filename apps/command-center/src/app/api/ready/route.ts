import { NextResponse } from "next/server";
import { getEnv, isProd, productionProblems } from "@/lib/config";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Readiness for deploy checks and uptime monitors. Reveals variable NAMES that are missing and whether the
 * database answers; never values, never data.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;
  try {
    const env = getEnv();
    const problems = isProd(env) || env.AAF_RUNTIME_MODE === "e2e" ? productionProblems(env) : [];
    checks.config = problems.length ? { ok: false, problems } : { ok: true };
    if (problems.length) ok = false;
  } catch (e) {
    checks.config = { ok: false, problems: [{ key: "environment", problem: (e as Error).message.slice(0, 200) }] };
    ok = false;
  }
  try {
    const { database } = await getDb();
    const h = await database.health();
    checks.database = { ok: h.ok, kind: database.kind, latencyMs: h.latencyMs };
    if (!h.ok) ok = false;
    if (h.ok) {
      const m = await database
        .run({ kind: "anon" }, (q) => q.query<{ n: number }>(`select count(*)::int as n from rate_limits where false`))
        .then(() => true)
        .catch(() => false);
      checks.schema = { ok: m };
      if (!m) ok = false;
    }
  } catch (e) {
    checks.database = { ok: false, error: (e as Error).message.slice(0, 120) };
    ok = false;
  }
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
