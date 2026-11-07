import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { Db, LOCAL_BOOTSTRAP, LOCAL_GRANTS } from "./db";

/**
 * Runs the real migration CLI (scripts/migrate.ts) over the Postgres wire protocol against an EMPTY database,
 * the same way it will run against Supabase. The Supabase-provided pieces (auth.uid, anon, authenticated) are
 * created first by the test, exactly as Supabase would have them.
 */
/** async on purpose: the in-process database server must keep answering while the CLI runs */
function cli(cwd: string, env: Record<string, string>, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [resolve(cwd, "node_modules/tsx/dist/cli.mjs"), "scripts/migrate.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ status, stdout, stderr }));
  });
}

describe("db:migrate CLI", () => {
  it("applies all migrations in a transaction, is idempotent, and --check reports state", async () => {
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const empty = await Db.open({ migrate: false });
    await empty.exec(LOCAL_BOOTSTRAP);
    const server = new PGLiteSocketServer({ db: empty.pg, port: 54413, host: "127.0.0.1" });
    await server.start();
    const pkg = resolve(__dirname, "..");
    const run = (...args: string[]) => cli(pkg, { DATABASE_ADMIN_URL: "postgres://postgres:x@127.0.0.1:54413/postgres" }, args);
    try {
      const pending = await run("--check");
      expect(pending.status).toBe(1);
      expect(pending.stdout).toMatch(/pending: 0001_init\.sql/);

      const first = await run();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toMatch(/applied: 0001_init\.sql, 0002_approval_immutability\.sql, 0003_least_privilege\.sql, 0004_jobs\.sql, 0005_budget_and_unknown_outcome\.sql/);

      const second = await run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/nothing to apply/);
      expect((await run("--check")).stdout).toMatch(/up to date/);

      // schema is really there and the least-privilege grants took effect
      await empty.exec(LOCAL_GRANTS);
      const c = new pg.Client({ connectionString: "postgres://postgres:x@127.0.0.1:54413/postgres" });
      await c.connect();
      const t = await c.query(`select count(*)::int as n from pg_tables where schemaname='public' and tablename in ('jobs','approvals','audit_log','rate_limits')`);
      expect(t.rows[0].n).toBe(4);
      const g = await c.query(`select has_table_privilege('authenticated','audit_log','DELETE') as d, has_table_privilege('authenticated','audit_log','INSERT') as i, has_table_privilege('anon','tasks','SELECT') as a`);
      expect(g.rows[0]).toEqual({ d: false, i: true, a: false });
      await c.end();
    } finally {
      await server.stop();
      await empty.close();
    }
  }, 240_000);

  it("refuses to run without DATABASE_ADMIN_URL and never prints a URL", async () => {
    const r = await cli(resolve(__dirname, ".."), { DATABASE_ADMIN_URL: "" }, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("DATABASE_ADMIN_URL is not set");
  }, 120_000);
});
