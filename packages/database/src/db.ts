import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

/** Local stand-in for what Supabase already provides (auth schema, auth.uid(), anon/authenticated). Never run on Supabase. */
export const LOCAL_BOOTSTRAP = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;
`;
export const LOCAL_GRANTS = `
grant usage on schema auth to anon, authenticated;
do $$ begin if exists (select from pg_roles where rolname = 'aaf_service') then grant usage on schema auth to aaf_service; end if; end $$;
`;

export function findMigrationsDir(): string {
  if (process.env.AAF_MIGRATIONS_DIR) return process.env.AAF_MIGRATIONS_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = join(/*turbopackIgnore: true*/ dir, "supabase", "migrations");
    if (existsSync(cand)) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = resolve(up);
  }
  throw new Error("supabase/migrations not found (set AAF_MIGRATIONS_DIR)");
}

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Minimal surface the migration runner needs. Both PGlite and a pg client satisfy it via small adapters. */
export interface SqlAdmin {
  exec(sql: string): Promise<void>;
  rows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Versioned, reproducible migrations: applied in filename order, each recorded with a checksum.
 * A previously applied file whose content changed is an error (never silently re-run or skipped).
 * Runs on an ADMIN connection only; the running app never holds this privilege.
 */
export async function runMigrations(admin: SqlAdmin, dir = findMigrationsDir()): Promise<{ applied: string[]; total: number }> {
  await admin.exec(`create table if not exists _migrations (name text primary key, checksum text, applied_at timestamptz default now())`);
  await admin.exec(`alter table _migrations add column if not exists checksum text`);
  const done = new Map((await admin.rows(`select name, checksum from _migrations`)).map((r) => [String(r["name"]), r["checksum"] as string | null]));
  const files = readdirSync(/*turbopackIgnore: true*/ dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(/*turbopackIgnore: true*/ dir, f), "utf8");
    const sum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
    if (done.has(f)) {
      const prev = done.get(f);
      if (prev && prev !== sum) throw new Error(`Migration ${f} was modified after being applied (checksum mismatch). Add a new migration instead.`);
      if (!prev) await admin.rows(`update _migrations set checksum=$2 where name=$1`, [f, sum]);
      continue;
    }
    await admin.exec(sql);
    await admin.rows(`insert into _migrations(name, checksum) values ($1, $2)`, [f, sum]);
    applied.push(f);
  }
  return { applied, total: files.length };
}

/** Owner/admin handle on an embedded Postgres. Used for migrations, tests and fixtures, never for request handling. */
export class Db implements Queryable {
  private constructor(public readonly pg: PGlite) {}

  /** dataDir undefined => in-memory (tests). */
  static async open(opts: { dataDir?: string; migrate?: boolean } = {}): Promise<Db> {
    const pg = new PGlite(opts.dataDir);
    await pg.waitReady;
    const db = new Db(pg);
    if (opts.migrate !== false) await db.migrate();
    return db;
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query(sql, params);
    return res.rows.map((r) => camel(r as Row)) as T[];
  }
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async migrate(): Promise<string[]> {
    await this.pg.exec(LOCAL_BOOTSTRAP);
    const r = await runMigrations({
      exec: async (sql) => void (await this.pg.exec(sql)),
      rows: async (sql, p) => (await this.pg.query(sql, p)).rows as Record<string, unknown>[],
    });
    await this.pg.exec(LOCAL_GRANTS);
    return r.applied;
  }

  /** Run as an authenticated end-user so RLS applies. Kept for focused RLS tests; app code uses Database.run. */
  async asUser<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      await tx.query(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return fn({
        query: async <R = Row>(sql: string, params: unknown[] = []) => (await tx.query(sql, params)).rows.map((r) => camel(r as Row)) as R[],
      });
    });
  }

  async close() {
    await this.pg.close();
  }
}

const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function camel(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[toCamel(k)] = v instanceof Date ? v.toISOString() : v;
  return o;
}
