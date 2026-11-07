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
