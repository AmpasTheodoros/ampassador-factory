import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, payloadHash } from "@aaf/core";
import { Store } from "./store";
import { openTestHarness, openWireHarness, type TestHarness } from "./testing";
import { Db, PgDatabase, runMigrations } from "./index";

const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";
const UMEMBER = "33333333-0000-4000-8000-00000000000c";
const UVIEWER = "44444444-0000-4000-8000-00000000000d";

const suites: [string, () => Promise<TestHarness>][] = [
  [
    process.env.AAF_TEST_BACKEND === "realpg" ? "REAL PostgreSQL 17 as aaf_app login role" : "in-process (Database.run + SET LOCAL ROLE)",
    openTestHarness,
  ],
  ["wire protocol (node-postgres PgDatabase)", () => openWireHarness(54411)],
];

for (const [label, open] of suites) {
  describe(`production data path: ${label}`, () => {
    let h: TestHarness;
    let WA: string, WB: string;
    let approvalA: string;
    const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));

    beforeAll(async () => {
      h = await open();
      WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
      WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
      await h.admin.query(`insert into memberships values ($1,$2,'member'),($1,$3,'viewer')`, [WA, UMEMBER, UVIEWER]);
      await asUser(UA, async (s) => {
        await s.createTask(WA, { title: "A-secret" });
        approvalA = newId();
        await s.insertApproval({
          id: approvalA,
          workspaceId: WA,
          toolId: "email.export_reply_draft",
          riskTier: "external_communication",
          payload: { to: "a@x.com" },
          payloadHash: payloadHash({ to: "a@x.com" }),
          status: "awaiting_approval",
          summary: "A approval",
          sourceContext: {},
          requestedBy: "agent:test",
          expiresAt: new Date(Date.now() + 1e7).toISOString(),
          idempotencyKey: "k",
        });
        await s.audit(WA, "user:a", "seed", "x", "1");
        await s.upsertConnection(WA, "gmail", "not_connected", "x");
      });
      await asUser(UB, (s) => s.createTask(WB, { title: "B-secret" }));
    });
    afterAll(async () => h.close());

    it("provisioning is per-user and idempotent; anonymous cannot provision", async () => {
      expect(WA).not.toBe(WB);
      expect(await asUser(UA, (s) => s.provisionWorkspace("again"))).toBe(WA);
      await expect(h.database.run({ kind: "anon" }, (q) => new Store(q).provisionWorkspace("x"))).rejects.toThrow();
    });

    it("reads never cross tenants: tasks, approvals, audit, connections, events, workspaces", async () => {
      const seenByB = await asUser(UB, async (s) => ({
        tasks: await s.listTasks(WA),
        approvals: await s.listApprovals(WA),
        audit: await s.listAudit(WA),
        conns: await s.listConnections(WA),
        ws: await s.getWorkspace(WA),
        receipts: await s.listReceipts(WA, approvalA),
      }));
      expect(seenByB.tasks).toHaveLength(0);
      expect(seenByB.approvals).toHaveLength(0);
      expect(seenByB.audit).toHaveLength(0);
      expect(seenByB.conns).toHaveLength(0);
      expect(seenByB.ws).toBeUndefined();
      expect(seenByB.receipts).toHaveLength(0);
      const own = await asUser(UB, (s) => s.listTasks(WB));
      expect(own.map((t) => t["title"])).toEqual(["B-secret"]);
    });

    it("cross-tenant writes are rejected", async () => {
      await expect(asUser(UB, (s) => s.createTask(WA, { title: "evil" }))).rejects.toThrow();
      await expect(asUser(UB, (s) => s.audit(WA, "user:b", "forged", "x"))).rejects.toThrow();
    });

    it("another tenant cannot approve, execute-transition or tamper with an approval", async () => {
      const tryUpd = (u: string, sql: string) => h.database.run({ kind: "user", userId: u }, (q) => q.query(sql, [approvalA]));
      expect(await tryUpd(UB, `update approvals set status='approved' where id=$1 returning id`)).toHaveLength(0);
      expect(await tryUpd(UB, `update approvals set status='executing' where id=$1 returning id`)).toHaveLength(0);
      await expect(tryUpd(UA, `update approvals set payload='{"to":"evil@x.com"}' where id=$1`)).rejects.toThrow(/immutable/);
      const a = await asUser(UA, (s) => s.getApproval(WA, approvalA));
      expect(a!["status"]).toBe("awaiting_approval");
    });

    it("roles: viewer reads but cannot write; member proposes but cannot decide or record receipts; owner can", async () => {
      expect((await asUser(UVIEWER, (s) => s.listTasks(WA))).length).toBe(1);
      await expect(asUser(UVIEWER, (s) => s.createTask(WA, { title: "v" }))).rejects.toThrow();
      await expect(asUser(UVIEWER, (s) => s.audit(WA, "user:v", "x", "y"))).rejects.toThrow();
      const decide = (u: string) =>
        h.database.run({ kind: "user", userId: u }, (q) =>
          q.query(`update approvals set status='approved' where id=$1 returning id`, [approvalA]),
        );
      expect(await decide(UVIEWER)).toHaveLength(0);
      expect(await decide(UMEMBER)).toHaveLength(0);
      await expect(asUser(UMEMBER, (s) => s.insertReceipt(WA, approvalA, 1, true, {}, null, "user:m"))).rejects.toThrow();
      await asUser(UMEMBER, (s) => s.createTask(WA, { title: "member task" }));
      expect(await decide(UA)).toHaveLength(1);
    });

    it("nobody can delete, rewrite audit, or edit memberships/workspace identity via the app role", async () => {
      for (const sql of [
        `delete from tasks`,
        `delete from approvals`,
        `delete from audit_log`,
        `update audit_log set action='x'`,
        `insert into memberships values ('${WA}','${UB}','owner')`,
        `update memberships set role='owner'`,
        `delete from workspaces`,
        `insert into workspaces(id,name) values (gen_random_uuid(),'x')`,
      ]) {
        await expect(
          h.database.run({ kind: "user", userId: UA }, (q) => q.query(sql)),
          sql,
        ).rejects.toThrow();
      }
    });

    it("workspace policy columns are owner-only", async () => {
      await expect(
        asUser(UMEMBER, async (s) =>
          s.db.query(`update workspaces set data_policy='cloud_allowed' where id=$1 returning id`, [WA]).then((r) => {
            if (!r.length) throw new Error("no rows");
          }),
        ),
      ).rejects.toThrow();
      const r = await h.database.run({ kind: "user", userId: UA }, (q) =>
        q.query(`update workspaces set monthly_budget_eur=30 where id=$1 returning id`, [WA]),
      );
      expect(r).toHaveLength(1);
    });

    it("service context is confined to one workspace and cannot delete", async () => {
      const svc = (ws: string, fn: (s: Store) => Promise<unknown>) =>
        h.database.run({ kind: "service", workspaceId: ws, reason: "test" }, (q) => fn(new Store(q)));
      expect(((await svc(WA, (s) => s.listTasks(WA))) as unknown[]).length).toBeGreaterThan(0);
      expect(((await svc(WA, (s) => s.listTasks(WB))) as unknown[]).length).toBe(0);
      await svc(WA, (s) => s.audit(WA, "service:job", "tick", "job"));
      await expect(svc(WA, (s) => s.audit(WB, "service:job", "forged", "job"))).rejects.toThrow();
      await expect(svc(WA, (s) => s.db.query(`delete from tasks`))).rejects.toThrow();
      await expect(svc(WA, (s) => s.db.query(`insert into memberships values ($1,$2,'owner')`, [WA, UB]))).rejects.toThrow();
    });

    it("anonymous sees nothing and can only use the rate limiter", async () => {
      const anon = <T>(fn: (s: Store) => Promise<T>) => h.database.run({ kind: "anon" }, (q) => fn(new Store(q)));
      await expect(anon((s) => s.listTasks(WA))).rejects.toThrow();
      const key = `login:${newId()}`;
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await anon((s) => s.rateHit(key, 3, 60)));
      expect(results).toEqual([true, true, true, false]);
    });

    it("a non-UUID user id is rejected before any SQL is built from it", async () => {
      await expect(h.database.run({ kind: "user", userId: "x'; drop table tasks;--" }, async () => 1)).rejects.toThrow(/UUID/);
      expect((await h.admin.query(`select count(*)::int as n from tasks`))[0]!["n"]).toBeGreaterThan(0);
    });

    it("failed transactions roll back everything", async () => {
      const before = (await h.admin.query(`select count(*)::int as n from tasks where workspace_id=$1`, [WA]))[0]!["n"];
      await expect(
        asUser(UA, async (s) => {
          await s.createTask(WA, { title: "rolled back" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await h.admin.query(`select count(*)::int as n from tasks where workspace_id=$1`, [WA]))[0]!["n"]).toBe(before);
    });

    it("health check reports ok", async () => {
      expect((await h.database.health()).ok).toBe(true);
    });
  });
}

describe("migrations", () => {
  it("are reproducible: re-running applies nothing; a modified applied file is refused", async () => {
    const h = { close: async () => {} };
    const embedded = await Db.open();
    const pgl = embedded.pg;
    const admin = {
      exec: async (s: string) => void (await pgl.exec(s)),
      rows: async (s: string, p?: unknown[]) => (await pgl.query(s, p)).rows as Record<string, unknown>[],
    };
    expect((await runMigrations(admin)).applied).toEqual([]);
    await pgl.query(`update _migrations set checksum='tampered' where name like '0001%'`);
    await expect(runMigrations(admin)).rejects.toThrow(/modified after being applied/);
    await embedded.close();
    void h;
  });
});

describe("startup privilege guard", () => {
  it("refuses to run as a superuser/owner connection (here: the embedded server is one)", async () => {
    const h = await openWireHarness(54412);
    await expect(h.database.assertLeastPrivilege()).rejects.toMatchObject({ code: "over_privileged" });
    await h.close();
  });
  it("PgDatabase is constructible with pooler-friendly defaults", () => {
    const d = new PgDatabase({ connectionString: "postgres://u:p@localhost:6543/postgres" });
    expect(d.kind).toBe("pg");
    void d.close();
  });
});
