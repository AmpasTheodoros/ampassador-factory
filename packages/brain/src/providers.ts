import { AiSdkProvider, localModel } from "./ai";
import type { AiTask, Pricing } from "./llm";

export interface ModelEnv {
  AI_GATEWAY_API_KEY?: string;
  /** Vercel AI Gateway model strings ("provider/model"). No default model id is hardcoded anywhere in this repo. */
  AAF_AI_MODEL_CLASSIFY?: string;
  AAF_AI_MODEL_DRAFT?: string;
  AAF_LLM_BASE_URL?: string;
  AAF_LLM_MODEL?: string;
  AAF_LLM_API_KEY?: string;
  AAF_LLM_LOCATION?: "cloud" | "local";
  AAF_AI_PRICE_IN_PER_M?: string | number;
  AAF_AI_PRICE_OUT_PER_M?: string | number;
}

function pricing(env: ModelEnv): Pricing | undefined {
  const i = Number(env.AAF_AI_PRICE_IN_PER_M);
  const o = Number(env.AAF_AI_PRICE_OUT_PER_M);
  return Number.isFinite(i) && Number.isFinite(o) && env.AAF_AI_PRICE_IN_PER_M !== undefined && env.AAF_AI_PRICE_OUT_PER_M !== undefined && i >= 0 && o >= 0
    ? { eurPerMIn: i, eurPerMOut: o, estimated: false }
    : undefined; // undefined => pessimistic estimated default, so the budget still binds
}

/** Pure function of config. Used identically by the web app and by background workers. */
export function providersFromEnv(env: ModelEnv): AiSdkProvider[] {
  const out: AiSdkProvider[] = [];
  const price = pricing(env);
  if (env.AI_GATEWAY_API_KEY) {
    const c = env.AAF_AI_MODEL_CLASSIFY;
    const d = env.AAF_AI_MODEL_DRAFT;
    const mk = (id: string, model: string, tasks?: AiTask[]) => new AiSdkProvider({ id, location: "cloud", model, modelLabel: model, tasks, pricing: price });
    if (c && d && c !== d) {
      out.push(mk("gateway-classify", c, ["classify"]), mk("gateway-draft", d, ["draft"]));
    } else if (c || d) {
      out.push(mk("gateway", (c ?? d)!));
    }
  }
  if (env.AAF_LLM_BASE_URL && env.AAF_LLM_MODEL) {
    const location = env.AAF_LLM_LOCATION === "local" ? "local" : "cloud";
    out.push(
      new AiSdkProvider({
        id: "openai-compatible",
        location,
        model: localModel(env.AAF_LLM_BASE_URL, env.AAF_LLM_MODEL, env.AAF_LLM_API_KEY),
        modelLabel: env.AAF_LLM_MODEL,
        // a local model costs nothing in EUR; a remote OpenAI-compatible endpoint is priced like any cloud model
        pricing: location === "local" ? { eurPerMIn: 0, eurPerMOut: 0, estimated: false } : price,
        timeoutMs: location === "local" ? 60_000 : 20_000,
      }),
    );
  }
  return out;
}
