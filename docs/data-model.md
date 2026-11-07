# Data model (R1)

Migrations: `supabase/migrations/0001_init.sql`, `0002_approval_immutability.sql`. The same files run on Supabase and, with a local `auth.uid()` stub, on PGlite.

| Table | Purpose |
|---|---|
| `workspaces`, `memberships` | tenant + roles (`owner/admin/member/viewer`), `data_policy`, `monthly_budget_eur` |
| `integration_connections` | connector status and granted scopes (the gateway reads these) |
| `source_events` | typed event envelope; unique `(workspace_id, dedupe_key)` |
| `inbox_items` | triage surface; `is_demo` flag |
| `action_recommendations` | class, why (jsonb), confidence/urgency/impact/effort, score, provenance |
| `tasks` | follow-ups (no contact data is mirrored: NetworkRadar stays the system of record) |
| `approvals`, `action_execution_receipts` | lifecycle, immutable payload, one receipt per attempt |
| `tool_calls`, `audit_log`, `workflow_runs`, `cost_events` | observability, budget |

Not created yet (deliberately, to avoid empty tables): companies/contacts refs, deals, projects, knowledge/embeddings/pgvector, content, campaigns, experiments, evaluations tables, blueprint instances, local worker nodes. They arrive with the release that uses them.

Demo data: rows carry `is_demo`; approvals carry `source_context.isDemo`. The UI shows a DEMO badge. There is no `seed.sql`; demo data is loaded from the Overview button.

Ownership: contact identity belongs to NetworkRadar (not connected yet, so identity comes from the message header and is labelled unverified). Calendar to Google Calendar. No two-way sync exists.

## R1.5 additions

Migrations `0003_least_privilege.sql` and `0004_jobs.sql`.

| Object | Purpose |
|---|---|
| roles `anon`, `authenticated` (Supabase), `aaf_service` (created by 0003), `aaf_app` (created by `supabase/roles.example.sql`) | see security-and-approvals.md |
| `app_provision_workspace(name)` | the only way a workspace and owner membership are created |
| `app_role`, `app_can_write`, `app_is_admin`, `app_is_owner` (ws) | SECURITY DEFINER membership checks used by policies |
| `aaf_ws()` | reads `aaf.workspace_id`; pins the service role to one tenant |
| `rate_limits`, `app_rate_hit(key,max,window)` | distributed fixed-window limiter (function access only) |
| `jobs` | durable queue: status, idempotency key (unique per workspace), correlation id, attempts, run_at, lease, approval_id, resume_state, cancel_requested |
| `job_events` | append-only job history |

Policy shape: select = members; writes per role (member and above for working data; owner/admin for approval decisions, receipts and connections; owner for workspace policy); the service role gets the same tables for one workspace only, with no deletes. The development-only tables `dev_users` and `dev_sessions` are created by the embedded-database boot, not by migrations.
