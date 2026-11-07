# Staging validation runbook (R1.6 live pass)

Everything here is **not yet executed**. It needs accounts only the owner can create. Use a dedicated staging Supabase project in an EU region. Never point it at production customer data.

## 1. Supabase staging project
1. Create project (EU region). Disable the Data API (Settings > API) so no PostgREST surface exists.
2. As the owner (`postgres`), run `supabase/roles.example.sql` after editing the `aaf_app` password. It creates `aaf_app` (NOINHERIT, LOGIN, non-superuser).
3. Apply migrations with the owner URL: `DATABASE_ADMIN_URL=... pnpm db:migrate`. Expect 0001-0005 applied, rerun is a no-op.
4. Get the transaction pooler URL (port 6543, user `aaf_app.<project-ref>`).

## 2. Database suites against staging
```
AAF_TEST_BACKEND=staging AAF_STAGING_ADMIN_URL=<owner url> AAF_STAGING_APP_URL=<pooler url> \
AAF_STAGING_EXPECT_HOST=<project-ref> AAF_STAGING_ACK=data-will-be-added \
pnpm --filter @aaf/database --filter @aaf/jobs --filter @aaf/brain test
```
The harness refuses unless both hosts contain the expected ref and the ref does not look like production. Test rows use random UUIDs and cannot be deleted (audit is append-only).

## 3. Supabase Auth
Create users A and B (and optionally a viewer added to A's workspace with role `viewer`). Start the app with staging env (`pnpm --filter @aaf/command-center check:env -- preview` first), then:
```
STAGING_BASE_URL=... STAGING_USER_A_EMAIL=... STAGING_USER_A_PASSWORD=... STAGING_USER_B_EMAIL=... STAGING_USER_B_PASSWORD=... \
pnpm --filter @aaf/command-center e2e:staging
```
Expected: 8-9 tests pass (login errors identical, cookies, sign-out revocation, concurrent sessions, tampered cookies, cross-workspace isolation, API 401, viewer role, rate limit).

## 4. Opt-in smokes (each bounded, no side effects)
- AI: `AAF_SMOKE_AI=1` plus `AI_GATEWAY_API_KEY` and `AAF_AI_MODEL_CLASSIFY` (or `AAF_LLM_BASE_URL`/`AAF_LLM_MODEL`); budget capped at 0.05 / 0.10 EUR. Compare recorded cost to the provider dashboard to justify `confirmed_billing`.
- NetworkRadar: apply `docs/networkradar-readonly-key/*.patch` (needs the owner's authorisation), generate an `nrro_` key, then `AAF_SMOKE_NETWORKRADAR=1`. Never use the full-access key here.

## 5. Vercel Preview (do not deploy without authorisation)
Create a project under the team, set env per target (preview uses the staging Supabase only), enable Deployment Protection, no `DATABASE_ADMIN_URL` or service-role key. Run `check:env -- preview` against the pulled env, deploy only when authorised, then `verify:deployment <url>`. Rollback: promote the previous deployment. Watch logs and Sentry for PII.

## 6. Trigger.dev
Create a project, set `TRIGGER_SECRET_KEY` and `AAF_JOB_DRIVER=trigger`, run one real hosted task. Only then call it operational.
