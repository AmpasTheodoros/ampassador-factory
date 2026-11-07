import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Store, openTestHarness, type TestHarness } from "@aaf/database";
import { ingestMessage, approveAndRun, AiSdkProvider, type BrainDeps } from "@aaf/brain";
import { enqueue, getJob, requestCancel, runWorkspace, brainHandlers, makeBuildServices, buildBrainDeps, refreshNetworkRadarConnection, _resetNetworkRadarCache, LocalDispatcher, TriggerDispatcher, TRIGGER_TASK_ID, type BrainServices, type Handlers } from "./index";
import type { NetworkRadarAdapter, Health } from "@aaf/integrations";

const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";
let h: TestHarness;
let WA: string, WB: string;

const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));
const userDeps = (store: Store): BrainDeps => buildBrainDeps(store, { AAF_OWNER_NAME: "Theo" }, undefined).deps;
const svcRun = (ws: string, handlers: Handlers<BrainServices> = brainHandlers, env = {}, extra = {}) =>
  runWorkspace(h.database, ws, handlers, { workerId: "w", backoffBaseMs: 1, buildServices: makeBuildServices(h.database, env), ...extra });
const getJ = (ws: string, id: string) => h.database.run({ kind: "service", workspaceId: ws, reason: "t" }, (q) => getJob(q, ws, id));

const MSG = { fromEmail: "anna@example.org", fromName: "Anna", subject: "Call?", body: "Could we have a call next week about our booking process?" };

beforeEach(async () => {
  h = await openTestHarness();
  WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
  WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
});
afterEach(async () => h.close());

describe("durable W1: ingest -> job -> approval pause -> human decision -> resume", () => {
  it("runs the whole path through user and service roles, never as a privileged role", async () => {
    // 1. user ingests without inline triage and enqueues the durable job
    const { inboxItemId, jobId } = await asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG, { triage: false });
      const j = await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: `triage:${r.inboxItemId}`, createdBy: "user:a" });
      return { inboxItemId: r.inboxItemId!, jobId: j.jobId };
    });
    expect((await asUser(UA, (s) => s.listApprovals(WA)))).toHaveLength(0);

    // 2. service-role worker pinned to workspace A triages and parks on the approval
    const r1 = await svcRun(WA);
    expect(r1).toMatchObject({ ran: 1, waiting: 1 });
    const parked = (await getJ(WA, jobId))!;
    expect(parked.status).toBe("waiting_approval");
    const approvals = await asUser(UA, (s) => s.listApprovals(WA));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: parked.approvalId, status: "awaiting_approval", toolId: "email.export_reply_draft" });
    expect((await asUser(UA, (s) => s.getInboxItem(WA, inboxItemId)))).toMatchObject({ status: "triaged", intent: "meeting_request" });

    // while nothing is decided, running again does nothing
    expect((await svcRun(WA)).ran).toBe(0);

    // 3. the human approves (user role, owner) -> export + follow-up task
    const done = await asUser(UA, (s) => approveAndRun(userDeps(s), WA, parked.approvalId!, { id: UA, role: "owner" }));
    expect(done.ok).toBe(true);

    // 4. the job resumes with the outcome and finishes
    const r2 = await svcRun(WA);
    expect(r2).toMatchObject({ succeeded: 1, swept: { resumed: 1 } });
    expect(await getJ(WA, jobId)).toMatchObject({ status: "succeeded", output: { approvalStatus: "succeeded" } });
    const audit = (await asUser(UA, (s) => s.listAudit(WA))).map((a) => `${a["actor"]}:${a["action"]}`);
    expect(audit).toContain("job:w1.triage:job.waiting_approval");
    expect(audit).toContain("job:w1.triage:job.succeeded");
    expect(await asUser(UA, (s) => s.listTasks(WA, "open"))).toHaveLength(1); // follow-up task from the approval

    // 5. the other tenant saw nothing of this
    expect(await asUser(UB, (s) => s.listApprovals(WA))).toHaveLength(0);
    expect(await asUser(UB, (s) => s.listAudit(WA))).toHaveLength(0);
  });

  it("is idempotent: re-enqueueing and re-running never creates a second approval", async () => {
    const itemId = await asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG, { triage: false });
      await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: `triage:${r.inboxItemId}`, createdBy: "user:a" });
      const again = await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: `triage:${r.inboxItemId}`, createdBy: "user:a" });
      expect(again.created).toBe(false);
      return r.inboxItemId!;
    });
    await svcRun(WA);
    await svcRun(WA);
    expect(await asUser(UA, (s) => s.listApprovals(WA))).toHaveLength(1);
    void itemId;
  });

  it("a missing inbox item fails, retries with backoff, then dead-letters (no silent loss)", async () => {
    const j = await asUser(UA, (s) => enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: "00000000-0000-4000-8000-000000000000" }, idempotencyKey: "bad", maxAttempts: 2, createdBy: "user:a" }));
    await svcRun(WA, brainHandlers, {}, { now: () => new Date(Date.now()) });
    await new Promise((r) => setTimeout(r, 10));
    await svcRun(WA);
    expect(await getJ(WA, j.jobId)).toMatchObject({ status: "dead", attempts: 2, error: expect.stringContaining("not found") });
  });

  it("a queued triage job can be cancelled before it runs", async () => {
    const j = await asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG, { triage: false });
      const e = await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: "c", createdBy: "user:a" });
      await requestCancel(s.db, WA, e.jobId, "user:a");
      return e;
    });
    expect((await svcRun(WA)).ran).toBe(0);
    expect((await getJ(WA, j.jobId))!.status).toBe("cancelled");
    expect(await asUser(UA, (s) => s.listApprovals(WA))).toHaveLength(0);
  });
});

describe("approval.execute handler", () => {
  async function approved() {
    return asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG);
      const id = r.triage!.approvalId!;
      const deps = userDeps(s);
      await deps.gateway.decide(WA, id, "approve", { id: UA, role: "owner" });
      await enqueue(s.db, WA, { type: "approval.execute", input: { approvalId: id }, idempotencyKey: `exec:${id}`, createdBy: "user:a" });
      return id;
    });
  }
  it("executes an approved action in the background with a receipt and audit trail", async () => {
    const id = await approved();
    expect(await svcRun(WA)).toMatchObject({ succeeded: 1 });
    const a = await asUser(UA, (s) => s.getApproval(WA, id));
    expect(a!["status"]).toBe("succeeded");
    expect((await asUser(UA, (s) => s.listReceipts(WA, id)))[0]).toMatchObject({ ok: true, executedBy: expect.stringMatching(/^system:/) });
  });
  it("refuses a rejected approval: job dead-letters, nothing executes", async () => {
    const id = await asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG);
      await userDeps(s).gateway.decide(WA, r.triage!.approvalId!, "reject", { id: UA, role: "owner" });
      await enqueue(s.db, WA, { type: "approval.execute", input: { approvalId: r.triage!.approvalId }, idempotencyKey: "x", createdBy: "user:a" });
      return r.triage!.approvalId!;
    });
    await svcRun(WA);
    expect((await asUser(UA, (s) => s.listReceipts(WA, id)))).toHaveLength(0);
    const jobs = await h.admin.query(`select status from jobs where workspace_id=$1`, [WA]);
    expect(jobs[0]!["status"]).not.toBe("succeeded");
  });
  it("a worker pinned to workspace A cannot execute workspace B's approval", async () => {
    const id = await asUser(UB, async (s) => {
      const r = await ingestMessage(userDeps(s), WB, MSG);
      await userDeps(s).gateway.decide(WB, r.triage!.approvalId!, "approve", { id: UB, role: "owner" });
      return r.triage!.approvalId!;
    });
    await asUser(UA, (s) => enqueue(s.db, WA, { type: "approval.execute", input: { approvalId: id }, idempotencyKey: "cross", maxAttempts: 1, createdBy: "user:a" }));
    await svcRun(WA);
    expect((await asUser(UB, (s) => s.getApproval(WB, id)))!["status"]).toBe("approved"); // untouched
  });
});

describe("model spend inside jobs", () => {
  it("is flushed after the job transaction, even when the job later fails", async () => {
    const usage = { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } };
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ intent: "meeting_request", confidence: 0.9, rationale: "r", injectionSuspected: false }) }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] }) });
    const provider = new AiSdkProvider({ id: "p", location: "cloud", model, modelLabel: "mock", maxRetries: 0, pricing: { eurPerMIn: 1, eurPerMOut: 1, estimated: false } });
    // custom builder: same flush contract as production but with the mock model
    const buildServices = (store: Store, job: { workspaceId: string }) => {
      const { deps, router } = buildBrainDeps(store, {}, undefined);
      const r2 = new (router.constructor as typeof import("@aaf/brain").ModelRouter)(store, [provider], { deferCosts: true });
      return { services: { deps: { ...deps, router: r2 } }, after: async () => { await h.database.run({ kind: "service", workspaceId: job.workspaceId, reason: "flush" }, (q) => r2.flushCosts(new Store(q)).then(() => undefined)); } };
    };
    const failing: Handlers<BrainServices> = { "w1.triage": async (ctx) => { await brainHandlers["w1.triage"]!(ctx); throw new Error("crash after the paid call"); } };
    await asUser(UA, async (s) => {
      const r = await ingestMessage(userDeps(s), WA, MSG, { triage: false });
      await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: "cost", maxAttempts: 1, createdBy: "user:a" });
    });
    await runWorkspace(h.database, WA, failing, { workerId: "w", buildServices });
    const spend = await asUser(UA, (s) => s.monthSpendEur(WA));
    expect(spend).toBeCloseTo((1000 + 100) / 1e6, 8);
    expect(await asUser(UA, (s) => s.listApprovals(WA))).toHaveLength(0); // the work was rolled back, the spend was not
  });
});

describe("dispatchers", () => {
  it("local dispatcher runs due jobs for the given workspace only", async () => {
    await asUser(UA, async (s) => { const r = await ingestMessage(userDeps(s), WA, MSG, { triage: false }); await enqueue(s.db, WA, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: "a", createdBy: "u" }); });
    await asUser(UB, async (s) => { const r = await ingestMessage(userDeps(s), WB, MSG, { triage: false }); await enqueue(s.db, WB, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: "b", createdBy: "u" }); });
    const d = new LocalDispatcher(h.database, brainHandlers, { workerId: "local", buildServices: makeBuildServices(h.database, {}) });
    await d.dispatch({ workspaceId: WA, jobId: "x", correlationId: "c" });
    expect(d.last).toMatchObject({ ran: 1, waiting: 1 });
    expect(await asUser(UB, (s) => s.listApprovals(WB))).toHaveLength(0); // B untouched until its own dispatch
  });
  it("trigger dispatcher sends workspace/correlation context and a stable idempotency key, no secrets", async () => {
    const sent: unknown[] = [];
    const d = new TriggerDispatcher({ trigger: async (id, payload, opts) => { sent.push({ id, payload, opts }); return { id: "run_1" }; } });
    await d.dispatch({ workspaceId: WA, jobId: "job-1", correlationId: "corr-1" });
    await d.dispatch({ workspaceId: WA, jobId: "job-1", correlationId: "corr-1" });
    expect(sent[0]).toEqual({ id: TRIGGER_TASK_ID, payload: { workspaceId: WA, jobId: "job-1", correlationId: "corr-1" }, opts: { idempotencyKey: "job:job-1" } });
    expect((sent[1] as { opts: unknown }).opts).toEqual((sent[0] as { opts: unknown }).opts);
  });
});

describe("NetworkRadar connection status is truthful", () => {
  const fakeNr = (h: Health) => ({ health: async () => h }) as unknown as NetworkRadarAdapter;
  const conn = async () => (await asUser(UA, (s) => s.listConnections(WA))).find((c) => c["connector"] === "networkradar");
  beforeEach(() => _resetNetworkRadarCache());

  it("not configured => not_connected, names the missing variables (never values)", async () => {
    await asUser(UA, (s) => refreshNetworkRadarConnection(s, WA, {}));
    expect(await conn()).toMatchObject({ status: "not_connected", detail: expect.stringContaining("NETWORKRADAR_MCP_URL") });
  });
  it("configured and healthy => connected with only the read scope", async () => {
    await asUser(UA, (s) => refreshNetworkRadarConnection(s, WA, { NETWORKRADAR_MCP_URL: "https://x.example/mcp", NETWORKRADAR_MCP_API_KEY: "k" }, { nr: fakeNr({ status: "connected", tools: [] }) }));
    expect(await conn()).toMatchObject({ status: "connected", scopes: ["networkradar.read"] });
  });
  it("blocked (401) => not_connected with the code and reason", async () => {
    await asUser(UA, (s) => refreshNetworkRadarConnection(s, WA, { NETWORKRADAR_MCP_URL: "https://x.example/mcp", NETWORKRADAR_MCP_API_KEY: "k" }, { nr: fakeNr({ status: "blocked", code: "unauthorized", reason: "rejected (401/403)" }) }));
    expect(await conn()).toMatchObject({ status: "not_connected", detail: expect.stringContaining("unauthorized") });
  });
  it("a connected connector grants the gateway the read scope; a later failure flips it back", async () => {
    const env = { NETWORKRADAR_MCP_URL: "https://x.example/mcp", NETWORKRADAR_MCP_API_KEY: "k" };
    await asUser(UA, (s) => refreshNetworkRadarConnection(s, WA, env, { nr: fakeNr({ status: "connected", tools: [] }), ttlMs: 0 }));
    const scopes = await asUser(UA, (s) => buildBrainDeps(s, env, undefined).deps.gateway.scopesFor(WA));
    expect(scopes.connected.has("networkradar")).toBe(true);
    await asUser(UA, (s) => refreshNetworkRadarConnection(s, WA, env, { nr: fakeNr({ status: "blocked", code: "transport", reason: "down" }), ttlMs: 0 }));
    const after = await asUser(UA, (s) => buildBrainDeps(s, env, undefined).deps.gateway.scopesFor(WA));
    expect(after.connected.has("networkradar")).toBe(false);
  });
});
