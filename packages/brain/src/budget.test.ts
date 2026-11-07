import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Store, openTestHarness, type TestHarness } from "@aaf/database";
import { AiSdkProvider, ModelRouter, AutonomousBudgetLedger, TxBudgetLedger, AiClassification, type BudgetLedger } from "./index";

const UA = "11111111-0000-4000-8000-00000000000a";
const UB = "22222222-0000-4000-8000-00000000000b";
let h: TestHarness;
let WA: string, WB: string;
const asUser = <T>(u: string, fn: (s: Store) => Promise<T>) => h.database.run({ kind: "user", userId: u }, (q) => fn(new Store(q)));
const svc = <T>(ws: string, fn: (s: Store) => Promise<T>) =>
  h.database.run({ kind: "service", workspaceId: ws, reason: "t" }, (q) => fn(new Store(q)));

const okJson = JSON.stringify({ intent: "meeting_request", confidence: 0.9, rationale: "r", injectionSuspected: false });
function mock(kind: "ok" | "invalid" | "timeout" | "http500", usage = { in: 1000, out: 100 }, state?: { calls: number; delayMs?: number }) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      if (state) state.calls++;
      if (state?.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (kind === "timeout") {
        const e = new Error("The operation timed out");
        e.name = "TimeoutError";
        throw e;
      }
      if (kind === "http500") throw new Error("upstream 500");
      return {
        content: [{ type: "text" as const, text: kind === "invalid" ? "not json at all" : okJson }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: usage.in, noCache: usage.in, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: usage.out, text: usage.out, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}
const provider = (model: MockLanguageModelV4, o: { priced?: boolean; maxRetries?: number } = {}) =>
  new AiSdkProvider({
    id: "p",
    location: "cloud",
    model,
    modelLabel: "mock",
    maxRetries: o.maxRetries ?? 0,
    pricing: { eurPerMIn: 10, eurPerMOut: 10, estimated: o.priced === false },
  });
const REQ = { system: "classify", user: "Could we have a call next week?", maxOutputTokens: 1000 };
const costRows = (ws: string) =>
  svc(ws, (s) =>
    s.db.query<{ kind: string; costEur: number; tokensIn: number; model: string | null }>(
      `select kind, cost_eur::float8 as cost_eur, tokens_in, model from cost_events where workspace_id=$1 order by created_at`,
      [ws],
    ),
  );
const held = (ws: string) =>
  svc(ws, async (s) =>
    Number(
      (
        await s.db.query<{ h: number }>(
          `select coalesce(sum(amount_eur),0)::float8 as h from budget_reservations where workspace_id=$1 and settled_at is null`,
          [ws],
        )
      )[0]!.h,
    ),
  );
const setBudget = (ws: string, eur: number) => h.admin.exec(`update workspaces set monthly_budget_eur=${eur} where id='${ws}'`);

beforeEach(async () => {
  h = await openTestHarness();
  WA = await asUser(UA, (s) => s.provisionWorkspace("A"));
  WB = await asUser(UB, (s) => s.provisionWorkspace("B"));
});
afterEach(async () => h.close());

describe("budget ledger (database functions)", () => {
  const ledger = (): BudgetLedger =>
    h.backend === "realpg" ? new AutonomousBudgetLedger(h.ledgerDatabase!) : new TxBudgetLedger(undefined as never);

  it("reserve/settle/release arithmetic, atomically, per workspace", async () => {
    await setBudget(WA, 0.05);
    await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, async (q) => {
      const l = new TxBudgetLedger(q);
      expect(await l.reserve(WA, "11111111-1111-4111-8111-111111111111", 0.03)).toBe(true);
      expect(await l.reserve(WA, "22222222-2222-4222-8222-222222222222", 0.03)).toBe(false); // 0.03 held + 0.03 > 0.05
      await l.release(WA, "11111111-1111-4111-8111-111111111111");
      expect(await l.reserve(WA, "22222222-2222-4222-8222-222222222222", 0.03)).toBe(true);
      await l.settle(WA, "22222222-2222-4222-8222-222222222222", {
        provider: "p",
        model: "m",
        tokensIn: 5,
        tokensOut: 5,
        costEur: 0.01,
        kind: "usage_estimate",
      });
      expect(await l.reserve(WA, "33333333-3333-4333-8333-333333333333", 0.04)).toBe(true); // spent 0.01 + 0.04 = 0.05, allowed
      expect(await l.reserve(WA, "44444444-4444-4444-8444-444444444444", 0.001)).toBe(false); // would exceed
    });
    expect((await costRows(WA)).map((r) => [r.kind, r.costEur])).toEqual([["usage_estimate", 0.01]]);
    void ledger;
  });

  it("a reservation that is never settled (crash) is charged at its reserved amount after it expires", async () => {
    await setBudget(WA, 1);
    await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) =>
      q.query(`select app_budget_reserve($1,$2,$3,$4)`, [WA, "55555555-5555-4555-8555-555555555555", 0.2, 1]),
    );
    expect(await held(WA)).toBeCloseTo(0.2);
    await new Promise((r) => setTimeout(r, 1200));
    await h.database.run({ kind: "service", workspaceId: WA, reason: "t" }, (q) =>
      new TxBudgetLedger(q).reserve(WA, "66666666-6666-4666-8666-666666666666", 0.1),
    ); // any reserve sweeps
    expect(await held(WA)).toBeCloseTo(0.1);
    expect((await costRows(WA)).map((r) => [r.kind, r.costEur])).toEqual([["unconfirmed_charge", 0.2]]);
  });

  it("tenant boundaries: another user cannot reserve against or settle into this workspace; viewers cannot spend", async () => {
    await expect(
      h.database.run({ kind: "user", userId: UB }, (q) => new TxBudgetLedger(q).reserve(WA, "77777777-7777-4777-8777-777777777777", 0.01)),
    ).rejects.toThrow(/not authorised/);
    await expect(
      h.database.run({ kind: "service", workspaceId: WB, reason: "t" }, (q) =>
        new TxBudgetLedger(q).reserve(WA, "88888888-8888-4888-8888-888888888888", 0.01),
      ),
    ).rejects.toThrow(/not authorised/);
    await expect(
      h.database.run({ kind: "service", workspaceId: WB, reason: "t" }, (q) =>
        new TxBudgetLedger(q).settle(WA, "99999999-9999-4999-8999-999999999999", {
          provider: "p",
          model: "m",
          tokensIn: 0,
          tokensOut: 0,
          costEur: 0.5,
          kind: "usage_estimate",
        }),
      ),
    ).rejects.toThrow(/not authorised/);
    await expect(
      h.database.run({ kind: "anon" }, (q) => q.query(`select app_budget_reserve($1,gen_random_uuid(),0.01)`, [WA])),
    ).rejects.toThrow();
    // nobody can write reservations or cost rows directly
    await expect(
      h.database.run({ kind: "user", userId: UA }, (q) =>
        q.query(`insert into budget_reservations(id,workspace_id,amount_eur,expires_at) values (gen_random_uuid(),$1,0,now())`, [WA]),
      ),
    ).rejects.toThrow();
    await expect(h.database.run({ kind: "user", userId: UA }, (q) => q.query(`update cost_events set cost_eur=0`))).rejects.toThrow();
  });
});

describe("router + ledger: outcomes are accounted correctly", () => {
  // each logical call is its own transaction when the backend is a real pool; on the embedded DB the ledger shares the tx
  const callOnce = (prov: AiSdkProvider, resultOf: "ok" | "err" = "ok") =>
    h.database.run({ kind: "user", userId: UA }, async (q) => {
      const store = new Store(q);
      const ledger = h.backend === "realpg" ? new AutonomousBudgetLedger(h.ledgerDatabase!) : new TxBudgetLedger(q);
      const router = new ModelRouter(store, [prov], { ledger });
      try {
        return await router.structured(WA, "classify", "hybrid", REQ, AiClassification);
      } catch (e) {
        if (resultOf === "ok") throw e;
        return e as { code?: string };
      }
    });

  it("success: settles ACTUAL token usage x configured price, labelled as an estimate (never as confirmed billing)", async () => {
    await setBudget(WA, 1);
    await callOnce(provider(mock("ok", { in: 1000, out: 200 })));
    const rows = await costRows(WA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "usage_estimate", tokensIn: 1000, model: "mock" });
    expect(rows[0]!.costEur).toBeCloseTo((1000 / 1e6) * 10 + (200 / 1e6) * 10, 8);
    expect(await held(WA)).toBe(0);
  });
  it("no price configured: the row says it used the pessimistic default price", async () => {
    await setBudget(WA, 10);
    await callOnce(provider(mock("ok"), { priced: false }));
    expect((await costRows(WA))[0]!.kind).toBe("usage_estimate_unpriced");
  });
  it("model answered but the output was invalid: inference happened, so the reserve is CHARGED (not released)", async () => {
    await setBudget(WA, 1);
    const e = (await callOnce(provider(mock("invalid")), "err")) as { code?: string };
    expect(e.code).toBe("llm_invalid_output");
    const rows = await costRows(WA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("unconfirmed_charge");
    expect(rows[0]!.costEur).toBeGreaterThan(0);
    expect(await held(WA)).toBe(0);
  });
  it("timeout: outcome unknown, so the reserve is charged", async () => {
    await setBudget(WA, 1);
    expect(((await callOnce(provider(mock("timeout")), "err")) as { code?: string }).code).toBe("llm_timeout");
    expect((await costRows(WA)).map((r) => r.kind)).toEqual(["unconfirmed_charge"]);
  });
  it("provider HTTP error (rejected before inference): the reservation is released and nothing is charged", async () => {
    await setBudget(WA, 1);
    expect(((await callOnce(provider(mock("http500")), "err")) as { code?: string }).code).toBe("llm_error");
    expect(await costRows(WA)).toHaveLength(0);
    expect(await held(WA)).toBe(0);
  });
  it("the reserve covers EVERY SDK retry: maxRetries=2 reserves 3x", async () => {
    await setBudget(WA, 1);
    const p1 = provider(mock("ok"), { maxRetries: 0 });
    const p3 = provider(mock("ok"), { maxRetries: 2 });
    const router = new ModelRouter(new Store(h.admin as never), [p1]);
    const w1 = (router as unknown as { worstCase(p: AiSdkProvider, i: number, o: number): number }).worstCase(p1, 100, 1000);
    const w3 = (router as unknown as { worstCase(p: AiSdkProvider, i: number, o: number): number }).worstCase(p3, 100, 1000);
    expect(w3 / w1).toBeCloseTo(3, 6);
  });
  it("a request that fails AFTER a paid call still has that call accounted (autonomous ledger survives the rollback)", async () => {
    if (h.backend !== "realpg") return; // needs a second connection; the embedded DB shares one transaction
    await setBudget(WA, 1);
    await expect(
      h.database.run({ kind: "user", userId: UA }, async (q) => {
        const router = new ModelRouter(new Store(q), [provider(mock("ok"))], { ledger: new AutonomousBudgetLedger(h.ledgerDatabase!) });
        await router.structured(WA, "classify", "hybrid", REQ, AiClassification);
        throw new Error("request failed after the model call");
      }),
    ).rejects.toThrow("request failed");
    expect(await costRows(WA)).toHaveLength(1);
  });
  it("budget exhausted: the provider is not called at all", async () => {
    await setBudget(WA, 0.0001);
    const state = { calls: 0 };
    const e = (await callOnce(provider(mock("ok", undefined, state)), "err")) as { code?: string };
    expect(e.code).toBe("budget_exceeded");
    expect(state.calls).toBe(0);
  });
});
