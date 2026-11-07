/** Runs once on server start: fail fast and loudly on an unsafe production configuration. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { EnvSchema, productionProblems } = await import("./lib/config");
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[config] invalid environment variables:", [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", "));
    return;
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.AAF_RUNTIME_MODE !== "e2e") {
    const problems = productionProblems(parsed.data);
    if (problems.length) console.error("[config] production configuration problems:", problems.map((p) => `${p.key}: ${p.problem}`).join("; "));
  }
}
