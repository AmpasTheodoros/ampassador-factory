import type { Database, Queryable } from "@aaf/database";

export type CostKind = "usage_estimate" | "usage_estimate_unpriced" | "unconfirmed_charge" | "confirmed_billing";

export interface Settlement {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
  /** How trustworthy the number is. Only `confirmed_billing` is provider-confirmed, and nothing writes it yet. */
  kind: CostKind;
}

/**
 * Concurrency-safe model budget. A call first RESERVES its worst-case cost (atomically, serialised per workspace in
 * the database), then SETTLES the actual cost, or RELEASES the reservation when the call provably did not happen.
 * A reservation that is never settled (crash) is charged at its reserved amount once it expires.
 */
export interface BudgetLedger {
  /** false => the budget cannot cover this call, nothing was reserved. */
  reserve(ws: string, id: string, amountEur: number): Promise<boolean>;
  settle(ws: string, id: string, s: Settlement): Promise<void>;
  release(ws: string, id: string): Promise<void>;
}

/** Runs inside the CALLER'S transaction. Correct and atomic, but a rollback of that transaction also rolls back the ledger. Used for the embedded dev database. */
export class TxBudgetLedger implements BudgetLedger {
  constructor(private q: Queryable) {}
  async reserve(ws: string, id: string, amountEur: number) {
    const r = await this.q.query<{ appBudgetReserve: boolean }>(`select app_budget_reserve($1,$2,$3)`, [ws, id, amountEur]);
    return r[0]!.appBudgetReserve;
  }
  async settle(ws: string, id: string, s: Settlement) {
    await this.q.query(`select app_budget_settle($1,$2,$3,$4,$5,$6,$7,$8)`, [ws, id, s.provider, s.model, s.tokensIn, s.tokensOut, s.costEur, s.kind]);
  }
  async release(ws: string, id: string) {
    await this.q.query(`select app_budget_release($1,$2)`, [ws, id]);
  }
}

/**
 * Every operation is its own short transaction as the workspace-pinned service role, on a different pooled connection
 * than the request. So a reservation is visible to concurrent requests immediately, and a settlement survives a
 * rollback of the request that made the call. Requires a real connection pool (not the single-connection embedded DB).
 */
export class AutonomousBudgetLedger implements BudgetLedger {
  constructor(private database: Database) {}
  private run<T>(ws: string, fn: (l: TxBudgetLedger) => Promise<T>) {
    return this.database.run({ kind: "service", workspaceId: ws, reason: "budget-ledger" }, (q) => fn(new TxBudgetLedger(q)));
  }
  reserve(ws: string, id: string, amountEur: number) { return this.run(ws, (l) => l.reserve(ws, id, amountEur)); }
  settle(ws: string, id: string, s: Settlement) { return this.run(ws, (l) => l.settle(ws, id, s)); }
  release(ws: string, id: string) { return this.run(ws, (l) => l.release(ws, id)); }
}
