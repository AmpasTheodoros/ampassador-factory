import { generateText, Output, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { DomainError } from "@aaf/core";
import type { ZodType } from "zod";
import type { AiTask, LlmProvider, LlmRequest, LlmResult, Pricing, StructuredResult } from "./llm";

export interface AiSdkProviderOptions {
  id: string;
  location: "cloud" | "local";
  /** Either a Vercel AI Gateway model string ("provider/model") or a LanguageModel instance. Never hardcoded in this repo. */
  model: LanguageModel | string;
  modelLabel: string;
  tasks?: AiTask[];
  pricing?: Pricing;
  timeoutMs?: number;
  maxRetries?: number;
}

const tok = (n: number | undefined) => n ?? 0;

/**
 * Real model access through the Vercel AI SDK. Bounded in time (timeout), retries (maxRetries), output size
 * (maxOutputTokens) and cost (the router checks worst-case spend before calling).
 */
export class AiSdkProvider implements LlmProvider {
  readonly id: string;
  readonly location: "cloud" | "local";
  readonly modelLabel: string;
  readonly tasks?: AiTask[];
  readonly pricing: Pricing;
  readonly maxAttempts: number;
  constructor(private o: AiSdkProviderOptions) {
    this.id = o.id;
    this.location = o.location;
    this.modelLabel = o.modelLabel;
    this.tasks = o.tasks;
    this.pricing = o.pricing ?? { eurPerMIn: 15, eurPerMOut: 75, estimated: true };
    this.maxAttempts = (o.maxRetries ?? 1) + 1; // every SDK retry can be billed
  }

  private cost(inT: number, outT: number) {
    return (inT / 1e6) * this.pricing.eurPerMIn + (outT / 1e6) * this.pricing.eurPerMOut;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    try {
      const r = await generateText({
        model: this.o.model,
        system: req.system,
        prompt: req.user,
        maxOutputTokens: req.maxOutputTokens ?? 600,
        timeout: this.o.timeoutMs ?? 20_000,
        maxRetries: this.o.maxRetries ?? 1,
      });
      const i = tok(r.usage?.inputTokens);
      const o = tok(r.usage?.outputTokens);
      return { text: r.text, tokensIn: i, tokensOut: o, costEur: this.cost(i, o) };
    } catch (e) {
      throw wrap(e);
    }
  }

  async structured<T>(req: LlmRequest, schema: ZodType<T>): Promise<StructuredResult<T>> {
    try {
      const r = await generateText({
        model: this.o.model,
        system: req.system,
        prompt: req.user,
        output: Output.object({ schema }),
        maxOutputTokens: req.maxOutputTokens ?? 400,
        timeout: this.o.timeoutMs ?? 20_000,
        maxRetries: this.o.maxRetries ?? 1,
      });
      // The SDK validates against the schema; we validate again so a provider quirk can never leak an unvalidated value.
      const parsed = schema.safeParse(r.output);
      if (!parsed.success) throw new DomainError("llm_invalid_output", "Model output failed schema validation");
      const i = tok(r.usage?.inputTokens);
      const o = tok(r.usage?.outputTokens);
      return { value: parsed.data, tokensIn: i, tokensOut: o, costEur: this.cost(i, o) };
    } catch (e) {
      throw wrap(e);
    }
  }
}

function wrap(e: unknown): DomainError {
  if (e instanceof DomainError) return e;
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as Error)?.message ?? String(e);
  if (/timeout|abort/i.test(name + msg)) return new DomainError("llm_timeout", "Model call timed out");
  if (/NoObjectGenerated|NoOutputGenerated|TypeValidation|JSONParse/i.test(name)) return new DomainError("llm_invalid_output", "Model returned output that did not match the schema");
  return new DomainError("llm_error", msg.slice(0, 200));
}

/** Local OpenAI-compatible server (LM Studio, Ollama's /v1, vLLM, MLX server). Stays on this machine/network. */
export function localModel(baseURL: string, modelId: string, apiKey?: string): LanguageModel {
  return createOpenAICompatible({ name: "local", baseURL, apiKey }).chatModel(modelId);
}
