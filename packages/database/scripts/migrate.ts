/**
 * Applies supabase/migrations/*.sql to a Postgres/Supabase database.
 *
 *   DATABASE_ADMIN_URL=postgres://postgres:...@db.<ref>.supabase.co:5432/postgres pnpm db:migrate
 *   pnpm db:migrate -- --check     (lists pending migrations, changes nothing)
 *
 * Uses a privileged ADMIN connection (direct connection, not the pooler). The running application never holds this credential:
 * it connects as the least-privileged `aaf_app` role (see supabase/roles.example.sql).
 */
import pg from "pg";
import { runMigrations, findMigrationsDir } from "../src/db";
import { readdirSync } from "node:fs";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is not set (name only shown; value never printed).");
  process.exit(2);
}
const check = process.argv.includes("--check");
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true } });
await client.connect();
try {
  const admin = {
    exec: async (sql: string) => void (await client.query(sql)),
    rows: async (sql: string, p?: unknown[]) => (await client.query(sql, p as unknown[])).rows as Record<string, unknown>[],
  };
  if (check) {
    const all = readdirSync(findMigrationsDir()).filter((f) => f.endsWith(".sql")).sort();
    let applied: string[] = [];
    try { applied = (await admin.rows("select name from _migrations")).map((r) => String(r["name"])); } catch { /* no table yet */ }
    const pending = all.filter((f) => !applied.includes(f));
    console.log(pending.length ? `pending: ${pending.join(", ")}` : "up to date");
    process.exit(pending.length ? 1 : 0);
  }
  await client.query("begin");
  try {
    const r = await runMigrations(admin);
    await client.query("commit");
    console.log(r.applied.length ? `applied: ${r.applied.join(", ")}` : "nothing to apply", `(${r.total} migration files)`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
} finally {
  await client.end();
}
