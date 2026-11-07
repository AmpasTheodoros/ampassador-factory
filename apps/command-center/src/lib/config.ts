import { z } from "zod";

const optStr = z.string().trim().min(1).optional();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // TEST ONLY. Lets the browser tests run a production build on the embedded database. Refused on Vercel, and /api/ready reports not-ready while set.
  AAF_RUNTIME_MODE: z.enum(["normal", "e2e"]).default("normal"),
  VERCEL_ENV: z.string().optional(),
  // data plane
  DATABASE_URL: optStr, // Supabase pooler URL for the least-privileged login role (aaf_app)
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  DATABASE_LEDGER_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2), // short budget transactions; separate so request transactions cannot starve them
  AAF_DATA_DIR: z.string().default(".data/pglite"), // embedded database for local dev only; ":memory:" for throwaway
  // auth
  AAF_AUTH_PROVIDER: z.enum(["supabase", "local"]).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optStr,
  AAF_DEV_EMAIL: z.string().email().optional(),
  AAF_DEV_PASSWORD: z.string().min(8).optional(),
  AAF_DEV_EMAIL_2: z.string().email().optional(), // second dev user, for tenant-isolation tests
  AAF_DEV_PASSWORD_2: z.string().min(8).optional(),
  AAF_APP_ORIGIN: z.string().url().optional(), // e.g. https://command.example.com ; required in production
  AAF_OWNER_NAME: z.string().default("Theodoros"),
  // models
  AAF_LLM_BASE_URL: z.string().url().optional(),
  AAF_LLM_MODEL: optStr,
  AAF_LLM_API_KEY: optStr,
  AAF_LLM_LOCATION: z.enum(["cloud", "local"]).default("cloud"),
  AI_GATEWAY_API_KEY: optStr,
  AAF_AI_MODEL_CLASSIFY: optStr, // e.g. "anthropic/claude-haiku-4.5" via AI Gateway; no default model id is hardcoded
  AAF_AI_MODEL_DRAFT: optStr,
  AAF_AI_PRICE_IN_PER_M: z.coerce.number().min(0).optional(), // EUR per million input tokens; unset => pessimistic estimate
  AAF_AI_PRICE_OUT_PER_M: z.coerce.number().min(0).optional(),
  // observability (all optional)
  LANGFUSE_PUBLIC_KEY: optStr,
  LANGFUSE_SECRET_KEY: optStr,
  LANGFUSE_BASEURL: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: optStr,
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  // NetworkRadar (read-only adapter)
  NETWORKRADAR_MCP_URL: z.string().url().optional(),
  NETWORKRADAR_MCP_API_KEY: optStr,
  // jobs
  TRIGGER_SECRET_KEY: optStr,
  AAF_JOB_DRIVER: z.enum(["local", "trigger"]).default("local"),
  AAF_TRIAGE_MODE: z.enum(["job", "inline"]).default("job"),
  AAF_CRON_SECRET: optStr, // authorises /api/jobs/tick (scheduler)
});
export type Env = z.infer<typeof EnvSchema>;

/** True for a real production runtime. The e2e override is honoured only off Vercel. */
export function isProd(env: Env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.AAF_RUNTIME_MODE === "e2e") {
    if (env.VERCEL_ENV) throw new Error("AAF_RUNTIME_MODE=e2e is forbidden on Vercel");
    return false;
  }
  return true;
}

export interface ConfigProblem {
  key: string;
  problem: string;
}

/** Returns problems by variable NAME only. Values are never echoed. */
export function productionProblems(env: Env): ConfigProblem[] {
  const p: ConfigProblem[] = [];
  if (env.AAF_RUNTIME_MODE === "e2e") p.push({ key: "AAF_RUNTIME_MODE", problem: "test-only mode is active: embedded database and development auth are enabled" });
  const need = (k: keyof Env, why: string) => { if (!env[k]) p.push({ key: k, problem: `required in production: ${why}` }); };
  need("DATABASE_URL", "Supabase Postgres pooler URL for the aaf_app role");
  need("NEXT_PUBLIC_SUPABASE_URL", "Supabase Auth");
  need("NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase Auth");
  need("AAF_APP_ORIGIN", "origin allow-list for CSRF checks");
  if (env.AAF_AUTH_PROVIDER === "local") p.push({ key: "AAF_AUTH_PROVIDER", problem: "the local development auth provider is forbidden in production" });
  if (env.AAF_JOB_DRIVER === "trigger") need("TRIGGER_SECRET_KEY", "Trigger.dev job driver");
  return p;
}

let cached: Env | undefined;
export function getEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  if (raw === process.env && cached) return cached;
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}`);
  }
  if (raw === process.env) cached = parsed.data;
  return parsed.data;
}

export function authProviderName(env: Env): "supabase" | "local" | "none" {
  if (env.AAF_AUTH_PROVIDER === "supabase" || (!env.AAF_AUTH_PROVIDER && env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    return env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "supabase" : "none";
  }
  if (isProd(env)) return "none";
  return "local";
}
