-- Durable background jobs (executed locally or by Trigger.dev via the same handlers).

create table jobs (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type text not null,
  status text not null default 'queued' check (status in ('queued','running','waiting_approval','succeeded','failed','cancelled','dead')),
  idempotency_key text not null,
  correlation_id text not null,
  input jsonb not null default '{}',
  output jsonb,
  progress int not null default 0 check (progress between 0 and 100),
  progress_note text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_at timestamptz not null default now(),
  lease_until timestamptz,
  locked_by text,
  approval_id uuid references approvals(id),
  resume_state jsonb,
  error text,
  cancel_requested boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index on jobs (workspace_id, status, run_at);

create table job_events (
  id bigserial primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on job_events (job_id, id);

create trigger job_events_no_update before update or delete on job_events
  for each row execute function audit_log_immutable();

alter table jobs enable row level security;
alter table job_events enable row level security;

-- end users: read; enqueue (members+); request cancellation (members+, only that column)
create policy jobs_u_sel on jobs for select to authenticated using (app_role(workspace_id) is not null);
create policy jobs_u_ins on jobs for insert to authenticated with check (app_can_write(workspace_id));
create policy jobs_u_upd on jobs for update to authenticated using (app_can_write(workspace_id)) with check (app_can_write(workspace_id));
create policy job_events_u_sel on job_events for select to authenticated using (app_role(workspace_id) is not null);
grant select, insert on jobs to authenticated;
grant update (cancel_requested, updated_at) on jobs to authenticated;
grant select on job_events to authenticated;

-- internal runner: confined to one workspace
create policy jobs_s_sel on jobs for select to aaf_service using (workspace_id = aaf_ws());
create policy jobs_s_ins on jobs for insert to aaf_service with check (workspace_id = aaf_ws());
create policy jobs_s_upd on jobs for update to aaf_service using (workspace_id = aaf_ws()) with check (workspace_id = aaf_ws());
create policy job_events_s_sel on job_events for select to aaf_service using (workspace_id = aaf_ws());
create policy job_events_s_ins on job_events for insert to aaf_service with check (workspace_id = aaf_ws());
grant select, insert, update on jobs to aaf_service;
grant select, insert on job_events to aaf_service;
-- user-initiated enqueue also needs an event row
create policy job_events_u_ins on job_events for insert to authenticated with check (app_can_write(workspace_id));
grant insert on job_events to authenticated;
grant usage on all sequences in schema public to authenticated, aaf_service;
