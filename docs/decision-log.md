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
