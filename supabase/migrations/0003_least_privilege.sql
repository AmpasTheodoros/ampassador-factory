-- R1.5: least-privilege data access.
--
-- Connection model (see docs/security-and-approvals.md):
--   * The app connects as a dedicated LOGIN role `aaf_app` that is NOT a superuser, NOT an owner and NOT BYPASSRLS.
--   * Per transaction it does `SET LOCAL ROLE authenticated` (end user) or `aaf_service` (internal job, tenant-scoped)
--     or `anon` (pre-login), and sets the verified user id as the JWT subject claim.
--   * Migrations run with a separate admin connection that the running app never holds.

do $$ begin
  if not exists (select from pg_roles where rolname = 'aaf_service') then create role aaf_service nologin; end if;
end $$;

-- Remove any blanket privileges (Supabase grants ALL on public tables to anon/authenticated by default).
revoke all on all tables in schema public from anon, authenticated, aaf_service;
revoke all on all sequences in schema public from anon, authenticated, aaf_service;
revoke execute on all functions in schema public from public, anon, authenticated, aaf_service;
grant usage on schema public to anon, authenticated, aaf_service;

create or replace function aaf_ws() returns uuid language sql stable as
$$ select nullif(current_setting('aaf.workspace_id', true), '')::uuid $$;

create or replace function app_can_write(ws uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from memberships where workspace_id = ws and user_id = auth.uid() and role in ('owner','admin','member')) $$;
create or replace function app_is_admin(ws uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from memberships where workspace_id = ws and user_id = auth.uid() and role in ('owner','admin')) $$;
create or replace function app_is_owner(ws uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from memberships where workspace_id = ws and user_id = auth.uid() and role = 'owner') $$;

-- Rate limiting that works across serverless instances. Callable before login (anon).
create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
alter table rate_limits enable row level security; -- no policies: only the SECURITY DEFINER function touches it

create or replace function app_rate_hit(p_key text, p_max int, p_window_s int) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s); h int;
begin
  insert into rate_limits(key, window_start, hits) values (p_key, w, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1 returning hits into h;
  delete from rate_limits where window_start < now() - interval '1 day';
  return h <= p_max;
end $$;

-- One personal workspace per user, created on first sign-in. The only way a membership row is ever created by the app.
create or replace function app_provision_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); ws uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select workspace_id into ws from memberships where user_id = uid and role = 'owner' order by workspace_id limit 1;
  if ws is not null then return ws; end if;
  ws := gen_random_uuid();
  insert into workspaces(id, name) values (ws, left(coalesce(nullif(trim(p_name), ''), 'Personal'), 100));
  insert into memberships(workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into audit_log(workspace_id, actor, action, entity, entity_id) values (ws, 'user:' || uid, 'workspace.provisioned', 'workspace', ws::text);
  return ws;
end $$;

grant execute on function aaf_ws(), app_role(uuid), app_can_write(uuid), app_is_admin(uuid), app_is_owner(uuid) to authenticated, aaf_service;
grant execute on function app_rate_hit(text, int, int) to anon, authenticated, aaf_service;
grant execute on function app_provision_workspace(text) to authenticated;

-- ---- policies: drop the permissive R1 ones, recreate scoped per role
drop policy if exists integration_connections_sel on integration_connections;
drop policy if exists source_events_sel on source_events;
drop policy if exists inbox_items_sel on inbox_items;
drop policy if exists action_recommendations_sel on action_recommendations;
drop policy if exists tasks_sel on tasks;
drop policy if exists approvals_sel on approvals;
drop policy if exists action_execution_receipts_sel on action_execution_receipts;
drop policy if exists tool_calls_sel on tool_calls;
drop policy if exists workflow_runs_sel on workflow_runs;
drop policy if exists cost_events_sel on cost_events;
drop policy if exists audit_log_sel on audit_log;
drop policy if exists workspaces_sel on workspaces;
drop policy if exists memberships_sel on memberships;
drop policy if exists tasks_ins on tasks;
drop policy if exists tasks_upd on tasks;
drop policy if exists inbox_ins on inbox_items;
drop policy if exists events_ins on source_events;
drop policy if exists approvals_upd on approvals;

do $$
declare t text;
begin
  foreach t in array array['integration_connections','source_events','inbox_items','action_recommendations',
    'tasks','approvals','action_execution_receipts','tool_calls','workflow_runs','cost_events','audit_log']
  loop
    execute format('create policy %I on %I for select to authenticated using (app_role(workspace_id) is not null)', t || '_u_sel', t);
    execute format('create policy %I on %I for select to aaf_service using (workspace_id = aaf_ws())', t || '_s_sel', t);
    execute format('create policy %I on %I for insert to aaf_service with check (workspace_id = aaf_ws())', t || '_s_ins', t);
    execute format('grant select on %I to authenticated, aaf_service', t);
  end loop;
end $$;

create policy workspaces_u_sel on workspaces for select to authenticated using (app_role(id) is not null);
create policy workspaces_s_sel on workspaces for select to aaf_service using (id = aaf_ws());
create policy workspaces_u_upd on workspaces for update to authenticated using (app_is_owner(id)) with check (app_is_owner(id));
create policy memberships_u_sel on memberships for select to authenticated using (user_id = auth.uid());
grant select on workspaces, memberships to authenticated;
grant select on workspaces to aaf_service;
grant update (name, data_policy, monthly_budget_eur) on workspaces to authenticated;

-- end-user writes (members and above); nobody can delete anything
create policy source_events_u_ins on source_events for insert to authenticated with check (app_can_write(workspace_id));
create policy inbox_items_u_ins on inbox_items for insert to authenticated with check (app_can_write(workspace_id));
create policy inbox_items_u_upd on inbox_items for update to authenticated using (app_can_write(workspace_id)) with check (app_can_write(workspace_id));
create policy recs_u_ins on action_recommendations for insert to authenticated with check (app_can_write(workspace_id));
create policy tasks_u_ins on tasks for insert to authenticated with check (app_can_write(workspace_id));
create policy tasks_u_upd on tasks for update to authenticated using (app_can_write(workspace_id)) with check (app_can_write(workspace_id));
create policy tool_calls_u_ins on tool_calls for insert to authenticated with check (app_can_write(workspace_id));
create policy runs_u_ins on workflow_runs for insert to authenticated with check (app_can_write(workspace_id));
create policy runs_u_upd on workflow_runs for update to authenticated using (app_can_write(workspace_id)) with check (app_can_write(workspace_id));
create policy cost_u_ins on cost_events for insert to authenticated with check (app_can_write(workspace_id));
create policy audit_u_ins on audit_log for insert to authenticated with check (app_can_write(workspace_id));
-- approvals: members can propose; only owner/admin can decide or execute
create policy approvals_u_ins on approvals for insert to authenticated with check (app_can_write(workspace_id));
create policy approvals_u_upd on approvals for update to authenticated using (app_is_admin(workspace_id)) with check (app_is_admin(workspace_id));
create policy receipts_u_ins on action_execution_receipts for insert to authenticated with check (app_is_admin(workspace_id));
create policy conn_u_ins on integration_connections for insert to authenticated with check (app_is_admin(workspace_id));
create policy conn_u_upd on integration_connections for update to authenticated using (app_is_admin(workspace_id)) with check (app_is_admin(workspace_id));

grant insert on source_events, inbox_items, action_recommendations, tasks, tool_calls, workflow_runs, cost_events, audit_log, approvals, action_execution_receipts, integration_connections to authenticated;
grant update on inbox_items, tasks, workflow_runs, approvals, integration_connections to authenticated;
grant usage on all sequences in schema public to authenticated, aaf_service;

-- internal (service) role: tenant-scoped by `aaf.workspace_id`, never cross-tenant, no deletes, no membership writes.
create policy workflow_runs_s_upd on workflow_runs for update to aaf_service using (workspace_id = aaf_ws()) with check (workspace_id = aaf_ws());
create policy approvals_s_upd on approvals for update to aaf_service using (workspace_id = aaf_ws()) with check (workspace_id = aaf_ws());
create policy tasks_s_upd on tasks for update to aaf_service using (workspace_id = aaf_ws()) with check (workspace_id = aaf_ws());
create policy inbox_s_upd on inbox_items for update to aaf_service using (workspace_id = aaf_ws()) with check (workspace_id = aaf_ws());
grant insert on source_events, inbox_items, action_recommendations, tasks, tool_calls, workflow_runs, cost_events, audit_log, approvals, action_execution_receipts to aaf_service;
grant update on inbox_items, tasks, workflow_runs, approvals to aaf_service;
