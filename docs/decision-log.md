# Decision log

| # | Decision | Why | Revisit when |
|---|---|---|---|
| 1 | Repo was empty (no commits), so greenfield pnpm + Turborepo monorepo | Nothing to preserve | - |
| 2 | PGlite for local runtime and tests, running the same SQL as Supabase | Real Postgres semantics (RLS, triggers, jsonb) with no external service; lets RLS be tested here | R2: switch the app to Supabase when credentials exist; keep PGlite for tests |
| 3 | Domain code does not use the Vercel AI SDK; model access is a small `LlmProvider` over any OpenAI-compatible endpoint | Spec says verify SDK APIs first; no credentials to verify against. The interface lets the AI SDK / Gateway be added as a provider without touching domain code | When a real provider key is available |
| 4 | Deterministic classifier + template drafts in R1 | Works with zero cost/connectors, testable, explains itself. It is a keyword classifier: English plus a little Greek, **will misjudge nuanced messages**. Eval set exists to catch regressions, not to claim accuracy | When corrections accumulate |
| 5 | One real agent (Chief of Staff) | Spec: do not create fake agents | - |
| 6 | Approvals live in `@aaf/tools` | Lifecycle and gateway share the same invariants; splitting adds indirection | If approvals gain independent consumers |
| 7 | Trigger.dev not added in R1 | Workflows run inline in server actions and are short; no schedule exists yet. Adding the engine without a real long-running task would be speculative | R2 (scheduled brief, sync) |
| 8 | shadcn/ui not added; plain Tailwind components | Fewer dependencies for R1 | When component count justifies it |
| 9 | Email export instead of send | Gmail adapter not built; honest `delivered: false` | R2 |
| 10 | Spec docs `integrations.md`, `agent-and-skill-registry.md`, `operations-runbook.md`, `deployment.md` folded into `architecture.md`, README and the Agents page | Avoid docs that restate code | When they carry independent content |

## R1.5

| # | Decision | Why | Revisit when |
|---|---|---|---|
| 11 | App connects as `aaf_app` and switches role per transaction (authenticated / anon / aaf_service); direct Postgres, not PostgREST | RLS enforced for real requests without the service-role key; one transaction per request keeps SET LOCAL safe on a transaction pooler | If a per-request JWT path (supabase-js) is preferred |
| 12 | Service role is tenant-pinned by a GUC, not a global bypass | Jobs need writes users cannot do (receipts, job state) but must stay inside one tenant | When a cross-tenant scheduler is needed (needs its own narrow function) |
| 13 | Supabase Auth in production, a separate local provider in development, chosen by config; local forbidden in production | Dev must work offline; prod must not | - |
| 14 | Test-only `AAF_RUNTIME_MODE=e2e` lets browser tests run a production build on the embedded DB; refused on Vercel; readiness fails while set | `next start` forces NODE_ENV=production and real Supabase is unavailable here | When CI has a real Postgres plus Auth |
| 15 | PGlite kept for tests and local dev; `embedded-postgres` tried and abandoned | Its beta Windows binary accepted TCP but never completed a handshake; time-boxed | When CI can use a Postgres service container |
| 16 | AI via the Vercel AI SDK (`ai` 7) with structured output; model ids are configuration; pessimistic default prices | Spec; keeps the budget binding when prices are unknown | After the first real calls |
| 17 | The model never decides authority; rules always run; fixed reconciliation; opt-out wins | Safety over model quality | After the eval set has real corrections |
| 18 | Own durable queue (Postgres skip-locked + leases) behind a dispatcher; Trigger.dev is a dispatcher, not a rewrite | Tested locally today; Trigger.dev can run the same handlers | When Trigger.dev is configured |
| 19 | Cost rows are deferred and written after the transaction | A rolled-back job must not erase its spend | - |
| 20 | NetworkRadar via its existing MCP over Streamable HTTP, with client-side read-only enforcement | It is the only machine contract that exists; the server cannot scope keys | When NetworkRadar gains a read-only key or REST API |
