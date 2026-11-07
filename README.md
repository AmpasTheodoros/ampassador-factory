# Command Center (Theodoros AI Company OS)

Build spec: `embedded_ai_company_os_master_prompt.md`. Docs: `docs/`.

## Run locally

```bash
pnpm install
cp apps/command-center/.env.example apps/command-center/.env.local   # set AAF_ADMIN_PASSWORD
pnpm --filter @aaf/command-center dev          # http://localhost:3000
```

Data persists in `apps/command-center/.data/pglite` (gitignored). Set `AAF_DATA_DIR=:memory:` for a throwaway database.
Without `AAF_ADMIN_PASSWORD` the dev server is open and shows a warning banner; a production build refuses all sign-ins.

## Verify

```bash
pnpm typecheck
pnpm test                                       # unit + integration (vitest)
pnpm --filter @aaf/command-center build
pnpm --filter @aaf/command-center exec playwright install chromium   # once
pnpm --filter @aaf/command-center e2e           # needs the build above
```

## Environment variables (names only)

`AAF_ADMIN_PASSWORD`, `AAF_SESSION_SECRET`, `AAF_OWNER_NAME`, `AAF_DATA_DIR`, `AAF_LLM_BASE_URL`, `AAF_LLM_MODEL`, `AAF_LLM_API_KEY`, `AAF_LLM_LOCATION`, and reserved for R2: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## Deploying

Not done and not verified. The R1 runtime uses an embedded Postgres (PGlite) on local disk, which is not suitable for serverless hosting. Deploying to Vercel requires the R2 switch of the data layer to Supabase (apply `supabase/migrations/*.sql` to a project in an EU region). Trigger.dev is not used yet.

## What works (R1)

Sign in, paste a message into the Inbox, see its classification with reasons and provenance, review a drafted reply in Approvals, approve (exports an .eml; nothing is sent) or reject (recorded as a correction), see receipts and audit trail, get a follow-up task, and read a ranked daily brief on Overview. See `docs/architecture.md` for the acceptance criteria and `docs/roadmap.md` for limitations.
