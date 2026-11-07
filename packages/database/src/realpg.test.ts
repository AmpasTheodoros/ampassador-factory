import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { newId } from "@aaf/core";
import { Store } from "./store";
import { openAnyRealHarness, type RealPgHarness } from "./live";
import { PgDatabase } from "./driver";

/**
 * REAL PostgreSQL tests (not Supabase). Run with:  pnpm localpg start  &&  AAF_TEST_BACKEND=realpg pnpm test
 * They connect as the actual least-privileged LOGIN role `aaf_app` over TCP with scram-sha-256, which the embedded
 * PGlite server cannot do (its single connection is privileged).
 * The same file is meant to be re-pointed at a Supabase STAGING project via AAF_REALPG_ADMIN_URL (see docs/staging-validation.md).
 */
const on = ["realpg", "staging"].includes(process.env.AAF_TEST_BACKEND ?? "");
const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";

describe.skipIf(!on)("real PostgreSQL: privilege boundaries of the app login role", () => {
  let h: RealPgHarness;
  let WA: string, WB: string;
  const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));
  const raw = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const c = new pg.Client({ connectionString: h.appUrl });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    h = await openAnyRealHarness({ poolMax: 4 });
    WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
    WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
    await asUser(UA, (s) => s.createTask(WA, { title: "A-task" }));
    await asUser(UB, (s) => s.createTask(WB, { title: "B-task" }));
  });
  afterAll(async () => h.close());

  it("the app role is a plain login role: not superuser, not BYPASSRLS, owns nothing; the start-up guard passes", async () => {
    const [r] = await raw<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
      u: string;
    }>(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, current_user as u from pg_roles where rolname = current_user`,
    );
    expect(r).toMatchObject({
      u: "aaf_app",
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
    });
    const owned = await raw<{ n: number }>(
      `select count(*)::int as n from pg_tables where schemaname='public' and tableowner = current_user`,
    );
    expect(owned[0]!.n).toBe(0);
    await expect(h.database.assertLeastPrivilege()).resolves.toBeUndefined();
  });

  it("without a role switch the app role can read nothing (it has no table privileges of its own)", async () => {
    await expect(raw(`select * from workspaces`)).rejects.toThrow(/permission denied/);
    await expect(raw(`select * from audit_log`)).rejects.toThrow(/permission denied/);
    await expect(raw(`insert into tasks(id,workspace_id,title) values (gen_random_uuid(), gen_random_uuid(), 'x')`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("it cannot become an owner/superuser, create objects or roles, or switch RLS off", async () => {
    await expect(raw(`set role postgres`)).rejects.toThrow(/permission denied/);
    await expect(raw(`create table public.evil(x int)`)).rejects.toThrow(/permission denied/);
    await expect(raw(`create role evil superuser`)).rejects.toThrow(/permission denied/);
    await expect(raw(`alter table approvals disable row level security`)).rejects.toThrow(/must be owner/);
    await expect(raw(`alter role aaf_app bypassrls`)).rejects.toThrow(/permission denied|must be superuser/);
    await expect(raw(`create function public.f() returns int language sql as 'select 1'`)).rejects.toThrow(/permission denied/);
    // inside a request transaction too
    await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`set local role postgres`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`alter table audit_log disable trigger all`))).rejects.toThrow(
      /must be owner/,
    );
  });

  it("KNOWN, DOCUMENTED residual: the app role can switch among the three roles it was granted (anon/authenticated/aaf_service) and no others", async () => {
    const members = await raw<{ rolname: string }>(
      `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'aaf_app' order by 1`,
    );
    expect(members.map((m) => m.rolname)).toEqual(["anon", "authenticated", "aaf_service"].sort());
  });

  it("wrong password is refused (scram-sha-256 over TCP)", async () => {
    const bad = new pg.Client({ connectionString: h.appUrl.replace(/:[^:@/]+@/, ":wrong-password@") });
    await expect(bad.connect()).rejects.toThrow(/password authentication failed/);
  });

  it("GRANT MATRIX audit: exact table privileges of anon / authenticated / aaf_service (a snapshot: any migration that widens access fails here)", async () => {
    const tables = (
      await h.admin.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname='public' and tablename not like '\\_%' order by 1`,
      )
    ).map((t) => t.tablename);
    const priv = async (role: string) => {
      const out: Record<string, string> = {};
      for (const t of tables) {
        const ps = [];
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const colLevel = ["SELECT", "INSERT", "UPDATE", "REFERENCES"].includes(p);
          const ok = (
            await h.admin.query<{ ok: boolean }>(
              colLevel ? `select has_any_column_privilege($1, $2, $3) as ok` : `select has_table_privilege($1, $2, $3) as ok`,
              [role, `public.${t}`, p],
            )
          )[0]!.ok;
          if (ok) ps.push(p[0] === "T" && p === "TRUNCATE" ? "TRUNCATE" : p.slice(0, 3));
        }
        if (ps.length) out[t] = ps.join(",");
      }
      return out;
    };
    const anon = await priv("anon");
    const auth = await priv("authenticated");
    const svc = await priv("aaf_service");
    expect(anon).toEqual({}); // anon can touch no application table at all
    for (const [role, m] of [
      ["authenticated", auth],
      ["aaf_service", svc],
    ] as const) {
      for (const [t, p] of Object.entries(m)) {
        expect(p, `${role} on ${t}`).not.toMatch(/DEL|TRUNCATE|REF|TRI/); // nobody can delete, truncate, or attach triggers
      }
    }
    expect(Object.keys(auth).sort()).toEqual(expect.arrayContaining(["approvals", "audit_log", "jobs", "tasks"]));
    expect(auth["audit_log"]).toBe("SEL,INS"); // append-only
    expect(auth["memberships"]).toBe("SEL"); // never writable
    expect(auth["workspaces"]).toBe("SEL,UPD"); // UPDATE only on policy columns (column grants)
    expect(auth["rate_limits"]).toBeUndefined(); // function access only
    expect(svc["memberships"]).toBeUndefined(); // service role cannot touch membership
    expect(svc["workspaces"]).toBe("SEL");
    expect(svc["audit_log"]).toBe("SEL,INS");
    expect(auth["job_events"]).toBe("SEL,INS");
    // only an explicit column grant lets users touch jobs
    const cols = await h.admin.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges where grantee='authenticated' and table_name='jobs' and privilege_type='UPDATE' order by 1`,
    );
    expect(cols.map((c) => (c as unknown as { columnName: string }).columnName)).toEqual(["cancel_requested", "updated_at"]);
  });

  it("every application table has RLS enabled and forced for non-owners", async () => {
    const rows = await h.admin.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname='public' and tablename not like '\\_%'`,
    );
    const without = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(without).toEqual([]);
  });

  it("audit and approval records cannot be altered by ANY role, including the owner", async () => {
    const id = newId();
    await asUser(UA, async (s) => {
      await s.insertApproval({
        id,
        workspaceId: WA,
        toolId: "email.export_reply_draft",
        riskTier: "external_communication",
        payload: { to: "a@x.co" },
        payloadHash: "h",
        status: "awaiting_approval",
        summary: "s",
        sourceContext: {},
        requestedBy: "agent:t",
        expiresAt: new Date(Date.now() + 1e7).toISOString(),
        idempotencyKey: "k",
      });
      await s.audit(WA, "user:a", "t", "x");
    });
    await expect(h.admin.exec(`update approvals set payload='{"to":"evil@x.co"}' where id='${id}'`)).rejects.toThrow(/immutable/);
    await expect(h.admin.exec(`update audit_log set action='x'`)).rejects.toThrow(/append-only/);
    await expect(h.admin.exec(`delete from audit_log`)).rejects.toThrow(/append-only/);
    for (const u of [UA, UB]) {
      await expect(h.database.run({ kind: "user", userId: u }, (q) => q.query(`update audit_log set action='x'`))).rejects.toThrow();
      await expect(h.database.run({ kind: "user", userId: u }, (q) => q.query(`delete from audit_log`))).rejects.toThrow();
    }
    await expect(
      h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) => q.query(`update audit_log set action='x'`)),
    ).rejects.toThrow();
  });
});

describe.skipIf(!on)("real PostgreSQL: request identity under connection pooling", () => {
  let h: RealPgHarness;
  let WA: string, WB: string;
  const asUser = <T>(db: PgDatabase | RealPgHarness["database"], u: string, fn: (s: Store) => Promise<T>) =>
    db.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));

  beforeAll(async () => {
    h = await openAnyRealHarness({ poolMax: 3 });
    WA = await asUser(h.database, UA, (s) => s.provisionWorkspace("A"));
    WB = await asUser(h.database, UB, (s) => s.provisionWorkspace("B"));
    await asUser(h.database, UA, (s) => s.createTask(WA, { title: "A-task" }));
    await asUser(h.database, UB, (s) => s.createTask(WB, { title: "B-task" }));
  });
  afterAll(async () => h.close());

  it("identity and role are transaction-scoped: after commit or rollback the pooled connection is clean", async () => {
    const one = new PgDatabase({ connectionString: h.appUrl, max: 1, ssl: !/127.0.0.1|localhost/.test(h.appUrl) }); // every request reuses THE SAME connection
    try {
      await asUser(one, UA, (s) => s.listTasks(WA));
      // a plain query on the very same connection afterwards: no leaked claims, role is back to the login role
      const leaked = await one.run({ kind: "anon" }, (q) =>
        q.query<{ sub: string | null; claims: string | null; ws: string | null; u: string }>(
          `select nullif(current_setting('request.jwt.claim.sub', true), '') as sub, nullif(current_setting('request.jwt.claims', true), '') as claims, nullif(current_setting('aaf.workspace_id', true), '') as ws, current_user as u`,
        ),
      );
      expect(leaked[0]).toMatchObject({ sub: null, claims: null, ws: null, u: "anon" });
      // failed tx then next request
      await expect(
        asUser(one, UA, async (s) => {
          await s.createTask(WA, { title: "rolled" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(asUser(one, UB, (s) => s.listTasks(WA))).resolves.toHaveLength(0);
      // service context does not leak into the next user request either
      await one.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) => new Store(q).listTasks(WA));
      await expect(asUser(one, UB, (s) => s.listTasks(WA))).resolves.toHaveLength(0);
    } finally {
      await one.close();
    }
  });

  it("120 concurrent requests from two users over a 3-connection pool: every request sees exactly its own tenant", async () => {
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) => {
        const user = i % 2 === 0 ? UA : UB;
        return asUser(h.database, user, async (s) => {
          if (i % 7 === 0) await s.db.query(`select pg_sleep(0.01)`); // interleave
          const tasks = await s.listTasks(i % 2 === 0 ? WA : WB);
          const other = await s.listTasks(i % 2 === 0 ? WB : WA);
          const who = await s.db.query<{ sub: string }>(`select current_setting('request.jwt.claim.sub', true) as sub`);
          return { user, own: tasks.map((t) => t["title"]), other: other.length, sub: who[0]!.sub };
        });
      }),
    );
    for (const r of results) {
      expect(r.sub).toBe(r.user);
      expect(r.other).toBe(0);
      expect(r.own).toEqual([r.user === UA ? "A-task" : "B-task"]);
    }
  });

  it("a service transaction is pinned to ITS workspace even when interleaved with other tenants' service work", async () => {
    const out = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const ws = i % 2 ? WA : WB;
        return h.database.run({ kind: "service", workspaceId: ws, reason: "t" }, async (q) => {
          const s = new Store(q);
          return { ws, mine: (await s.listTasks(ws)).length, theirs: (await s.listTasks(ws === WA ? WB : WA)).length };
        });
      }),
    );
    expect(out.every((r) => r.mine === 1 && r.theirs === 0)).toBe(true);
  });

  it("identity comes only from the server-side context: a client-shaped claims string cannot be injected through the driver", async () => {
    // userId is validated as a UUID before any SQL; claims JSON is built server-side from it
    await expect(h.database.run({ kind: "user", userId: `${UA}","role":"service_role` }, async () => 1)).rejects.toThrow(/UUID/);
    await expect(h.database.run({ kind: "service", workspaceId: `${WA}'; select 1;--`, reason: "t" }, async () => 1)).rejects.toThrow(
      /UUID/,
    );
    // and a request cannot override the claim for the remainder of its own transaction via ordinary parameterised SQL
    const sub = await h.database.run(
      { kind: "user", userId: UA },
      async (q) => (await q.query<{ s: string }>(`select current_setting('request.jwt.claim.sub', true) as s`))[0]!.s,
    );
    expect(sub).toBe(UA);
  });
});
