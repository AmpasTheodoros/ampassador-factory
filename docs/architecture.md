# Architecture

Status: **R1.5 implemented locally and tested; not deployed.** R2-R4 planned (`roadmap.md`).

## Flow

```
manual input / (future) connectors
  -> makeEvent (typed envelope, dedupeKey)  -> source_events (unique per workspace+dedupeKey)
  -> inbox_items  -> durable job `w1.triage` (idempotent key triage:<item>)
  -> Brain: rules classify  +  optional model classify (structured output) -> fixed reconciliation policy
     -> scores/class/why/facts(verified|unverified)/provenance
  -> draft: model (validated, no links/addresses) or template
  -> ToolGateway.invoke -> denied | executed | queued_for_approval   (job parks: waiting_approval)
  -> human decision (owner/admin) -> ToolGateway.execute (re-hash, revalidate, bounded retry, receipts)
  -> follow-up task, audit_log (append-only), job resumes with the outcome and finishes
```

Every database interaction is a transaction as `authenticated` (a user request), `anon` (pre-login) or `aaf_service` (pinned to one workspace). See `security-and-approvals.md`.

## Packages

| Package | Responsibility | Tests |
|---|---|---|
| `@aaf/core` | ids, stable hashing, event envelope, risk tiers, errors | 3 |
| `@aaf/database` | SQL migrations, `Database` abstraction (`PgDatabase` pool for Supabase, `PgliteDatabase` for dev/tests), `Store`, migration runner + CLI | 38 |
| `@aaf/tools` | tool gateway + approval lifecycle, builtin tools | 19 |
| `@aaf/brain` | classifier, AI SDK provider, model router (policy, budget, redaction), drafts, W1/W4, provider config, eval set | 36 (+1 opt-in) |
| `@aaf/jobs` | durable queue, runner, handlers, dispatchers (local, Trigger.dev), NetworkRadar status refresh | 28 |
| `@aaf/integrations` | NetworkRadar read-only MCP adapter | 10 (+1 opt-in) |
| `@aaf/telemetry` | sanitiser, sinks (Langfuse, Sentry, PostHog), no-op default | 9 |
| `@aaf/registry` | departments A-N, agents, skills, blueprints | 7 |
| `apps/command-center` | Next.js UI, Supabase/local auth, request context, actions | 16 + 7 E2E |

## Connector matrix (what is actually true)

| Connector | State | Detail |
|---|---|---|
| Supabase Postgres | **Code ready, never run against a live project** | `PgDatabase` + migrations CLI + roles script. Proven over the pg wire protocol on an embedded server. |
| Supabase Auth | **Code ready, unverified live** | Provider tested with a fake client. Development uses a separate local provider. |
| Model provider | **Code ready, never called a real provider** | AI SDK (`ai` 7.x) via AI Gateway string or OpenAI-compatible endpoint. Tested through the SDK's own mock model. Opt-in smoke test exists (`AAF_SMOKE_AI=1`); no key/local server was available here. |
| NetworkRadar | **Blocked on a credential** | Adapter proven against a local mock. See `networkradar-connectivity.md`. |
| Trigger.dev | **Scaffold only** | Dispatcher + task typed against SDK 4.x; no project, never run. Local engine is the tested path. |
| Langfuse / Sentry / PostHog | **Optional, constructed only when credentialled** | Sanitiser and sinks unit-tested with fakes; not run against the services. |
| Gmail, Google Calendar, GitHub, Drive, Metricool/Buffer | **Not built** | Tools exist only as gated stubs (`gmail.*`). Replies are exported as `.eml`, never sent. |

## Acceptance criteria and where each is proven

R1 criteria 1-12 still hold (see git history of this file); the R1.5 additions:

13. Requests run as non-owner roles and RLS is enforced end-to-end, including cross-tenant read/write/approve/audit/job attempts. (`production-path.test.ts` x2 drivers, `jobs.test.ts`, E2E two-user test)
14. Production start fails closed without configuration; the test-only mode cannot look ready. (`config.test.ts`, manual prod start, E2E `/api/ready`)
15. Sessions expire and are revocable; login is rate limited; metadata cannot grant roles. (`auth.test.ts`, E2E)
16. Model calls are bounded and accounted: schema-validated, timeout/failure fall back to rules/templates, worst-case budget refusal, `local_only` fail-closed, redaction, spend survives rollback. (`ai.test.ts`)
17. Hostile content cannot steer drafts (found and fixed: copied addresses). (`ai.test.ts`, E2E)
18. UI distinguishes AI / rules / template / unverified / verified. (E2E asserts the labels; nothing is "verified" without an exact record)
19. Jobs: idempotent enqueue, lease/crash recovery, backoff, dead-letter, cancel, replay, approval pause/resume, workspace pinning. (`jobs.test.ts`, `handlers.test.ts`)
20. Migrations are reproducible and checksummed; the CLI works over the wire. (`production-path.test.ts`, `migrate-cli.test.ts`)
21. Telemetry cannot leak secrets/PII and cannot break the app. (`telemetry.test.ts`)
