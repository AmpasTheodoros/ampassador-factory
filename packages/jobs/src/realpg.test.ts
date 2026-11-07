import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Store, openRealPgHarness, type RealPgHarness } from "@aaf/database";
import { ToolGateway, BUILTIN_TOOLS } from "@aaf/tools";
import { autonomousFor } from "./runtime";
import { enqueue, getJob, listJobs, requestCancel, runWorkspace, claimNext, jobEvents, type Handlers } from "./index";

/**
 * Concurrency tests that need a REAL PostgreSQL server with several simultaneous connections.
 * Run: pnpm localpg start && AAF_TEST_BACKEND=realpg pnpm --filter @aaf/jobs test
 * (Real Postgres 17, not Supabase. Re-point AAF_REALPG_ADMIN_URL at a Supabase staging project to repeat them there.)
 */
const on = process.env.AAF_TEST_BACKEND === "realpg";
const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";

describe.skipIf(!on)("durable queue on real PostgreSQL: concurrency", () => {
  let h: RealPgHarness;
  let WA: string, WB: string;
  const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));
  const svc = <T>(ws: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "service", workspaceId: ws, reason: "t" }, (q) => fn(new Store(q)));

  beforeAll(async () => {
    h = await openRealPgHarness({ poolMax: 12 });
    WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
    WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
  });
  afterAll(async () => h.close());
  // claims take the OLDEST due job, so leftovers from a previous test would be picked first: start each test empty
  beforeEach(async () => {
    const drain: Handlers = new Proxy({}, { get: () => async () => ({ kind: "done" as const }) });
    for (const ws of [WA, WB]) await runWorkspace(h.database, ws, drain, { workerId: "drain", maxJobs: 200 });
  });

  const enq = (ws: string, key: string, over: Record<string, unknown> = {}) =>
    asUser(ws === WA ? UA : UB, (s) => enqueue(s.db, ws, { type: "work", idempotencyKey: key, createdBy: "user:t", ...over }));

  it("5 concurrent workers process 40 jobs: every job runs exactly once (skip-locked claims), none lost, none duplicated", async () => {
    for (let i = 0; i < 40; i++) await enq(WA, `many-${i}`, { input: { i } });
    const executed = new Map<number, string[]>();
    const handlers: Handlers = {
      work: async (ctx) => {
        const i = Number(ctx.job.input["i"]);
        executed.set(i, [...(executed.get(i) ?? []), ctx.job.lockedBy ?? "?"]);
        await new Promise((r) => setTimeout(r, 15)); // widen the race window
        return { kind: "done" };
      },
    };
    const sums = await Promise.all(Array.from({ length: 5 }, (_, w) => runWorkspace(h.database, WA, handlers, { workerId: `w${w}`, maxJobs: 40 })));
    expect(sums.reduce((a, s) => a + s.succeeded, 0)).toBe(40);
    expect([...executed.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    for (const [i, who] of executed) expect(who.length, `job ${i} ran ${who.length} times`).toBe(1);
    const jobs = await asUser(UA, (s) => listJobs(s.db, WA, undefined, 100));
    expect(jobs.filter((j) => j.type === "work" && j.status === "succeeded" && j.attempts === 1).length).toBe(40);
    // work was actually shared between workers
    const workers = new Set([...executed.values()].flat());
    expect(workers.size).toBeGreaterThan(1);
  });

  it("20 simultaneous enqueues with the same idempotency key create exactly one job", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => enq(WA, "dup-key", { input: { x: 1 } })));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    const n = (await h.admin.query<{ n: number }>(`select count(*)::int as n from jobs where idempotency_key='dup-key'`))[0]!.n;
    expect(n).toBe(1);
  });

  it("lease contention: while a worker holds a lease nobody else runs the job; after expiry exactly one of many racing workers reclaims it", async () => {
    const { jobId } = await enq(WA, "lease-1", { maxAttempts: 3 });
    let clock = Date.now();
    // worker "crashed" right after claiming
    const claimed = await svc(WA, (s) => claimNext(s.db, WA, "crashed", 30_000, new Date(clock)));
    expect(claimed?.id).toBe(jobId);
    let runs = 0;
    const handlers: Handlers = { work: async () => { runs++; return { kind: "done" }; } };
    const race = () => Promise.all(Array.from({ length: 6 }, (_, w) => runWorkspace(h.database, WA, handlers, { workerId: `r${w}`, now: () => new Date(clock), maxJobs: 5 })));
    await race();
    expect(runs).toBe(0); // lease still valid
    clock += 31_000;
    const after = await race();
    expect(runs).toBe(1); // 6 workers raced; one won
    expect(after.reduce((a, s) => a + s.succeeded, 0)).toBe(1);
    expect((await svc(WA, (s) => getJob(s.db, WA, jobId)))).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("a cancel from ANOTHER connection reaches a job that is already running", async () => {
    const { jobId } = await enq(WA, "cancel-live");
    let sawSecondStep = false;
    const handlers: Handlers = {
      work: async (ctx) => {
        await new Promise((r) => setTimeout(r, 400)); // meanwhile the user cancels, on another pooled connection
        await ctx.checkCancelled();
        sawSecondStep = true;
        return { kind: "done" };
      },
    };
    const running = runWorkspace(h.database, WA, handlers, { workerId: "c", maxJobs: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(await asUser(UA, (s) => requestCancel(s.db, WA, jobId, "user:a"))).toBe(true);
    const sum = await running;
    expect(sawSecondStep).toBe(false);
    expect(sum.cancelled).toBe(1);
    expect((await svc(WA, (s) => getJob(s.db, WA, jobId)))!.status).toBe("cancelled");
    expect((await asUser(UA, (s) => jobEvents(s.db, WA, jobId))).map((e) => e["kind"])).toContain("cancel_requested");
  });

  it("two tenants' workers running at the same time never touch each other's jobs", async () => {
    for (let i = 0; i < 15; i++) { await enq(WA, `iso-a-${i}`, { type: "iso" }); await enq(WB, `iso-b-${i}`, { type: "iso" }); }
    const seen: string[] = [];
    const handlers: Handlers = { iso: async (ctx) => { seen.push(`${ctx.workspaceId}:${ctx.job.workspaceId}`); return { kind: "done" }; } };
    await Promise.all([
      ...Array.from({ length: 3 }, (_, w) => runWorkspace(h.database, WA, handlers, { workerId: `a${w}`, maxJobs: 30 })),
      ...Array.from({ length: 3 }, (_, w) => runWorkspace(h.database, WB, handlers, { workerId: `b${w}`, maxJobs: 30 })),
    ]);
    expect(seen.length).toBe(30);
    expect(seen.every((s) => { const [a, b] = s.split(":"); return a === b; })).toBe(true);
    expect(seen.filter((s) => s.startsWith(WA)).length).toBe(15);
    expect(seen.filter((s) => s.startsWith(WB)).length).toBe(15);
  });

  it("a handler failure retries on one worker while others proceed; the dead-letter is recorded once", async () => {
    const bad = await enq(WA, "poison", { type: "boom", maxAttempts: 2 });
    for (let i = 0; i < 6; i++) await enq(WA, `fine-${i}`, { type: "fine" });
    const handlers: Handlers = { boom: async () => { throw new Error("always"); }, fine: async () => ({ kind: "done" }) };
    await Promise.all(Array.from({ length: 4 }, (_, w) => runWorkspace(h.database, WA, handlers, { workerId: `p${w}`, backoffBaseMs: 1, maxJobs: 20 })));
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(Array.from({ length: 4 }, (_, w) => runWorkspace(h.database, WA, handlers, { workerId: `q${w}`, backoffBaseMs: 1, maxJobs: 20 })));
    const j = (await svc(WA, (s) => getJob(s.db, WA, bad.jobId)))!;
    expect(j).toMatchObject({ status: "dead", attempts: 2 });
    const dead = (await asUser(UA, (s) => jobEvents(s.db, WA, bad.jobId))).filter((e) => e["kind"] === "dead");
    expect(dead).toHaveLength(1);
  });

  it("WRITE-AHEAD: the claim and the unknown outcome of an external send are committed even if the job transaction ROLLS BACK afterwards", async () => {
    let sends = 0;
    const sendTool = { ...BUILTIN_TOOLS.find((t) => t.toolId === "email.export_reply_draft")!, toolId: "test.send_email", async execute() { sends++; throw new Error("socket closed after write"); } };
    const gw = (store: Store) => new ToolGateway(store, [sendTool, ...BUILTIN_TOOLS], { autonomous: autonomousFor({ database: h.database, ledger: h.ledgerDatabase }) });
    const { approvalId } = await asUser(UA, async (s) => {
      const q: any = await gw(s).invoke({ workspaceId: WA, actor: { id: "brain", kind: "agent" }, toolId: "test.send_email", input: { to: "a@x.co", subject: "s", body: "b" } });
      await gw(s).decide(WA, q.approvalId, "approve", { id: UA, role: "owner" });
      return { approvalId: q.approvalId as string };
    });
    // a job whose handler runs the gateway and then crashes: the runner rolls the job transaction back
    const handlers: Handlers = {
      boom: async (ctx) => { await gw(ctx.store).execute(WA, approvalId, { id: "job", kind: "system" }); throw new Error("handler crashed after the send attempt"); },
    };
    await enq(WA, "wa-1", { type: "boom", maxAttempts: 1 });
    const sum = await runWorkspace(h.database, WA, handlers, { workerId: "wa", backoffBaseMs: 1 });
    expect(sum.dead).toBe(1);                                         // the job transaction really did fail and roll back
    expect(sends).toBe(1);
    const a = (await asUser(UA, (s) => s.getApproval(WA, approvalId)))!;
    expect(a["status"]).toBe("unknown_outcome");                      // ...but the record of the attempt survived it
    expect((await asUser(UA, (s) => s.listReceipts(WA, approvalId))).length).toBeGreaterThan(0);
    expect((await asUser(UA, (s) => s.listAudit(WA, "approval", approvalId))).map((x) => x["action"])).toContain("approval.outcome_unknown");
    // and a retry of the whole thing cannot send again
    await expect(gw(await asUser(UA, async (s) => s)).execute(WA, approvalId)).rejects.toThrow();
    expect(sends).toBe(1);
  });
});
