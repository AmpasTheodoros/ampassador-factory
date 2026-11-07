import pg from "pg";
import { DomainError } from "@aaf/core";
import type { Db, Queryable, Row } from "./db";

/**
 * Who a transaction acts as. Nothing here is "owner": ordinary requests run as `authenticated` with the
 * server-verified user id, pre-login work runs as `anon`, and internal jobs run as `aaf_service`, which is
 * RLS-scoped to ONE workspace. Elevated access does not exist on this path.
 */
export type Ctx =
  | { kind: "user"; userId: string }
  | { kind: "anon" }
  | { kind: "service"; workspaceId: string; reason: string };

export interface HealthReport {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface Database {
  readonly kind: "pg" | "pglite";
  run<T>(ctx: Ctx, fn: (q: Queryable) => Promise<T>): Promise<T>;
  health(): Promise<HealthReport>;
  /** Throws if the connection role could bypass RLS. Call at startup in production. */
  assertLeastPrivilege(): Promise<void>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function camelRow(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[toCamel(k)] = v instanceof Date ? v.toISOString() : v;
  return o;
}

type RawQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** Statements that pin the transaction to a role and tenant. Every one is SET LOCAL / set_config(..., true). */
export async function applyContext(raw: RawQuery, ctx: Ctx): Promise<void> {
  await raw(`set local statement_timeout = '15s'`);
  if (ctx.kind === "user") {
    if (!UUID.test(ctx.userId)) throw new DomainError("bad_context", "user id must be a UUID");
    await raw(`set local role authenticated`);
    await raw(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [
      JSON.stringify({ sub: ctx.userId, role: "authenticated" }),
      ctx.userId,
    ]);
  } else if (ctx.kind === "anon") {
    await raw(`set local role anon`);
  } else {
    if (!UUID.test(ctx.workspaceId)) throw new DomainError("bad_context", "workspace id must be a UUID");
    await raw(`set local role aaf_service`);
    await raw(`select set_config('aaf.workspace_id', $1, true)`, [ctx.workspaceId]);
  }
}

const wrap = (raw: RawQuery): Queryable => ({
  query: async <T = Row>(sql: string, params: unknown[] = []) => (await raw(sql, params)).rows.map((r) => camelRow(r as Row)) as T[],
});

export interface PgOptions {
  connectionString: string;
  /** Serverless: keep small (Supabase transaction pooler, port 6543). */
  max?: number;
  ssl?: boolean;
}

/** Production path: node-postgres pool, intended for the Supabase pooler. Transaction-scoped settings only, no named prepared statements. */
export class PgDatabase implements Database {
  readonly kind = "pg" as const;
  private pool: pg.Pool;
  constructor(opts: PgOptions) {
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(opts.connectionString);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: (opts.ssl ?? !local) ? { rejectUnauthorized: true } : undefined,
      application_name: "aaf-command-center",
    });
    // An idle-client error must not crash the process.
    this.pool.on("error", () => {});
  }
  async run<T>(ctx: Ctx, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const raw: RawQuery = (sql, params) => c.query(sql, params as unknown[]);
    try {
      await c.query("begin");
      await applyContext(raw, ctx);
      const out = await fn(wrap(raw));
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  async health(): Promise<HealthReport> {
    const t = Date.now();
    try {
      await this.pool.query("select 1");
      return { ok: true, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, detail: (e as Error).message.slice(0, 120) };
    }
  }
  async assertLeastPrivilege(): Promise<void> {
    const r = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; owns: number; u: string }>(
      `select r.rolsuper, r.rolbypassrls, r.rolinherit, current_user as u,
              (select count(*)::int from pg_tables where schemaname = 'public' and tableowner = current_user) as owns
       from pg_roles r where r.rolname = current_user`,
    );
    const row = r.rows[0];
    if (!row) throw new DomainError("privilege_check", "cannot read connection role");
    if (row.rolinherit)
      throw new DomainError("over_privileged", `Database role "${row.u}" inherits the privileges of the roles it can SET. Make it NOINHERIT (and re-grant its memberships) so that a statement without an explicit role switch fails closed.`);
    if (row.rolsuper || row.rolbypassrls || row.owns > 0)
      throw new DomainError("over_privileged", `Database role "${row.u}" is a superuser, can bypass RLS, or owns tables. Connect as a least-privileged login role (aaf_app).`);
  }
  async close() {
    await this.pool.end();
  }
}

/** Local/test path: embedded Postgres. Same SQL, same roles, same RLS; the single connection is privileged, so each run switches role. */
export class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;
  constructor(private db: Db) {}
  async run<T>(ctx: Ctx, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.pg.transaction(async (tx) => {
      const raw: RawQuery = (sql, params) => tx.query(sql, params);
      await applyContext(raw, ctx);
      return fn(wrap(raw));
    });
  }
  async health(): Promise<HealthReport> {
    const t = Date.now();
    try {
      await this.db.pg.query("select 1");
      return { ok: true, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, detail: (e as Error).message.slice(0, 120) };
    }
  }
  async assertLeastPrivilege() {
    /* the embedded connection is privileged by construction; isolation relies on per-transaction SET ROLE */
  }
  async close() {
    await this.db.close();
  }
}
