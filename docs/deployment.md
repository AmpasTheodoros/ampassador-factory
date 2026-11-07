# Deployment, secrets, operations and rollback

**Nothing has been deployed.** This is the procedure and the checks, written so each step can be verified. Steps that need an account or credential are marked **[needs you]**.

## Topology

```
Browser -> Vercel (Next.js, server actions/route handlers) --pooler:6543--> Supabase Postgres (EU)
                         |                                   (role aaf_app -> SET LOCAL ROLE authenticated | anon | aaf_service)
                         +--> Supabase Auth (verify user server-side)
                         +--> model provider (AI Gateway or OpenAI-compatible) | NetworkRadar MCP (read-only)
Trigger.dev worker --pooler--> same database, same role, same handlers (optional; local engine otherwise)
```

The app never holds the Supabase service-role key or a database owner credential. **Do not set `SUPABASE_SERVICE_ROLE_KEY` in Vercel.**

## Environment variables

Secret = store as a Vercel *Sensitive* environment variable; never commit; separate values for Preview and Production.

| Name | Secret | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | prod | Supabase **transaction pooler** URL (port 6543), user `aaf_app.<project-ref>` |
| `NEXT_PUBLIC_SUPABASE_URL` | no (public) | prod | Supabase Auth |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no (public by design) | prod | Supabase Auth client key; grants nothing without a user session |
| `AAF_APP_ORIGIN` | no | prod | e.g. `https://command.example.com`; CSRF origin allow-list |
| `AAF_OWNER_NAME` | no | no | signature name in drafts |
| `DATABASE_POOL_MAX` | no | no | default 3 (serverless) |
| `AI_GATEWAY_API_KEY`, `AAF_AI_MODEL_CLASSIFY`, `AAF_AI_MODEL_DRAFT` | key yes | no | cloud models via Vercel AI Gateway (`provider/model` strings; none hardcoded) |
| `AAF_AI_PRICE_IN_PER_M`, `AAF_AI_PRICE_OUT_PER_M` | no | recommended | EUR per million tokens; if unset a pessimistic estimate is used so the budget still binds |
| `AAF_LLM_BASE_URL`, `AAF_LLM_MODEL`, `AAF_LLM_API_KEY`, `AAF_LLM_LOCATION` | key yes | no | any OpenAI-compatible endpoint (`cloud` or `local`) |
| `NETWORKRADAR_MCP_URL`, `NETWORKRADAR_MCP_API_KEY` | key yes | no | see `networkradar-connectivity.md` |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` | secret yes | no | AI traces (metadata only) |
| `SENTRY_DSN` | low | no | error reporting |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` | key public | no | product analytics |
| `AAF_JOB_DRIVER` (`local`\|`trigger`), `TRIGGER_SECRET_KEY` | key yes | no | background execution |
| `AAF_TRIAGE_MODE` (`job`\|`inline`) | no | no | default `job` |
| `AAF_CRON_SECRET` | yes | no | authorises `/api/jobs/tick` (embedded dev database only) |
| `DATABASE_ADMIN_URL` | **yes, high** | migration time only | direct connection with the owner role. **Never set in Vercel**; use it from your machine or a CI secret that only runs migrations |
| `AAF_RUNTIME_MODE` | no | **never in prod** | `e2e` is test-only; refused on Vercel; makes `/api/ready` fail |

`GET /api/ready` returns the *names* of missing/invalid production variables and database/schema state. Use it as the deploy gate.

## Procedure

1. **[needs you] Supabase project, EU region.** Note the project ref. Data residency: choose an EU region (e.g. `eu-central-1`) and record it in `decision-log.md`.
2. **Migrate** with the admin connection (direct, port 5432):
   `DATABASE_ADMIN_URL=... pnpm db:migrate -- --check` then `pnpm db:migrate`.
   Migrations are checksummed; editing an applied file is refused. They run in one transaction.
3. **Create the app role:** edit the password into `supabase/roles.example.sql` via `-v app_password=...` and run it once. Verify `rolsuper=f, rolbypassrls=f`.
4. **Close the REST door.** In Supabase, disable the Data API for the `public` schema (or do not expose it). The app talks to Postgres directly; leaving PostgREST on would let any signed-in user write append-only tables such as `audit_log`.
5. **Auth settings:** disable public sign-ups; create your user by invitation; set Site URL and redirect URLs to `AAF_APP_ORIGIN`; set a password policy; enable MFA if available. The first sign-in provisions a personal workspace (`app_provision_workspace`).
6. **Vercel:** set the variables above (Production and Preview separately). Set the function region near the database. First deploy a **Preview** (`vercel`), never straight to production.
7. **Gate:** `curl https://<preview>/api/ready` must be `200` with `config.ok`, `database.ok`, `schema.ok`. At startup in production the app also runs `assertLeastPrivilege()` and refuses to serve if the DB role is a superuser, `BYPASSRLS`, or owns tables.
8. **Smoke (preview):** sign in; paste a synthetic message; check classification labels, the approval, export, the job in Operations; confirm a second user sees nothing. Run the opt-in smokes (`AAF_SMOKE_AI=1`, `AAF_SMOKE_NETWORKRADAR=1`) from your machine with the same variables.
9. **[needs you] Trigger.dev (optional):** create a project, set `TRIGGER_PROJECT_REF`, add `DATABASE_URL` (same `aaf_app` role) and the `AAF_AI_*` / `NETWORKRADAR_*` variables to the Trigger environment, `npx trigger.dev deploy`, then set `AAF_JOB_DRIVER=trigger` and `TRIGGER_SECRET_KEY` in Vercel. The task file is a scaffold that has never run.
10. **Promote** the preview to production only after 7 and 8 pass.

## CI

`.github/workflows/ci.yml`: install (frozen lockfile), typecheck, unit/integration tests (includes RLS tests over the pg wire driver and the migration CLI), production build, Playwright. The opt-in smoke tests do not run in CI (no secrets there).

## Rollback

| Layer | Action | Notes |
|---|---|---|
| Application | Vercel *Instant Rollback* to the previous deployment | Safe because migrations are additive; the old code runs on the new schema |
| Behaviour flags (no redeploy of code, env change only) | `AAF_TRIAGE_MODE=inline` bypasses background jobs; `AAF_JOB_DRIVER=local` bypasses Trigger.dev; unset `AAF_AI_*` / `AI_GATEWAY_API_KEY` returns to rules + templates; unset `NETWORKRADAR_*` disconnects it | each is exercised by tests (fallbacks) |
| Database | **Forward-only.** Take a Supabase backup/PITR point *before* each `db:migrate`. To undo a bad migration, restore to that point or ship a corrective migration | write migrations expand/contract: add first, switch code, remove later |
| Credentials | rotate in the provider, update Vercel, redeploy | `DATABASE_URL` rotation: `alter role aaf_app password ...` |
| Emergency stop | revoke the `aaf_app` login (`alter role aaf_app nologin`) | the app fails closed; `/api/health` stays up, `/api/ready` goes 503 |

## Operations runbook (short)

- **A job is stuck "running":** its lease expires (60 s) and the next run reclaims it; if attempts are exhausted it becomes `dead` and appears under Operations. Replay is owner/admin only.
- **A dead job / failed approval:** open Operations -> Events for the trail; Replay re-queues with fresh attempts. Sends are idempotent per approval id.
- **Model budget reached:** model calls stop; classification and drafting continue on rules/templates. Raise `monthly_budget_eur` as the workspace owner.
- **Cost looks wrong:** Operations -> Model costs shows tokens and EUR per model; prices are only as good as `AAF_AI_PRICE_*`.
- **NetworkRadar shows *Needs connection*:** the connector detail names the cause (`unauthorized`, `transport`, `contract`, `not configured`).
- **Rate-limited at login:** limits are per IP (20/5 min) and per account (8/5 min), stored in Postgres, so they hold across serverless instances.

## Known deployment gaps

- Not deployed; Vercel/Supabase/Trigger.dev behaviour is unverified here.
- No scheduled fan-out across workspaces with the least-privileged role (deliberately no cross-tenant listing). Per-job dispatch plus Trigger.dev delayed re-runs cover retries; a cron-style sweep needs an explicit, narrowly-granted function (R2).
- CSP allows inline scripts (Next bootstrap); tighten with nonces.
- No Sentry PII review (v11 `dataCollection` options not audited); our own sanitiser runs first.
