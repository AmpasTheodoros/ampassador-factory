/**
 * Validates the environment that a deployment WOULD have, before deploying. Names only: values are never printed.
 *
 *   pnpm --filter @aaf/command-center check:env -- preview     (reads process.env, e.g. after `vercel env pull .env.preview`)
 *   node --env-file=.env.preview ... check-env.mts production
 *
 * Exit 0 = acceptable, 1 = problems. Rules come from src/lib/config.ts (the same code the app runs at start-up).
 */
import { EnvSchema, productionProblems, authProviderName } from "../src/lib/config";

const target = process.argv[2] === "production" ? "production" : "preview";
const raw = { ...process.env, NODE_ENV: "production" } as NodeJS.ProcessEnv;
const parsed = EnvSchema.safeParse(raw);
const problems: string[] = [];

if (!parsed.success) {
  for (const n of new Set(parsed.error.issues.map((i) => String(i.path[0])))) problems.push(`${n}: invalid value`);
} else {
  const e = parsed.data;
  for (const p of productionProblems(e)) problems.push(`${p.key}: ${p.problem}`);
  if (authProviderName(e) !== "supabase") problems.push("auth: Supabase Auth is not configured");
  // credentials that must NEVER be in the app's environment
  for (const forbidden of ["DATABASE_ADMIN_URL", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"])
    if (process.env[forbidden]) problems.push(`${forbidden}: must not be set in the app environment`);
  // the app's database user must be aaf_app, never postgres / the owner
  const url = e.DATABASE_URL ? new URL(e.DATABASE_URL) : undefined;
  if (url) {
    const user = decodeURIComponent(url.username);
    if (!/^aaf_app(\.|$)/.test(user))
      problems.push(`DATABASE_URL: user must be aaf_app (or aaf_app.<project-ref> on the Supabase pooler), found "${user.split(".")[0]}"`);
    if (url.port !== "6543" && /supabase\./.test(url.hostname))
      problems.push("DATABASE_URL: use the transaction pooler (port 6543) on Supabase");
  }
  if (e.AAF_APP_ORIGIN && !e.AAF_APP_ORIGIN.startsWith("https://")) problems.push("AAF_APP_ORIGIN: must be https");
  if (e.AAF_RUNTIME_MODE === "e2e") problems.push("AAF_RUNTIME_MODE=e2e is test-only");
  if (e.AAF_JOB_DRIVER === "trigger" && !e.TRIGGER_SECRET_KEY) problems.push("TRIGGER_SECRET_KEY: required by AAF_JOB_DRIVER=trigger");
  if ((e.AAF_AI_MODEL_CLASSIFY || e.AAF_AI_MODEL_DRAFT) && !e.AI_GATEWAY_API_KEY)
    problems.push("AI_GATEWAY_API_KEY: models configured but no key");
  if (e.AI_GATEWAY_API_KEY && (e.AAF_AI_PRICE_IN_PER_M === undefined || e.AAF_AI_PRICE_OUT_PER_M === undefined))
    problems.push("warning AAF_AI_PRICE_*: unset, a pessimistic default price will be used (budgets still bind)");
}

const errors = problems.filter((p) => !p.startsWith("warning "));
for (const p of problems) process.stdout.write(`${p.startsWith("warning ") ? "WARN " : "FAIL "}${p.replace(/^warning /, "")}\n`);
process.stdout.write(errors.length ? `\n${target}: NOT ready (${errors.length} problem(s))\n` : `\n${target}: environment acceptable\n`);
process.exit(errors.length ? 1 : 0);
