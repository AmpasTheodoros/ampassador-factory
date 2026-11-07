import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { Db, Store } from "@aaf/database";
import { DomainError } from "@aaf/core";
import { ToolGateway, BUILTIN_TOOLS, safeToRetry, type ToolDef } from "./index";

const WS = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = { id: "u1", role: "owner" };
const VIEWER = { id: "u2", role: "viewer" };
const agent = { id: "brain", kind: "agent" as const };

let db: Db, store: Store;
let sent: string[];
let failuresLeft: number;

const mk = (over: Partial<ToolDef> = {}): ToolDef => ({
  toolId: "test.send", description: "spy", connector: "internal", requiredScopes: ["exports:write"],
  riskTier: "external_communication", idempotency: "key_required", rateLimitPerMin: 100, approvalPolicy: "always",
  inputSchema: z.object({ to: z.string(), n: z.number().default(1) }), outputSchema: z.object({ ok: z.literal(true) }),
  timeoutMs: 200, retry: { max: 3, backoffMs: 1 }, auditFields: ["to"], summarize: (i: any) => `send ${i.to}`,
  async execute(ctx, i: any) {
    if (failuresLeft > 0) { failuresLeft--; throw safeToRetry("connection refused before sending"); }
    sent.push(`${i.to}:${ctx.idempotencyKey}`);
    return { ok: true as const };
  },
  ...over,
});
const gw = (tools: ToolDef[], o = {}) => new ToolGateway(store, tools, { sleep: async () => {}, ...o });

beforeEach(async () => {
  db = await Db.open();
  store = new Store(db);
  await store.ensureWorkspace(WS, "A", "00000000-0000-4000-8000-0000000000aa");
  sent = []; failuresLeft = 0;
});

describe("external communication cannot run before approval", () => {
  it("invoke only queues; nothing is sent until decided + executed", async () => {
    const g = gw([mk()]);
    const r = await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } });
    expect(r.status).toBe("queued_for_approval");
    expect(sent).toEqual([]);
    const id = (r as any).approvalId;
    await expect(g.execute(WS, id)).rejects.toThrow(/Cannot execute/);
    expect(sent).toEqual([]);
    await g.decide(WS, id, "approve", OWNER);
    const ex = await g.execute(WS, id);
    expect(ex.ok).toBe(true);
    expect(sent).toEqual([`a@x.com:${id}`]);
    expect((await store.getApproval(WS, id))!["status"]).toBe("succeeded");
  });
  it("risk tier is authoritative: a mis-declared approvalPolicy 'never' cannot bypass approval", async () => {
    for (const tier of ["external_communication", "financial_or_irreversible"] as const) {
      sent = [];
      const g = gw([mk({ riskTier: tier, approvalPolicy: "never" })]);
      const r = await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: tier } });
      expect(r.status).toBe("queued_for_approval");
      expect(sent).toEqual([]);
    }
  });
  it("rejected approval can never execute", async () => {
    const g = gw([mk()]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "reject", OWNER);
    await expect(g.execute(WS, id)).rejects.toThrow();
    expect(sent).toEqual([]);
  });
  it("viewer and agent cannot approve", async () => {
    const g = gw([mk()]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await expect(g.decide(WS, id, "approve", VIEWER)).rejects.toThrow(/Only owner\/admin/);
    await expect(g.decide(WS, id, "approve", { id: "brain", role: "agent" })).rejects.toThrow();
  });
  it("same idempotency key -> one approval; double execute sends once", async () => {
    const g = gw([mk()]);
    const a = (await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" }, idempotencyKey: "k" })) as any;
    const b = (await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" }, idempotencyKey: "k" })) as any;
    expect(b.approvalId).toBe(a.approvalId);
    expect(b.created).toBe(false);
    await g.decide(WS, a.approvalId, "approve", OWNER);
    await Promise.allSettled([g.execute(WS, a.approvalId), g.execute(WS, a.approvalId)]);
    expect(sent.length).toBe(1);
  });
});

describe("payload cannot change after approval", () => {
  it("database trigger blocks payload edits", async () => {
    const g = gw([mk()]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    await expect(db.query(`update approvals set payload='{"to":"evil@x.com","n":1}' where id=$1`, [id])).rejects.toThrow(/immutable/);
  });
  it("execution re-hashes payload even if the DB guard were bypassed", async () => {
    const g = gw([mk()]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    await db.exec(`drop trigger approvals_payload_lock on approvals`);
    await db.query(`update approvals set payload='{"to":"evil@x.com","n":1}' where id=$1`, [id]);
    const r = await g.execute(WS, id);
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
    expect((await store.listAudit(WS, "approval", id)).some((a) => a["action"] === "approval.tamper_detected")).toBe(true);
  });
});

describe("authorization and availability", () => {
  it("unconnected connector => honest denial, tool never runs", async () => {
    const g = gw(BUILTIN_TOOLS);
    const r = await g.invoke({ workspaceId: WS, actor: agent, toolId: "gmail.send", input: { to: "a@x.com", subject: "s", body: "b" } });
    expect(r).toMatchObject({ status: "denied", code: "needs_connection" });
    expect(await store.listApprovals(WS)).toHaveLength(0);
  });
  it("connected but missing scope => denied", async () => {
    await store.upsertConnection(WS, "gmail", "connected", "x", ["gmail.readonly"]);
    const g = gw(BUILTIN_TOOLS);
    const r = await g.invoke({ workspaceId: WS, actor: agent, toolId: "gmail.send", input: { to: "a@x.com", subject: "s", body: "b" } });
    expect(r).toMatchObject({ status: "denied", code: "missing_scope" });
  });
  it("scope revoked between approval and execution fails closed", async () => {
    await store.upsertConnection(WS, "gmail", "connected", "x", ["gmail.send"]);
    const g = gw(BUILTIN_TOOLS);
    const q: any = await g.invoke({ workspaceId: WS, actor: agent, toolId: "gmail.send", input: { to: "a@x.com", subject: "s", body: "b" } });
    expect(q.status).toBe("queued_for_approval");
    await g.decide(WS, q.approvalId, "approve", OWNER);
    await store.upsertConnection(WS, "gmail", "not_connected", "revoked", []);
    const r = await g.execute(WS, q.approvalId);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/revalidation/);
  });
  it("invalid input is denied before anything is queued", async () => {
    const g = gw([mk()]);
    const r = await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { nope: 1 } });
    expect(r).toMatchObject({ status: "denied", code: "invalid_input" });
  });
  it("rate limit", async () => {
    const g = gw([mk({ rateLimitPerMin: 2, riskTier: "read", approvalPolicy: "never" })]);
    const call = () => g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a" } });
    expect((await call()).status).toBe("executed");
    expect((await call()).status).toBe("executed");
    expect(await call()).toMatchObject({ status: "denied", code: "rate_limited" });
  });
  it("financial tier needs second confirmation", async () => {
    const g = gw([mk({ riskTier: "financial_or_irreversible" })]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "pay" } })) as any).approvalId;
    await expect(g.decide(WS, id, "approve", OWNER)).rejects.toThrow(/Second confirmation/);
    const hash = (await store.getApproval(WS, id))!["payloadHash"] as string;
    await g.decide(WS, id, "approve", OWNER, { confirmHash: hash });
  });
});

describe("reliability", () => {
  it("retries with backoff then succeeds; receipts record each attempt", async () => {
    const delays: number[] = [];
    const g = gw([mk()], { sleep: async (ms: number) => { delays.push(ms); } });
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    failuresLeft = 2;
    const r = await g.execute(WS, id);
    expect(r.ok).toBe(true);
    expect(delays).toEqual([1, 2]);
    const rc = await store.listReceipts(WS, id);
    expect(rc.map((x) => x["ok"])).toEqual([false, false, true]);
  });
  it("exhausted retries -> failed (dead letter) -> operator replay succeeds without double send", async () => {
    const g = gw([mk()]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    failuresLeft = 99;
    expect((await g.execute(WS, id)).ok).toBe(false);
    expect((await store.getApproval(WS, id))!["status"]).toBe("failed");
    expect(sent).toEqual([]);
    failuresLeft = 0;
    await expect(g.replay(WS, id, VIEWER)).rejects.toThrow();
    expect((await g.replay(WS, id, OWNER)).ok).toBe(true);
    expect(sent).toEqual([`a@x.com:${id}`]);
  });
  it("a timeout on a tool that SENDS is an unknown outcome: recorded, not retried", async () => {
    let calls = 0;
    const slow = mk({ timeoutMs: 20, retry: { max: 3, backoffMs: 1 }, async execute() { calls++; await new Promise((r) => setTimeout(r, 200)); return { ok: true as const }; } });
    const g = gw([slow]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    const r: any = await g.execute(WS, id);
    expect(r).toMatchObject({ ok: false, unknown: true });
    expect(r.error).toMatch(/Outcome unknown.*timed out/);
    expect(calls).toBe(1);
    expect((await store.getApproval(WS, id))!["status"]).toBe("unknown_outcome");
  });
  it("permanent errors are not retried", async () => {
    let calls = 0;
    const t = mk({ async execute() { calls++; throw new DomainError("permanent_x", "nope"); } });
    const g = gw([t]);
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    await g.execute(WS, id);
    expect(calls).toBe(1);
  });
  it("approvals expire and cannot be approved or executed afterwards", async () => {
    let now = Date.now();
    const g = gw([mk()], { now: () => now, approvalTtlMs: 1000 });
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a" } })) as any).approvalId;
    now += 5000;
    await expect(g.decide(WS, id, "approve", OWNER)).rejects.toThrow(/expired/);
    expect((await store.getApproval(WS, id))!["status"]).toBe("expired");
    await expect(g.execute(WS, id)).rejects.toThrow();
  });
  it("export tool never claims delivery", async () => {
    const g = gw(BUILTIN_TOOLS);
    const q: any = await g.invoke({ workspaceId: WS, actor: agent, toolId: "email.export_reply_draft", input: { to: "a@x.com", subject: "Re: hi", body: "hello" } });
    await g.decide(WS, q.approvalId, "approve", OWNER);
    const r: any = await g.execute(WS, q.approvalId);
    expect(r.output.delivered).toBe(false);
    expect(r.output.eml).toContain("Subject: Re: hi");
  });
});


describe("an execution that might have succeeded is never blindly repeated", () => {
  const approveOne = async (g: ToolGateway) => {
    const id = ((await g.invoke({ workspaceId: WS, actor: agent, toolId: "test.send", input: { to: "a@x.com" } })) as any).approvalId;
    await g.decide(WS, id, "approve", OWNER);
    return id as string;
  };
  it("an unclassified error from a sending tool is an unknown outcome (default is the safe side)", async () => {
    let calls = 0;
    const g = gw([mk({ async execute() { calls++; throw new Error("socket hang up after write"); } })]);
    const id = await approveOne(g);
    expect(await g.execute(WS, id)).toMatchObject({ ok: false, unknown: true });
    expect(calls).toBe(1);
  });
  it("only errors the connector marks safe_to_retry are retried (nothing was sent)", async () => {
    let calls = 0;
    const g = gw([mk({ async execute() { calls++; throw safeToRetry("DNS failure before the request left"); } })]);
    const id = await approveOne(g);
    expect(await g.execute(WS, id)).toMatchObject({ ok: false, unknown: false });
    expect(calls).toBe(3);
    expect((await store.getApproval(WS, id))!["status"]).toBe("failed");
  });
  it("tools that neither send nor spend (write_low behind an approval) keep generic retry-with-backoff", async () => {
    let calls = 0;
    const g = gw([mk({ riskTier: "write_low", approvalPolicy: "always", async execute() { calls++; if (calls < 3) throw new Error("flaky"); return { ok: true as const }; } })]);
    const id = await approveOne(g);
    expect((await g.execute(WS, id)).ok).toBe(true);
    expect(calls).toBe(3);
  });
  it("an unknown outcome cannot be replayed or executed again", async () => {
    let calls = 0;
    const g = gw([mk({ async execute() { calls++; throw new Error("timeout-ish"); } })]);
    const id = await approveOne(g);
    await g.execute(WS, id);
    await expect(g.replay(WS, id, OWNER)).rejects.toThrow(/Only failed approvals/);
    await expect(g.execute(WS, id)).rejects.toThrow(/Cannot execute/);
    await expect(g.decide(WS, id, "approve", OWNER)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("reconcile 'delivered' records success and never sends again; the receipt says it was reconciled by a human", async () => {
    let calls = 0;
    const g = gw([mk({ async execute() { calls++; throw new Error("lost connection after send"); } })]);
    const id = await approveOne(g);
    await g.execute(WS, id);
    await expect(g.reconcile(WS, id, VIEWER, "delivered", "saw it")).rejects.toThrow(/Only owner/);
    await expect(g.reconcile(WS, id, OWNER, "delivered", "  ")).rejects.toThrow(/Say how you checked/);
    await g.reconcile(WS, id, OWNER, "delivered", "found it in Sent folder");
    expect((await store.getApproval(WS, id))!["status"]).toBe("succeeded");
    const rc = await store.listReceipts(WS, id);
    expect(rc[rc.length - 1]).toMatchObject({ ok: true, executedBy: "user:u1" });
    expect((rc[rc.length - 1]!["result"] as any).reconciled).toBe(true);
    await expect(g.execute(WS, id)).rejects.toThrow();
    await expect(g.replay(WS, id, OWNER)).rejects.toThrow();
    expect(calls).toBe(1);
    expect((await store.listAudit(WS, "approval", id)).map((a) => a["action"])).toEqual(expect.arrayContaining(["approval.outcome_unknown", "approval.reconciled_delivered"]));
  });
  it("reconcile 'not_delivered' unlocks an explicit operator replay, which then sends exactly once more", async () => {
    let calls = 0;
    const g = gw([mk({ async execute(ctx) { calls++; if (calls === 1) throw new Error("timeout-ish"); sent.push(ctx.idempotencyKey); return { ok: true as const }; } })]);
    const id = await approveOne(g);
    await g.execute(WS, id);
    await g.reconcile(WS, id, OWNER, "not_delivered", "nothing in Sent, recipient confirms nothing arrived");
    expect((await store.getApproval(WS, id))!["status"]).toBe("failed");
    expect((await g.replay(WS, id, OWNER)).ok).toBe(true);
    expect(sent).toEqual([id]);
    expect(calls).toBe(2);
  });
  it("a worker that died mid-execution leaves an 'executing' approval that becomes unknown_outcome, not a retry", async () => {
    let now = Date.now();
    let calls = 0;
    const g = gw([mk({ async execute() { calls++; return { ok: true as const }; } })], { now: () => now, executingTimeoutMs: 60_000 });
    const id = await approveOne(g);
    await db.query(`update approvals set status='executing', executing_at=$2 where id=$1`, [id, new Date(now).toISOString()]); // claimed, then the worker vanished
    expect(await g.expireStale(WS)).toBe(0);                       // still within the window
    now += 61_000;
    expect(await g.expireStale(WS)).toBe(1);
    expect((await store.getApproval(WS, id))!["status"]).toBe("unknown_outcome");
    await expect(g.execute(WS, id)).rejects.toThrow(/Cannot execute/);
    expect(calls).toBe(0);
    expect((await store.listAudit(WS, "approval", id)).some((a) => a["action"] === "approval.outcome_unknown")).toBe(true);
  });
});
