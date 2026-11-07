import { DomainError, newId, type DataPolicy } from "@aaf/core";
import type { Store } from "@aaf/database";
import type { ZodType } from "zod";
import type { BudgetLedger, CostKind } from "./budget";

export type AiTask = "classify" | "draft";

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens?: number;
}
export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
}
export interface StructuredResult<T> {
  value: T;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
}

export interface Pricing {
  eurPerMIn: number;
  eurPerMOut: number;
  /** true when the operator did not configure real prices: a pessimistic default is used so budgets still bind. */
  estimated: boolean;
}

export interface LlmProvider {
  id: string;
  /** Human-readable model label for provenance (e.g. the configured model id). */
  modelLabel: string;
  location: "cloud" | "local";
  /** Tasks this provider is preferred for; empty/undefined = any. */
  tasks?: AiTask[];
  pricing?: Pricing;
  /** How many times one logical call may be billed (1 + SDK retries). The reservation covers all of them. */
  maxAttempts?: number;
  complete(req: LlmRequest): Promise<LlmResult>;
  structured?<T>(req: LlmRequest, schema: ZodType<T>): Promise<StructuredResult<T>>;
}

export type Routing = "cloud" | "local" | "hybrid";

export interface CallEvent {
  workspaceId: string;
  task: string;
  providerId: string;
  modelLabel: string;
  location: "cloud" | "local";
  ok: boolean;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
  redacted: boolean;
  error?: string;
}

export interface CostRow {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
}

export interface RouterOptions {
  /** Atomic reserve/settle budget (preferred). When absent the legacy read-then-call guard + deferCosts is used. */
  ledger?: BudgetLedger;
  /** Hold cost rows in memory so they survive a rolled-back transaction; the host must call flushCosts() afterwards in its own transaction. */
  deferCosts?: boolean;
  /** Called after every model call (success or failure). Must not receive prompt text. */
  onCall?: (e: CallEvent) => void;
  maxInputChars?: number;
}

/** Mask obvious identifiers before anything may leave for a hosted provider. */
export function redact(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

const DEFAULT_PRICE: Pricing = { eurPerMIn: 15, eurPerMOut: 75, estimated: true };

export class ModelRouter {
  private pending: CostRow[] = [];
  constructor(
    private store: Store,
    private providers: LlmProvider[],
    private opts: RouterOptions = {},
  ) {}

  available(): boolean {
    return this.providers.length > 0;
  }
  pendingCosts(): CostRow[] {
    return [...this.pending];
  }
  /** Persist deferred cost rows (call outside the request/job transaction, whether it committed or rolled back). */
  async flushCosts(store: Store): Promise<number> {
    const rows = this.pending.splice(0);
    for (const r of rows)
      await store.addCost(this.wsForFlush ?? "", {
        provider: r.provider,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costEur: r.costEur,
      });
    return rows.length;
  }
  private wsForFlush?: string;
  describe() {
    return this.providers.map((p) => ({
      id: p.id,
      model: p.modelLabel,
      location: p.location,
      tasks: p.tasks ?? "any",
      priced: !(p.pricing?.estimated ?? true),
    }));
  }

  private async pick(ws: string, task: string, routing: Routing) {
    const w = await this.store.getWorkspace(ws);
    if (!w) throw new DomainError("not_found", "workspace");
    const policy = w["dataPolicy"] as DataPolicy;
    const locals = this.providers.filter((p) => p.location === "local");
    const clouds = this.providers.filter((p) => p.location === "cloud");
    let order: LlmProvider[];
    if (policy === "local_only")
      order = locals; // fail closed: no cloud fallback, ever
    else if (routing === "local") order = locals;
    else if (routing === "cloud") order = clouds;
    else order = [...locals, ...clouds];
    // task routing: a provider declared for this task wins over a generic one
    const preferred = order.filter((p) => p.tasks?.includes(task as AiTask));
    const p = (preferred.length ? preferred : order.filter((x) => !x.tasks || x.tasks.length === 0))[0] ?? order[0];
    if (!p)
      throw new DomainError(
        policy === "local_only" ? "local_unavailable" : "no_provider",
        policy === "local_only" ? "local_only policy and no local node available: refusing to use cloud" : "No LLM provider configured",
      );
    return { w, policy, p };
  }

  /** Reject before calling if the worst case for this call would exceed the monthly budget. */
  private async guardBudget(ws: string, budget: number, p: LlmProvider, inputChars: number, maxOut: number) {
    const price = p.pricing ?? DEFAULT_PRICE;
    const worst = (Math.ceil(inputChars / 3) / 1e6) * price.eurPerMIn + (maxOut / 1e6) * price.eurPerMOut;
    const spend = (await this.store.monthSpendEur(ws)) + this.pending.reduce((a, r) => a + r.costEur, 0);
    if (spend >= budget) throw new DomainError("budget_exceeded", `Monthly AI budget reached (${spend.toFixed(2)} EUR)`);
    if (p.location === "cloud" && spend + worst > budget)
      throw new DomainError(
        "budget_exceeded",
        `This call could exceed the monthly AI budget (spent ${spend.toFixed(2)}, worst case +${worst.toFixed(4)} EUR)`,
      );
  }

  /** Upper bound of what one logical call can cost: all attempts, full input, full output budget. */
  worstCase(p: LlmProvider, inputChars: number, maxOut: number): number {
    const price = p.pricing ?? DEFAULT_PRICE;
    const one = (Math.ceil(inputChars / 3) / 1e6) * price.eurPerMIn + (maxOut / 1e6) * price.eurPerMOut;
    return Math.round(one * (p.maxAttempts ?? 1) * 1e8) / 1e8;
  }

  /** Reserve (ledger) or check (legacy). Returns the reservation id and amount, or undefined on the legacy path. */
  private async admit(
    ws: string,
    w: Record<string, unknown>,
    p: LlmProvider,
    inputChars: number,
    maxOut: number,
  ): Promise<{ id: string; amount: number } | undefined> {
    if (!this.opts.ledger) {
      await this.guardBudget(ws, w["monthlyBudgetEur"] as number, p, inputChars, maxOut);
      return undefined;
    }
    const amount = p.location === "local" ? 0 : this.worstCase(p, inputChars, maxOut);
    const id = newId();
    if (!(await this.opts.ledger.reserve(ws, id, amount)))
      throw new DomainError("budget_exceeded", `The monthly AI budget cannot cover this call (worst case ${amount.toFixed(4)} EUR)`);
    return { id, amount };
  }

  /** Outcomes where inference may have happened and been billed are charged at the reserve; clear pre-inference rejections are released. */
  private async settleFailure(ws: string, p: LlmProvider, resv: { id: string; amount: number } | undefined, e: unknown) {
    if (!resv || !this.opts.ledger) return;
    const code = (e as { code?: string })?.code;
    if (code === "llm_timeout" || code === "llm_invalid_output") {
      await this.opts.ledger.settle(ws, resv.id, {
        provider: p.id,
        model: p.modelLabel,
        tokensIn: 0,
        tokensOut: 0,
        costEur: resv.amount,
        kind: "unconfirmed_charge",
      });
    } else {
      await this.opts.ledger.release(ws, resv.id);
    }
  }
  private async settleSuccess(
    ws: string,
    p: LlmProvider,
    resv: { id: string; amount: number } | undefined,
    r: { tokensIn: number; tokensOut: number; costEur: number },
  ) {
    if (!resv || !this.opts.ledger) return;
    const kind: CostKind = p.pricing && !p.pricing.estimated ? "usage_estimate" : "usage_estimate_unpriced";
    await this.opts.ledger.settle(ws, resv.id, {
      provider: p.id,
      model: p.modelLabel,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costEur: r.costEur,
      kind,
    });
  }

  private prep(req: LlmRequest, redacted: boolean): LlmRequest {
    const max = this.opts.maxInputChars ?? 8000;
    const user = req.user.length > max ? req.user.slice(0, max) : req.user;
    return { ...req, user: redacted ? redact(user) : user };
  }

  private async record(
    ws: string,
    task: string,
    p: LlmProvider,
    redacted: boolean,
    started: number,
    r: { tokensIn: number; tokensOut: number; costEur: number } | null,
    err?: unknown,
  ) {
    if (r && !this.opts.ledger) {
      if (this.opts.deferCosts) {
        this.wsForFlush = ws;
        this.pending.push({ provider: p.id, model: p.modelLabel, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costEur: r.costEur });
      } else
        await this.store.addCost(ws, {
          provider: p.id,
          model: p.modelLabel,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          costEur: r.costEur,
          runId: newId(),
        });
    }
    this.opts.onCall?.({
      workspaceId: ws,
      task,
      providerId: p.id,
      modelLabel: p.modelLabel,
      location: p.location,
      ok: !!r,
      durationMs: Date.now() - started,
      tokensIn: r?.tokensIn ?? 0,
      tokensOut: r?.tokensOut ?? 0,
      costEur: r?.costEur ?? 0,
      redacted,
      error: err ? ((err as { code?: string }).code ?? "error") : undefined,
    });
  }

  async complete(
    ws: string,
    routing: Routing,
    req: LlmRequest,
    task = "text",
  ): Promise<LlmResult & { providerId: string; redacted: boolean }> {
    const { w, policy, p } = await this.pick(ws, task, routing);
    const resv = await this.admit(ws, w, p, req.system.length + req.user.length, req.maxOutputTokens ?? 1024);
    const redacted = p.location === "cloud" && policy !== "cloud_allowed";
    const t = Date.now();
    try {
      const r = await p.complete(this.prep(req, redacted));
      await this.settleSuccess(ws, p, resv, r);
      await this.record(ws, task, p, redacted, t, r);
      return { ...r, providerId: p.id, redacted };
    } catch (e) {
      await this.settleFailure(ws, p, resv, e);
      await this.record(ws, task, p, redacted, t, null, e);
      throw e;
    }
  }

  async structured<T>(
    ws: string,
    task: AiTask,
    routing: Routing,
    req: LlmRequest,
    schema: ZodType<T>,
  ): Promise<
    StructuredResult<T> & {
      providerId: string;
      modelLabel: string;
      location: "cloud" | "local";
      redacted: boolean;
      priceEstimated: boolean;
    }
  > {
    const { w, policy, p } = await this.pick(ws, task, routing);
    if (!p.structured) throw new DomainError("no_structured", `Provider ${p.id} has no structured output`);
    const resv = await this.admit(ws, w, p, req.system.length + req.user.length, req.maxOutputTokens ?? 400);
    const redacted = p.location === "cloud" && policy !== "cloud_allowed";
    const t = Date.now();
    let r;
    try {
      r = await p.structured(this.prep(req, redacted), schema);
    } catch (e) {
      await this.settleFailure(ws, p, resv, e);
      await this.record(ws, task, p, redacted, t, null, e);
      throw e;
    }
    await this.settleSuccess(ws, p, resv, r);
    await this.record(ws, task, p, redacted, t, r);
    return {
      ...r,
      providerId: p.id,
      modelLabel: p.modelLabel,
      location: p.location,
      redacted,
      priceEstimated: p.pricing?.estimated ?? true,
    };
  }
}

/** Any OpenAI-compatible /chat/completions endpoint, used directly (no SDK). Retained for tests and minimal setups. */
export class OpenAICompatProvider implements LlmProvider {
  readonly modelLabel: string;
  constructor(
    public id: string,
    public location: "cloud" | "local",
    private cfg: { baseUrl: string; model: string; apiKey?: string; eurPer1kIn?: number; eurPer1kOut?: number; fetchImpl?: typeof fetch },
  ) {
    this.modelLabel = cfg.model;
  }
  async complete(req: LlmRequest): Promise<LlmResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) throw new DomainError("llm_http", `LLM HTTP ${res.status}`);
    const j = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new DomainError("llm_empty", "LLM returned no content");
    const tin = j.usage?.prompt_tokens ?? 0;
    const tout = j.usage?.completion_tokens ?? 0;
    return {
      text,
      tokensIn: tin,
      tokensOut: tout,
      costEur: (tin / 1000) * (this.cfg.eurPer1kIn ?? 0) + (tout / 1000) * (this.cfg.eurPer1kOut ?? 0),
    };
  }
}
