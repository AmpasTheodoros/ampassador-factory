import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Store, openRealPgHarness, type RealPgHarness } from "@aaf/database";
import { AiSdkProvider, ModelRouter, AutonomousBudgetLedger, AiClassification } from "./index";

/**
 * Budget enforcement under REAL concurrency (several pooled connections, overlapping transactions).
 * Run: pnpm localpg start && AAF_TEST_BACKEND=realpg pnpm --filter @aaf/brain test
 */
const on = process.env.AAF_TEST_BACKEND === "realpg";
const UA = "11111111-0000-4000-8000-00000000000a";

const okJson = JSON.stringify({ intent: "meeting_request", confidence: 0.9, rationale: "r", injectionSuspected: false });
const usage = (i: number, o: number) => ({ inputTokens: { total: i, noCache: i, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: o, text: o, reasoning: undefined } });

describe.skipIf(!on)("model budget under concurrent requests (real PostgreSQL)", () => {
  let h: RealPgHarness;
  let WA: string;
  const sum = async (sql: string) => Number((await h.admin.query<{ v: number }>(sql, [WA]))[0]!.v);
  const spent = () => sum(`select coalesce(sum(cost_eur),0)::float8 as v from cost_events where workspace_id=$1`);
  const heldNow = () => sum(`select coalesce(sum(amount_eur),0)::float8 as v from budget_reservations where workspace_id=$1 and settled_at is null`);

  beforeAll(async () => {
    h = await openRealPgHarness({ poolMax: 14 });
    WA = await h.database.run({ kind: "user", userId: UA }, (q) => new Store(q).provisionWorkspace("A"));
  });
  afterAll(async () => h.close());

  const REQ = { system: "classify the email", user: "Could we have a call next week about booking confirmations?", maxOutputTokens: 1000 };
  async function burst(n: number, model: MockLanguageModelV4, prov: AiSdkProvider) {
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        h.database.run({ kind: "user", userId: UA }, async (q) => {
          const router = new ModelRouter(new Store(q), [prov], { ledger: new AutonomousBudgetLedger(h.ledgerDatabase!) });
          try { await router.structured(WA, "classify", "hybrid", REQ, AiClassification); return "ok" as const; }
          catch (e) { return ((e as { code?: string }).code ?? "error") as string; }
        }),
      ),
    );
    void model;
    return results;
  }

  it("30 simultaneous calls against a budget that covers only k of them: exactly k reach the provider, the rest are refused, spend never exceeds the budget", async () => {
    const state = { calls: 0 };
    const model = new MockLanguageModelV4({
      doGenerate: async () => { state.calls++; await new Promise((r) => setTimeout(r, 400)); return { content: [{ type: "text" as const, text: okJson }], finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(500, 100), warnings: [] }; },
    });
    const prov = new AiSdkProvider({ id: "p", location: "cloud", model, modelLabel: "mock", maxRetries: 0, pricing: { eurPerMIn: 10, eurPerMOut: 10, estimated: false } });
    const worst = new ModelRouter(new Store(h.admin as never), [prov]).worstCase(prov, REQ.system.length + REQ.user.length, REQ.maxOutputTokens);
    const k = 4;
    const budget = Math.round((worst * k + worst * 0.5) * 1e6) / 1e6; // room for exactly k reservations, not k+1
    await h.admin.exec(`update workspaces set monthly_budget_eur=${budget} where id='${WA}'`);

    const res = await burst(30, model, prov);
    expect(res.filter((r) => r === "ok").length).toBe(k);
    expect(res.filter((r) => r === "budget_exceeded").length).toBe(30 - k);
    expect(state.calls).toBe(k);                       // the provider was never even called for the refused ones
    expect(await spent()).toBeLessThanOrEqual(budget);
    expect(await heldNow()).toBe(0);                   // everything settled
    expect(await spent()).toBeCloseTo(k * ((500 / 1e6) * 10 + (100 / 1e6) * 10), 8); // actual usage, not the reserve
  });

  it("calls that FAIL after inference are charged, so a burst of failing calls cannot be used to dodge the budget", async () => {
    await h.admin.exec(`delete from budget_reservations where workspace_id='${WA}'`).catch(() => {});
    const before = await spent();
    const state = { calls: 0 };
    const model = new MockLanguageModelV4({
      doGenerate: async () => { state.calls++; await new Promise((r) => setTimeout(r, 300)); return { content: [{ type: "text" as const, text: "garbage, not json" }], finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(10, 10), warnings: [] }; },
    });
    const prov = new AiSdkProvider({ id: "p2", location: "cloud", model, modelLabel: "mock-bad", maxRetries: 0, pricing: { eurPerMIn: 10, eurPerMOut: 10, estimated: false } });
    const worst = new ModelRouter(new Store(h.admin as never), [prov]).worstCase(prov, REQ.system.length + REQ.user.length, REQ.maxOutputTokens);
    const budget = Math.round((before + worst * 3 + worst * 0.5) * 1e6) / 1e6;
    await h.admin.exec(`update workspaces set monthly_budget_eur=${budget} where id='${WA}'`);
    const res = await burst(20, model, prov);
    expect(res.filter((r) => r === "llm_invalid_output").length).toBe(3);   // 3 got through, all failed after inference
    expect(res.filter((r) => r === "budget_exceeded").length).toBe(17);
    expect(state.calls).toBe(3);
    const rows = await h.admin.query<{ kind: string }>(`select kind from cost_events where workspace_id=$1 and model='mock-bad'`, [WA]);
    expect(rows.map((r) => r.kind)).toEqual(["unconfirmed_charge", "unconfirmed_charge", "unconfirmed_charge"]);
    expect(await spent()).toBeLessThanOrEqual(budget);
    // and afterwards NOTHING more can be spent: the budget is genuinely used up by the unconfirmed charges
    const again = await burst(5, model, prov);
    expect(again.every((r) => r === "budget_exceeded")).toBe(true);
  });

  it("many small concurrent calls: the total never passes the budget even as settlements free reserved room", async () => {
    await h.admin.exec(`update workspaces set monthly_budget_eur=1000 where id='${WA}'`);
    const base = await spent();
    const model = new MockLanguageModelV4({
      doGenerate: async () => { await new Promise((r) => setTimeout(r, 30)); return { content: [{ type: "text" as const, text: okJson }], finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(200, 50), warnings: [] }; },
    });
    const prov = new AiSdkProvider({ id: "p3", location: "cloud", model, modelLabel: "mock-small", maxRetries: 0, pricing: { eurPerMIn: 10, eurPerMOut: 10, estimated: false } });
    const worst = new ModelRouter(new Store(h.admin as never), [prov]).worstCase(prov, REQ.system.length + REQ.user.length, REQ.maxOutputTokens);
    const actual = (200 / 1e6) * 10 + (50 / 1e6) * 10;
    const budget = base + actual * 7.5 + worst; // roughly 7-8 actual-cost calls fit once earlier ones settle
    await h.admin.exec(`update workspaces set monthly_budget_eur=${budget} where id='${WA}'`);
    let maxObserved = 0;
    const watcher = setInterval(async () => { maxObserved = Math.max(maxObserved, (await spent()) + (await heldNow())); }, 5);
    const res = await burst(60, model, prov);
    clearInterval(watcher);
    expect(res.filter((r) => r === "ok").length).toBeGreaterThanOrEqual(1);
    expect(await spent()).toBeLessThanOrEqual(budget + 1e-9);
    expect(maxObserved).toBeLessThanOrEqual(budget + 1e-9);   // committed + reserved never exceeded the budget at any sampled instant
    expect(await heldNow()).toBe(0);
  });
});
