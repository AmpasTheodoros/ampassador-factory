# Security and approvals

R1.5 changes the data-access model (section 1). The approval protections from R1 are unchanged and still tested (section 3).

## 1. Data access: least privilege, RLS actually enforced

**R1 flaw (fixed):** the server connected as the database owner, which bypasses RLS, so isolation depended only on every query passing `workspaceId`.

**Now:**

- The app connects as **`aaf_app`**: a login role that is not a superuser, not `BYPASSRLS`, owns no tables and has **no table privileges of its own** (`supabase/roles.example.sql`). In production the app calls `assertLeastPrivilege()` at start-up and refuses to serve if the role could bypass RLS.
- Every request runs in **one transaction** that does `SET LOCAL ROLE` to one of three roles and sets the verified user as the JWT subject:
  - `authenticated` + `sub = <server-verified user id>`: ordinary requests. RLS policies use `memberships` (via `SECURITY DEFINER` helpers `app_role`, `app_can_write`, `app_is_admin`, `app_is_owner`). Roles come **only** from the `memberships` table, never from token metadata.
  - `anon`: pre-login (rate limiter, local dev identity store). Can read nothing in the application schema.
  - `aaf_service` + `aaf.workspace_id = <one workspace>`: internal job execution, cost flush, operator replay. Its policies are pinned to that single workspace id; it cannot read or write another tenant, cannot delete, cannot touch `memberships`.
- `0003_least_privilege.sql` first **revokes everything** from `anon`/`authenticated` (Supabase grants broad defaults), then grants exactly what is used. Nobody has `DELETE` anywhere. `audit_log` and `job_events` are append-only by trigger. `approvals.payload`/`payload_hash`/`tool_id` are immutable by trigger. Users may only set `jobs.cancel_requested` (column-level grant).
- Workspace creation/membership is only possible through `app_provision_workspace()` (one personal workspace per user). There is no code path that lets a client choose a role or workspace.
- Workspace policy columns (`data_policy`, `monthly_budget_eur`) are owner-only.

**Tested (no mocks of the access path):** `packages/database/src/production-path.test.ts` runs the same 12 scenarios through (a) the in-process driver and (b) the real `pg` pool over the Postgres wire protocol: cross-tenant reads (tasks, approvals, audit, connections, events, workspaces, receipts), cross-tenant writes and forged audit rows, approval tamper/decide by other tenants, viewer/member/owner permissions, no delete/rewrite/membership edits, service-role confinement, anon isolation, SQL-injection-shaped user ids, rollback, migration reproducibility, and the start-up privilege guard. `packages/jobs` repeats the tenant checks for the job system, and the Playwright suite checks it through the browser with two real users. **Mutation check:** weakening the approval-update policy, the service-role policy and the jobs column grant each made tests fail on both drivers.

**What this does not prove (be aware):**

- The test databases run on an embedded Postgres whose single connection is privileged; isolation there comes from `SET LOCAL ROLE` to non-privileged roles (RLS applies to those roles). A real non-superuser **login** role was not exercised, because the bundled real-Postgres binary I tried would not complete a handshake. The start-up guard is the compensating control; it is unit-tested only for the failing case.
- `aaf_app` is a member of `anon`, `authenticated` and `aaf_service`, so SQL running as it could `SET ROLE` between them. The app issues only parameterised statements (no user-built SQL), and `aaf_service` is workspace-pinned by a GUC the caller sets, so a SQL-injection bug would let an attacker pick the workspace. This is the same trust model as Supabase's own `authenticator` role. Keep all SQL parameterised.
- Supabase's Data API (PostgREST) must be disabled for the application schema; otherwise signed-in users could write rows such as `audit_log` for their own workspace directly.
- Tested only against embedded Postgres, never against a live Supabase project.

## 2. Authentication

| Item | State |
|---|---|
| Provider | **Supabase Auth** in production (`createSupabaseAuth`). `getUser()` asks the Auth server to validate the JWT; only `id` and `email` are used (`user_metadata`/`app_metadata` are ignored; tested). |
| Development | A separate local provider with scrypt-hashed passwords and **revocable, expiring, hashed DB sessions** (12 h). Forbidden in production by config validation. |
| Sessions | Supabase: JWT expiry + refresh via `proxy.ts`; sign-out uses `scope: "global"`. Local: server-side revocation proven by replaying a copied cookie after sign-out (E2E). Cookies: httpOnly, SameSite=Lax, Secure + `__Host-` in production. |
| Rate limiting | Login: 20 / 5 min per IP and 8 / 5 min per account; every request: 240 reads / 60 writes per minute per user; tool calls per tool per workspace. All in Postgres (`app_rate_hit`), so they hold across serverless instances. |
| CSRF | Next server actions check Origin vs Host; additionally every mutating action calls `assertSameOrigin()` against `AAF_APP_ORIGIN`. Not browser-tested with a hostile origin (needs the action id); covered by Next's built-in check plus this guard. |
| Headers | CSP (`frame-ancestors 'none'`, `form-action 'self'`), `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy, HSTS in production. CSP still allows inline scripts. |
| Escalation | Roles come from `memberships` only; there is no endpoint that writes memberships. |
| Not done | Account recovery, MFA enforcement, invitations/multi-user management UI, audit of failed logins beyond the counter. Supabase Auth itself is **unverified against a live project**. |

## 3. Tools, risk tiers and approvals (unchanged from R1)

Risk tiers: `read`, `draft`, `write_low`, `external_communication`, `financial_or_irreversible`. The **tier is authoritative**: external and financial tools always queue an approval even if a tool declares `approvalPolicy: "never"` (tested). Financial also needs the payload hash echoed back.

Lifecycle: `awaiting_approval -> approved | rejected | expired -> executing -> succeeded | failed`. Compare-and-set transitions; only owner/admin decide; execution re-hashes the payload, rechecks expiry, schema, connector status and scopes; bounded retries with backoff and a receipt per attempt; failed approvals are the dead-letter queue; replay is owner/admin only and reuses the approval id as the idempotency key. Rate limits are now DB-backed.

## 4. Untrusted content and models

- Inbound text is data. The recipient is always the sender header. Drafts from a model are fenced, must satisfy a Zod schema, and are **rejected if they contain any email address or URL** (even one copied from the incoming message: a test found that allowing copied addresses let a hostile message steer a compliant model; fixed), placeholders, or prompt leakage. A rejected draft falls back to the template.
- The model only supplies an intent label and a rationale. Intent maps to fixed scores; it cannot choose tools, recipients or approvals. Opt-outs are honoured if either the rules or the model detect them.
- Routing: `local_only` never falls back to a cloud provider; `redact_then_cloud` masks emails/phones (regex, a minimum, not a privacy guarantee); input is truncated; every call is bounded by timeout, retries, output tokens, and a **worst-case budget check before the call**. Spend is recorded in its own transaction after the request/job ends, so a rollback cannot hide spend.
- UI labels: AI-generated / Rule-based / AI + rules / Template-generated / Unverified / Verified record. "Verified" is only ever shown for an exact NetworkRadar email match.

## 5. Telemetry

Optional Langfuse (model, tokens, cost, latency, outcome; **no prompts or completions**), Sentry (errors), PostHog (events). A sanitiser drops keys such as password/token/body/subject/email/prompt, masks emails, phones and secret-shaped strings, truncates, bounds depth, and pseudonymises workspace ids. Sink failures never reach the app. Sentry's own default PII settings were not audited.

## 6. Secrets

Environment only (Vercel Sensitive variables). Names are listed in `.env.example`/`deployment.md`. The app never receives the Supabase service-role key or the migration/admin database URL.
