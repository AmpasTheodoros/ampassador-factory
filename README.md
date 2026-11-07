# Command Center (Theodoros AI Company OS)

Build spec: `embedded_ai_company_os_master_prompt.md`. Docs: `docs/` (start with `architecture.md`, `security-and-approvals.md`, `deployment.md`, `networkradar-connectivity.md`).

**Status: R1.5, built and tested locally, not deployed.** `docs/roadmap.md` lists what is unverified.

## Run locally (no external services)

```bash
pnpm install
cp apps/command-center/.env.example apps/command-center/.env.local     # set AAF_DEV_EMAIL / AAF_DEV_PASSWORD
pnpm --filter @aaf/command-center dev                                   # http://localhost:3000
```

Local development uses an embedded PostgreSQL (data in `apps/command-center/.data/pglite`) and a development-only sign-in. With no model configured, classification is rule-based and drafts come from templates. Approved replies are exported as `.eml`; the system never sends email.

## Verify

```bash
pnpm typecheck
pnpm test        # unit + integration + RLS over the pg wire driver + migration CLI
pnpm --filter @aaf/command-center build
pnpm --filter @aaf/command-center exec playwright install chromium     # once
pnpm --filter @aaf/command-center e2e
# opt-in, need credentials, bounded and side-effect free:
AAF_SMOKE_AI=1 <model env vars> pnpm --filter @aaf/brain test
AAF_SMOKE_NETWORKRADAR=1 NETWORKRADAR_MCP_URL=... NETWORKRADAR_MCP_API_KEY=... pnpm --filter @aaf/integrations test
```

## Production

Supabase Postgres (least-privileged `aaf_app` role, RLS enforced), Supabase Auth, Vercel, optional Trigger.dev. Step-by-step, environment table, secret handling and rollback: `docs/deployment.md`. Migrations: `pnpm db:migrate` with `DATABASE_ADMIN_URL` (never in the app environment).

## What works

Sign in; paste a message; a durable job classifies it (rules, plus a model if configured) and drafts a reply; you review labelled provenance (AI-generated / rule-based / template / unverified / verified); approve (exports an `.eml`) or reject; the job resumes and a follow-up task appears; Operations shows jobs, approvals, model cost, tool history and integration health. A second user sees none of it.
