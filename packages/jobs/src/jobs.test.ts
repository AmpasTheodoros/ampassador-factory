import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { newId, payloadHash, DomainError } from "@aaf/core";
import { Store, openTestHarness, type TestHarness } from "@aaf/database";
import { enqueue, getJob, listJobs, jobEvents, requestCancel, replay, counts, runWorkspace, type Handlers, type Outcome } from "./index";

const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";
const UV = "33333333-0000-4000-8000-00000000000c";

let h: TestHarness;
let WA: string, WB: string;
let clock: number;
const now = () => new Date(clock);
const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));
const enq = (ws: string, key: string, over: Record<string, unknown> = {}) =>
  asUser(ws === WA ? UA : UB, (s) => enqueue(s.db, ws, { type: "test", idempotencyKey: key, createdBy: "user:test", runAt: now(), ...over }));
const run = (ws: string, handlers: Handlers, extra: object = {}) => runWorkspace(h.database, ws, handlers, { workerId: "w1", now, backoffBaseMs: 1000, ...extra });
const job = (ws: string, id: string) => h.database.run({ kind: "service", workspaceId: ws, reason: "t" }, (q) => getJob(q, ws, id));
const done: Handlers = { test: async () => ({ kind: "done", output: { ok: 1 } }) };

beforeEach(async () => {
  h = await openTestHarness();
  clock = Date.parse("2026-11-07T10:00:00Z");
  WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
  WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
  await h.admin.query(`insert into memberships values ($1,$2,'viewer')`, [WA, UV]);
});
afterEach(async () => h.close());

describe("enqueue and run", () => {
  it("idempotent enqueue: same key => one job, even from a retried caller", async () => {
    const a = await enq(WA, "k1");
    const b = await enq(WA, "k1");
    expect(a.created).toBe(true);
    expect(b).toEqual({ jobId: a.jobId, created: false });
    expect((await asUser(UA, (s) => listJobs(s.db, WA))).length).toBe(1);
  });

  it("runs a queued job to success with progress, output, events and an audit record", async () => {
    const { jobId } = await enq(WA, "k", { correlationId: "corr-1", input: { x: 1 } });
    const seen: string[] = [];
    const r = await run(WA, { test: async (ctx) => { seen.push(ctx.correlationId, String((ctx.job.input as { x: number }).x), ctx.workspaceId); await ctx.progress(50, "half"); return { kind: "done", output: { ok: true } }; } });
    expect(r).toMatchObject({ ran: 1, succeeded: 1 });
    expect(seen).toEqual(["corr-1", "1", WA]); // correlation id + workspace context reach the handler
    const j = (await job(WA, jobId))!;
    expect(j).toMatchObject({ status: "succeeded", progress: 100, attempts: 1, output: { ok: true } });
    expect((await asUser(UA, (s) => jobEvents(s.db, WA, jobId))).map((e) => e["kind"])).toEqual(["enqueued", "started", "succeeded"]);
    expect((await asUser(UA, (s) => s.listAudit(WA, "job", jobId))).map((a) => a["action"])).toContain("job.succeeded");
  });

  it("a second run does not execute a finished job again; future run_at is respected", async () => {
    await enq(WA, "k");
    await run(WA, done);
    expect((await run(WA, done)).ran).toBe(0);
    await enq(WA, "later", { runAt: new Date(clock + 60_000) });
    expect((await run(WA, done)).ran).toBe(0);
    clock += 61_000;
    expect((await run(WA, done)).ran).toBe(1);
  });
});

describe("retries, dead-letter, replay", () => {
  it("retries with exponential backoff, then succeeds; a handler failure rolls back its own writes", async () => {
    const { jobId } = await enq(WA, "k");
    let n = 0;
    const handlers: Handlers = { test: async (ctx) => { await ctx.store.createTask(WA, { title: `attempt ${++n}` }); if (n < 3) throw new Error("flaky"); return { kind: "done" }; } };
    expect(await run(WA, handlers)).toMatchObject({ ran: 1, retried: 1 });
    let j = (await job(WA, jobId))!;
    expect(j).toMatchObject({ status: "queued", attempts: 1, error: "flaky" });
    expect(new Date(j.runAt).getTime() - clock).toBe(1000); // base * 2^0
    expect((await run(WA, handlers)).ran).toBe(0); // not due yet
    clock += 1000;
    await run(WA, handlers);
    j = (await job(WA, jobId))!;
    expect(new Date(j.runAt).getTime() - clock).toBe(2000); // base * 2^1
    clock += 2000;
    expect(await run(WA, handlers)).toMatchObject({ succeeded: 1 });
    // only the successful attempt's task survives; the two failed attempts were rolled back
    expect((await asUser(UA, (s) => s.listTasks(WA))).map((t) => t["title"])).toEqual(["attempt 3"]);
  });

  it("exhausted attempts => dead (dead letter); operator replay runs it again with fresh attempts", async () => {
    const { jobId } = await enq(WA, "k", { maxAttempts: 2 });
    const bad: Handlers = { test: async () => { throw new Error("always"); } };
    await run(WA, bad); clock += 1000; await run(WA, bad);
    expect((await job(WA, jobId))).toMatchObject({ status: "dead", attempts: 2, error: "always" });
    expect((await counts(h.admin, WA)).dead).toBe(1);
    expect(await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) => replay(q, WA, jobId, "user:op", now()))).toBe(true);
    expect((await job(WA, jobId))).toMatchObject({ status: "queued", attempts: 0, error: null });
    expect(await run(WA, done)).toMatchObject({ succeeded: 1 });
    expect((await asUser(UA, (s) => jobEvents(s.db, WA, jobId))).map((e) => e["kind"])).toContain("replayed");
  });

  it("permanent errors are dead immediately (no pointless retries); unknown job types too", async () => {
    const a = await enq(WA, "a");
    await run(WA, { test: async () => { throw new DomainError("permanent_bad_input", "bad"); } });
    expect((await job(WA, a.jobId))).toMatchObject({ status: "dead", attempts: 1 });
    const b = await enq(WA, "b", { type: "nope" });
    await run(WA, done);
    expect((await job(WA, b.jobId))).toMatchObject({ status: "dead", error: expect.stringContaining("No handler") });
  });

  it("crash recovery: a job whose worker died is reclaimed after the lease; but not forever", async () => {
    const { jobId } = await enq(WA, "k", { maxAttempts: 2 });
    // simulate a crashed worker: claimed (tx 1) and then nothing
    await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, async (q) => { const { claimNext } = await import("./queue"); await claimNext(q, WA, "crashed", 30_000, now()); });
    expect((await job(WA, jobId))).toMatchObject({ status: "running", attempts: 1, lockedBy: "crashed" });
    expect((await run(WA, done)).ran).toBe(0); // lease still valid
    clock += 31_000;
    expect(await run(WA, done)).toMatchObject({ ran: 1, succeeded: 1 });
    expect((await job(WA, jobId))!.attempts).toBe(2);

    const p = await enq(WA, "poison", { maxAttempts: 1 });
    await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, async (q) => { const { claimNext } = await import("./queue"); await claimNext(q, WA, "crashed", 1000, now()); });
    clock += 5000;
    expect((await run(WA, done)).swept.dead).toBe(1); // out of attempts: dead-lettered, not looped
    expect((await job(WA, p.jobId))!.status).toBe("dead");
  });
});

describe("cancellation", () => {
  it("cancelling a queued job stops it before it runs", async () => {
    const { jobId } = await enq(WA, "k");
    expect(await asUser(UA, (s) => requestCancel(s.db, WA, jobId, "user:a"))).toBe(true);
    expect((await run(WA, { test: async () => { throw new Error("must not run"); } })).ran).toBe(0);
    expect((await job(WA, jobId))!.status).toBe("cancelled");
  });
  it("a running job stops at its next cooperative check and is marked cancelled (not retried)", async () => {
    const { jobId } = await enq(WA, "k");
    let steps = 0;
    const r = await run(WA, { test: async (ctx) => {
      steps++;
      await ctx.store.db.query(`update jobs set cancel_requested=true where id=$1`, [jobId]); // what a user cancel does, visible to the running tx
      await ctx.checkCancelled(); steps++;
      return { kind: "done" };
    } });
    expect(steps).toBe(1);
    expect(r.cancelled).toBe(1);
    expect((await job(WA, jobId))!.status).toBe("cancelled");
  });
});

describe("approval pause / resume", () => {
  it("parks on an approval, stays parked while it is pending, resumes with the outcome when decided", async () => {
    const approvalId = newId();
    await asUser(UA, (s) => s.insertApproval({ id: approvalId, workspaceId: WA, toolId: "email.export_reply_draft", riskTier: "external_communication", payload: { to: "a@x.co" }, payloadHash: payloadHash({ to: "a@x.co" }), status: "awaiting_approval", summary: "s", sourceContext: {}, requestedBy: "agent:t", expiresAt: new Date(clock + 1e9).toISOString(), idempotencyKey: "ik" }));
    const { jobId } = await enq(WA, "k");
    const seen: (string | undefined)[] = [];
    const handlers: Handlers = { test: async (ctx): Promise<Outcome> => { seen.push(ctx.resume?.approvalStatus); return ctx.resume ? { kind: "done", output: { approval: ctx.resume.approvalStatus } } : { kind: "wait_approval", approvalId }; } };
    expect(await run(WA, handlers)).toMatchObject({ waiting: 1 });
    expect((await job(WA, jobId))).toMatchObject({ status: "waiting_approval", approvalId });
    expect((await run(WA, handlers)).ran).toBe(0); // still pending: nothing happens
    await asUser(UA, (s) => s.transitionApproval(WA, approvalId, "awaiting_approval", "rejected", { decidedBy: UA }));
    expect(await run(WA, handlers)).toMatchObject({ succeeded: 1, swept: { resumed: 1 } });
    expect(seen).toEqual([undefined, "rejected"]);
    expect((await job(WA, jobId))).toMatchObject({ status: "succeeded", output: { approval: "rejected" } });
  });
});

describe("tenant isolation of the job system", () => {
  it("a workspace runner never claims another tenant's jobs", async () => {
    const b = await enq(WB, "kb");
    const ranA = await run(WA, done);
    expect(ranA.ran).toBe(0);
    expect((await job(WB, b.jobId))!.status).toBe("queued");
    expect(await run(WB, done)).toMatchObject({ succeeded: 1 });
  });
  it("users cannot see, cancel, enqueue into, or tamper with another tenant's jobs; viewers cannot enqueue", async () => {
    const a = await enq(WA, "ka");
    expect(await asUser(UB, (s) => listJobs(s.db, WA))).toHaveLength(0);
    expect(await asUser(UB, (s) => requestCancel(s.db, WA, a.jobId, "user:b"))).toBe(false);
    await expect(asUser(UB, (s) => enqueue(s.db, WA, { type: "x", idempotencyKey: "evil", createdBy: "user:b" }))).rejects.toThrow();
    await expect(asUser(UV, (s) => enqueue(s.db, WA, { type: "x", idempotencyKey: "v", createdBy: "user:v" }))).rejects.toThrow();
    // a user can only flip the cancel flag, never status/attempts/output
    for (const col of ["status='succeeded'", "attempts=0", "output='{}'", "max_attempts=99", "run_at=now()"])
      await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`update jobs set ${col} where id=$1`, [a.jobId])), col).rejects.toThrow();
    await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`delete from jobs`))).rejects.toThrow();
    await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`update job_events set kind='x'`))).rejects.toThrow();
  });
  it("the service role pinned to A cannot write jobs into B", async () => {
    await expect(h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) => enqueue(q, WB, { type: "x", idempotencyKey: "z", createdBy: "svc" }))).rejects.toThrow();
  });
});

describe("scheduling", () => {
  it("reports when the workspace next needs a wake-up (retry backoff), null when idle", async () => {
    await enq(WA, "k");
    const r = await run(WA, { test: async () => { throw new Error("flaky"); } });
    expect(r.retried).toBe(1);
    expect(r.nextDueAt).toBe(new Date(clock + 1000).toISOString());
    clock += 1000;
    expect((await run(WA, done)).nextDueAt).toBeNull();
  });
});
