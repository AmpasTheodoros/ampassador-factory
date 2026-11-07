# Roadmap

| Release | Scope | State |
|---|---|---|
| R1 | Foundation: schema + RLS, tool gateway, approvals, inbox, W1 (manual input), W4 (brief), registry, UI shell | Built and tested |
| **R1.5** | Production foundation: least-privilege Postgres access, Supabase Auth, real AI integration, NetworkRadar adapter, durable jobs, observability, deployment readiness | **Built and tested locally. Not deployed. Live Supabase / model provider / NetworkRadar / Trigger.dev are unverified** |
| R2 | NetworkRadar live (after credential), Gmail drafts/read, Calendar read, sales lifecycle, W2, multi-user management | Not started |
| R3 | Content engine, W3, Metricool/Buffer adapter | Not started |
| R4 | Projects/ops/finance read-only, website experiments, events, marketing, evals loop, blueprints, local worker | Not started |

## Remaining blockers (need you)

1. A Supabase project (EU) and permission to run the migrations and create the `aaf_app` role.
2. A NetworkRadar credential, ideally a new read-only key (`docs/networkradar-connectivity.md`).
3. A model: an AI Gateway key plus model ids, or a local OpenAI-compatible server, to run the opt-in smoke test and set real prices.
4. Optionally Trigger.dev, Langfuse, Sentry and PostHog accounts.

## Recommended R2 order

1. Deploy a **Preview** with items 1-3 above and run the opt-in smokes; fix what the real services reveal.
2. NetworkRadar read-only key and live verification; then the Inbox shows verified records.
3. Gmail adapter: read threads and create drafts only (approval required), so replies stop being export-only.
4. Cross-workspace scheduler via an explicit, narrow function; nonce-based CSP; invitations and member management; MFA.
5. Move classification to model-first once the eval set holds real corrections (structure and harness are ready).
6. ESLint/Prettier (not configured yet) and a dependency-audit policy in CI.

## Known limitations (R1.5)

- Not deployed; nothing verified against live Supabase, a real model, NetworkRadar, Trigger.dev, Langfuse, Sentry or PostHog.
- A real non-superuser Postgres login role was not exercised in tests (embedded-server limitation); a start-up guard compensates.
- Single-user product surface (roles exist in the database; no invitation UI).
- The keyword classifier remains the fallback and safety floor; the eval set is synthetic.
- Costs use configured prices; with none configured a deliberately pessimistic estimate is used.
- A request holds one pooled connection for its whole duration, including model calls (15 s statement timeout, 20 s per model call).
- No ESLint/Prettier configuration; dependency audit is advisory.

## R1.6 status

Implemented and verified on a real local PostgreSQL 17; every Supabase/AI/NetworkRadar/Trigger.dev/Vercel item is BLOCKED on accounts or authorisation, see `docs/r1.6-validation-report.md` and `docs/staging-validation.md`. Next milestone: close those blockers (R1.6 live pass), then R2.
