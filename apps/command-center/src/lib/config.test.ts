import { describe, it, expect } from "vitest";
import { EnvSchema, isProd, productionProblems, authProviderName, getEnv, type Env } from "./config";

const env = (o: Record<string, string | undefined>): Env => EnvSchema.parse({ ...o });
const PROD_OK = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://aaf_app:x@pooler.supabase.com:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  AAF_APP_ORIGIN: "https://cc.example.com",
};

describe("production configuration guard", () => {
  it("a complete production config has no problems", () => {
    expect(productionProblems(env(PROD_OK))).toEqual([]);
    expect(isProd(env(PROD_OK))).toBe(true);
  });
  it("missing pieces are named (by variable, never value)", () => {
    const p = productionProblems(env({ NODE_ENV: "production" }));
    expect(p.map((x) => x.key).sort()).toEqual([
      "AAF_APP_ORIGIN",
      "DATABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
    expect(JSON.stringify(p)).not.toContain("postgres://");
  });
  it("the development auth provider is forbidden in production", () => {
    expect(productionProblems(env({ ...PROD_OK, AAF_AUTH_PROVIDER: "local" })).map((x) => x.key)).toContain("AAF_AUTH_PROVIDER");
    expect(authProviderName(env({ NODE_ENV: "production", AAF_AUTH_PROVIDER: "local" }))).toBe("none");
  });
  it("without Supabase config: production is closed, development uses the local provider", () => {
    expect(authProviderName(env({ NODE_ENV: "production" }))).toBe("none");
    expect(authProviderName(env({ NODE_ENV: "development" }))).toBe("local");
    expect(authProviderName(env(PROD_OK))).toBe("supabase");
  });
  it("the test-only e2e mode is not production, is reported as a problem, and is refused on Vercel", () => {
    const e = env({ NODE_ENV: "production", AAF_RUNTIME_MODE: "e2e" });
    expect(isProd(e)).toBe(false);
    expect(productionProblems(e).map((x) => x.key)).toContain("AAF_RUNTIME_MODE");
    expect(() => isProd(env({ NODE_ENV: "production", AAF_RUNTIME_MODE: "e2e", VERCEL_ENV: "production" }))).toThrow(/forbidden on Vercel/);
  });
  it("trigger driver requires its secret; invalid values fail by name only", () => {
    expect(productionProblems(env({ ...PROD_OK, AAF_JOB_DRIVER: "trigger" })).map((x) => x.key)).toContain("TRIGGER_SECRET_KEY");
    expect(() =>
      getEnv({ NODE_ENV: "production", DATABASE_POOL_MAX: "9999", AAF_LLM_BASE_URL: "not a url" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_POOL_MAX, AAF_LLM_BASE_URL/);
  });
});
