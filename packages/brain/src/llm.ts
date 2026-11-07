import { DomainError, newId, type DataPolicy } from "@aaf/core";
import type { Store } from "@aaf/database";

export interface LlmRequest { system: string; user: string }
export interface LlmResult { text: string; tokensIn: number; tokensOut: number; costEur: number }
export interface LlmProvider {
  id: string;
  location: "cloud" | "local";
  complete(req: LlmRequest): Promise<LlmResult>;
}

export type Routing = "cloud" | "local" | "hybrid";

/** Mask obvious identifiers before anything may leave for a hosted provider. */
export function redact(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

export class ModelRouter {
  constructor(private store: Store, private providers: LlmProvider[]) {}

  available(): boolean { return this.providers.length > 0; }

  /** Data policy is read per workspace and is independent of the preferred routing. local_only never reaches a cloud provider. */
  async complete(ws: string, routing: Routing, req: LlmRequest): Promise<LlmResult & { providerId: string; redacted: boolean }> {
    const w = await this.store.getWorkspace(ws);
    if (!w) throw new DomainError("not_found", "workspace");
    const policy = w["dataPolicy"] as DataPolicy;
    const spend = await this.store.monthSpendEur(ws);
    if (spend >= (w["monthlyBudgetEur"] as number)) throw new DomainError("budget_exceeded", `Monthly AI budget reached (${spend.toFixed(2)} EUR)`);

    const locals = this.providers.filter((p) => p.location === "local");
    const clouds = this.providers.filter((p) => p.location === "cloud");
    let order: LlmProvider[];
    if (policy === "local_only") order = locals; // fail closed: no cloud fallback, ever
    else if (routing === "local") order = locals;
    else if (routing === "cloud") order = clouds;
    else order = [...locals, ...clouds];
    const p = order[0];
    if (!p)
      throw new DomainError(
        policy === "local_only" ? "local_unavailable" : "no_provider",
        policy === "local_only" ? "local_only policy and no local node available: refusing to use cloud" : "No LLM provider configured",
      );

    const redacted = p.location === "cloud" && policy !== "cloud_allowed";
    const r = await p.complete(redacted ? { system: req.system, user: redact(req.user) } : req);
    await this.store.addCost(ws, { provider: p.id, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costEur: r.costEur, runId: newId() });
    return { ...r, providerId: p.id, redacted };
  }
}

/** Any OpenAI-compatible /chat/completions endpoint (Ollama, vLLM, MLX server, a gateway). Model ID comes from config. */
export class OpenAICompatProvider implements LlmProvider {
  constructor(
    public id: string,
    public location: "cloud" | "local",
    private cfg: { baseUrl: string; model: string; apiKey?: string; eurPer1kIn?: number; eurPer1kOut?: number; fetchImpl?: typeof fetch },
  ) {}
  async complete(req: LlmRequest): Promise<LlmResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.cfg.model, messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }] }),
    });
    if (!res.ok) throw new DomainError("llm_http", `LLM HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new DomainError("llm_empty", "LLM returned no content");
    const tin = j.usage?.prompt_tokens ?? 0;
    const tout = j.usage?.completion_tokens ?? 0;
    return { text, tokensIn: tin, tokensOut: tout, costEur: (tin / 1000) * (this.cfg.eurPer1kIn ?? 0) + (tout / 1000) * (this.cfg.eurPer1kOut ?? 0) };
  }
}
