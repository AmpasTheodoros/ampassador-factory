-- R1 foundation schema. Runs unchanged on Supabase Postgres and on PGlite (local dev/tests).
-- Requires an `auth.uid()` function (Supabase provides it; local bootstrap stubs it).

create table workspaces (
  id uuid primary key,
  name text not null,
  kind text not null default 'personal' check (kind in ('personal','client')),
  data_policy text not null default 'cloud_allowed' check (data_policy in ('cloud_allowed','redact_then_cloud','local_only')),
  monthly_budget_eur numeric not null default 20,
  created_at timestamptz not null default now()
);

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','member','viewer')),
  primary key (workspace_id, user_id)
);

create or replace function app_role(ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from memberships where workspace_id = ws and user_id = auth.uid()
$$;

create table integration_connections (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connector text not null,
  status text not null check (status in ('connected','not_connected','demo','error')),
  scopes text[] not null default '{}',
  detail text,
  updated_at timestamptz not null default now(),
  unique (workspace_id, connector)
);

create table source_events (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source text not null,
  external_id text,
  type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  correlation_id text not null,
  payload_version int not null,
  payload jsonb not null,
  dedupe_key text not null,
  is_demo boolean not null default false,
  unique (workspace_id, dedupe_key)
);

create table inbox_items (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_id uuid not null references source_events(id),
  title text not null,
  summary text,
  contact_name text,
  contact_email text,
  intent text,
  action_class text check (action_class in ('act_now','schedule','follow_up','monitor','save_idea','ignore')),
  status text not null default 'new' check (status in ('new','triaged','actioned','dismissed')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table action_recommendations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  inbox_item_id uuid references inbox_items(id),
  action_class text not null,
  title text not null,
  why jsonb not null,
  confidence numeric not null check (confidence between 0 and 1),
  urgency int not null check (urgency between 0 and 10),
  impact int not null check (impact between 0 and 10),
  effort int not null check (effort between 0 and 10),
  score numeric not null,
  provenance jsonb not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  due_at timestamptz,
  source_ref text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table approvals (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tool_id text not null,
  risk_tier text not null,
  payload jsonb not null,
  payload_hash text not null,
  status text not null check (status in ('proposed','awaiting_approval','approved','rejected','expired','executing','succeeded','failed')),
  summary text not null,
  source_context jsonb not null default '{}',
  requested_by text not null,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table action_execution_receipts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  approval_id uuid not null references approvals(id),
  attempt int not null,
  ok boolean not null,
  result jsonb,
  error text,
  executed_by text not null,
  executed_at timestamptz not null default now(),
  unique (approval_id, attempt)
);

create table tool_calls (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tool_id text not null,
  risk_tier text not null,
  actor text not null,
  outcome text not null check (outcome in ('executed','queued_for_approval','denied','failed')),
  input_hash text not null,
  detail text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create table workflow_runs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  workflow text not null,
  status text not null check (status in ('queued','running','succeeded','failed','cancelled')),
  correlation_id text,
  input jsonb,
  output jsonb,
  error text,
  attempts int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table cost_events (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_id uuid,
  provider text not null,
  model text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_eur numeric not null default 0,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

create index on inbox_items (workspace_id, status);
create index on approvals (workspace_id, status);
create index on audit_log (workspace_id, created_at);
create index on action_recommendations (workspace_id, score desc);

-- Row level security: every table is workspace-scoped through memberships.
do $$
declare t text;
begin
  foreach t in array array['integration_connections','source_events','inbox_items','action_recommendations',
    'tasks','approvals','action_execution_receipts','tool_calls','workflow_runs','cost_events','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (app_role(workspace_id) is not null)', t || '_sel', t);
  end loop;
end $$;

alter table workspaces enable row level security;
create policy workspaces_sel on workspaces for select using (app_role(id) is not null);
alter table memberships enable row level security;
create policy memberships_sel on memberships for select using (user_id = auth.uid());

-- Members may write low-risk working data; never audit/receipts/tool_calls (server-only).
create policy tasks_ins on tasks for insert with check (app_role(workspace_id) in ('owner','admin','member'));
create policy tasks_upd on tasks for update using (app_role(workspace_id) in ('owner','admin','member'));
create policy inbox_ins on inbox_items for insert with check (app_role(workspace_id) in ('owner','admin','member'));
create policy events_ins on source_events for insert with check (app_role(workspace_id) in ('owner','admin','member'));
-- Only owner/admin may change an approval row (decide). Viewers/members cannot self-approve.
create policy approvals_upd on approvals for update using (app_role(workspace_id) in ('owner','admin'))
  with check (app_role(workspace_id) in ('owner','admin'));
