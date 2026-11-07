import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/** Local stand-in for what Supabase already provides (auth schema + authenticated role). Never run on Supabase. */
const LOCAL_BOOTSTRAP = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
`;
const LOCAL_GRANTS = `
grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;
grant select, insert, update on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
`;

export function findMigrationsDir(): string {
  if (process.env.AAF_MIGRATIONS_DIR) return process.env.AAF_MIGRATIONS_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "supabase", "migrations");
    if (existsSync(cand)) return cand;
    const up = dirname(dir);
    if (up === dir) break;
    dir = resolve(up);
  }
  throw new Error("supabase/migrations not found (set AAF_MIGRATIONS_DIR)");
}

export type Row = Record<string, unknown>;

const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function camelRow(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[toCamel(k)] = v instanceof Date ? v.toISOString() : v;
  return o;
}

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

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
    return res.rows.map((r) => camelRow(r as Row)) as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async migrate(): Promise<string[]> {
    await this.pg.exec(LOCAL_BOOTSTRAP);
    await this.pg.exec(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`);
    const dir = findMigrationsDir();
    const applied = new Set((await this.pg.query<{ name: string }>(`select name from _migrations`)).rows.map((r) => r.name));
    const ran: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(f)) continue;
      await this.pg.exec(readFileSync(join(dir, f), "utf8"));
      await this.pg.query(`insert into _migrations(name) values ($1)`, [f]);
      ran.push(f);
    }
    await this.pg.exec(LOCAL_GRANTS);
    return ran;
  }

  /** Run as an authenticated end-user so RLS applies (used by RLS tests). */
  async asUser<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      await tx.query(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return fn({
        query: async <R = Row>(sql: string, params: unknown[] = []) =>
          (await tx.query(sql, params)).rows.map((r) => camelRow(r as Row)) as R[],
      });
    });
  }

  async close() {
    await this.pg.close();
  }
}
