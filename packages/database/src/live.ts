import pg from "pg";
import { randomBytes } from "node:crypto";
import { LOCAL_BOOTSTRAP, LOCAL_GRANTS, runMigrations, type Queryable, type Row } from "./db";
import { PgDatabase, camelRow, type Database } from "./driver";

/** Privileged handle for fixtures and negative tests. Never given to request-handling code. */
export interface AdminHandle extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface RealPgHarness {
  admin: AdminHandle;
  database: Database;
  /** A separate small pool used ONLY for short autonomous ledger transactions (see AutonomousBudgetLedger). */
  ledgerDatabase: Database;
  /** Connection string of the least-privileged application role. */
  appUrl: string;
  dbName: string;
  close(): Promise<void>;
}

export const DEFAULT_REALPG_ADMIN_URL = "postgres://postgres:local-admin-only@127.0.0.1:54330/postgres";
const APP_ROLE_PASSWORD = "aaf-app-local-throwaway";

function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

class PgAdmin implements AdminHandle {
  constructor(private client: pg.Client) {}
  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query(sql, params)).rows.map((r) => camelRow(r as Row)) as T[];
  }
  async exec(sql: string) {
    await this.client.query(sql);
  }
}

/**
 * Provisions a FRESH database on a real PostgreSQL server exactly the way production is provisioned:
 *   1. admin connection: Supabase-provided pieces (only when absent), migrations through the real runner
 *   2. admin connection: the least-privileged login role `aaf_app` and its role memberships
 *   3. the application connects ONLY as aaf_app
 * The server is whatever AAF_REALPG_ADMIN_URL points at (default: the local server started by `pnpm localpg start`).
 * This is a real PostgreSQL, but it is NOT Supabase (no PostgREST, no GoTrue, no Supavisor pooler).
 */
/**
 * Mirrors supabase/roles.example.sql. aaf_app must hold NO privileges until it explicitly SETs a role (fail closed).
 * On PG16+ inheritance is fixed per membership GRANT, so memberships are re-granted after the role is NOINHERIT,
 * and only when they are not already correct (idempotent; roles are cluster-wide).
 */
const ROLE_SETUP_SQL = `
do $$ begin
  if not exists (select from pg_roles where rolname = 'aaf_app') then
    create role aaf_app login password '__PW__' nosuperuser nobypassrls nocreatedb nocreaterole noinherit;
  end if;
end $$;
alter role aaf_app noinherit;
do $$ declare bad boolean; begin
  select exists (select 1 from (values ('anon'),('authenticated'),('aaf_service')) r(n) where not exists (
    select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
    where u.rolname = 'aaf_app' and g.rolname = r.n and not m.inherit_option)) into bad;
  if bad then
    revoke anon, authenticated, aaf_service from aaf_app;
    grant anon, authenticated, aaf_service to aaf_app;
  end if;
end $$;
`;

export async function openRealPgHarness(opts: { poolMax?: number; adminUrl?: string } = {}): Promise<RealPgHarness> {
  const adminUrl = opts.adminUrl ?? process.env.AAF_REALPG_ADMIN_URL ?? DEFAULT_REALPG_ADMIN_URL;
  const server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  const dbName = `aaf_t_${randomBytes(5).toString("hex")}`;
  let adminDb: pg.Client | undefined;
  // Role DDL is cluster-wide: serialise provisioning across concurrent test files (and CI jobs).
  // The lock is ALWAYS released (finally), and bounded by lock_timeout so a stuck run cannot hang the others.
  await server.query(`set lock_timeout = '60s'`);
  await server.query(`select pg_advisory_lock(727001)`);
  try {
    await server.query(`create database ${dbName}`);
    adminDb = new pg.Client({ connectionString: withDb(adminUrl, dbName) });
    await adminDb.connect();
    await adminDb.query(LOCAL_BOOTSTRAP);
    await runMigrations({ exec: async (s) => void (await adminDb!.query(s)), rows: async (s, p) => (await adminDb!.query(s, p as unknown[])).rows });
    await adminDb.query(LOCAL_GRANTS);
    await adminDb.query(ROLE_SETUP_SQL.replace("__PW__", APP_ROLE_PASSWORD));
  } catch (e) {
    await adminDb?.end().catch(() => {});
    await server.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
    await server.end().catch(() => {});
    throw e;
  } finally {
    await server.query(`select pg_advisory_unlock_all()`).catch(() => {});
  }
  const admin = new PgAdmin(adminDb);
  const appUrl = withDb(adminUrl, dbName, "aaf_app", APP_ROLE_PASSWORD);
  const database = new PgDatabase({ connectionString: appUrl, max: opts.poolMax ?? 8, ssl: false });
  const ledgerDatabase = new PgDatabase({ connectionString: appUrl, max: 4, ssl: false });
  return {
    admin, database, ledgerDatabase, appUrl, dbName,
    close: async () => {
      await database.close();
      await ledgerDatabase.close();
      await adminDb!.end();
      await server.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      await server.end();
    },
  };
}
