/** Runs once on server start: fail fast and loudly on an unsafe production configuration. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Node-only modules are imported here, inside the nodejs branch, so the Edge bundle never sees them.
  const { log } = await import("@aaf/telemetry");
  const { EnvSchema, productionProblems } = await import("./lib/config");
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    log.error("config.invalid_environment", { variables: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))] });
    return;
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.AAF_RUNTIME_MODE !== "e2e") {
    const problems = productionProblems(parsed.data);
    if (problems.length) log.error("config.production_problems", { problems });
  }
}
