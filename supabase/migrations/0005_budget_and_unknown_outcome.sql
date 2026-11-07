-- R1.6: (1) concurrency-safe model budget (reserve -> settle/release), (2) cost provenance, (3) "outcome unknown" approvals.

-- ---------------------------------------------------------------- cost provenance
-- usage_estimate           tokens reported by the provider x the operator-configured price
-- usage_estimate_unpriced  tokens x the pessimistic DEFAULT price (no price configured)
-- unconfirmed_charge       worst-case reserve charged because the call's outcome is unknown (timeout, invalid output, crash)
-- confirmed_billing        reserved for amounts imported from a provider invoice/usage API; nothing writes it yet
alter table cost_events add column kind text not null default 'usage_estimate'
  check (kind in ('usage_estimate','usage_estimate_unpriced','unconfirmed_charge','confirmed_billing'));
alter table cost_events add column reservation_id uuid;

create table budget_reservations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  amount_eur numeric not null check (amount_eur >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz
);
create index on budget_reservations (workspace_id) where settled_at is null;
alter table budget_reservations enable row level security;
create policy budget_res_u_sel on budget_reservations for select to authenticated using (app_role(workspace_id) is not null);
create policy budget_res_s_sel on budget_reservations for select to aaf_service using (workspace_id = aaf_ws());
grant select on budget_reservations to authenticated, aaf_service;
-- no direct writes by anyone: only the SECURITY DEFINER functions below

create or replace function app_budget_assert(p_ws uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  -- NULL-safe on purpose: with no workspace pinned aaf_ws() is NULL, and `NULL or false` is NULL, which would skip the raise.
  if not (coalesce(p_ws = aaf_ws(), false) or coalesce(app_can_write(p_ws), false)) then raise exception 'not authorised for workspace'; end if;
end $$;

-- Any reservation whose call never settled (crash, lost connection) is charged at its reserved worst case once it expires.
create or replace function app_budget_sweep(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id, amount_eur from budget_reservations where workspace_id = p_ws and settled_at is null and expires_at <= now() for update loop
    insert into cost_events(id, workspace_id, run_id, provider, model, tokens_in, tokens_out, cost_eur, kind, reservation_id)
      values (gen_random_uuid(), p_ws, null, 'unknown', null, 0, 0, r.amount_eur, 'unconfirmed_charge', r.id);
    update budget_reservations set settled_at = now() where id = r.id;
  end loop;
end $$;

-- Atomic: serialised per workspace by an advisory lock, so N concurrent callers cannot all pass the check.
create or replace function app_budget_reserve(p_ws uuid, p_id uuid, p_amount numeric, p_ttl_s int default 120) returns boolean
language plpgsql security definer set search_path = public as $$
declare b numeric; spent numeric; held numeric;
begin
  perform app_budget_assert(p_ws);
  perform pg_advisory_xact_lock(hashtextextended(p_ws::text, 4242));
  perform app_budget_sweep(p_ws);
  select monthly_budget_eur into b from workspaces where id = p_ws;
  if b is null then raise exception 'unknown workspace'; end if;
  select coalesce(sum(cost_eur), 0) into spent from cost_events where workspace_id = p_ws and created_at >= date_trunc('month', now());
  select coalesce(sum(amount_eur), 0) into held from budget_reservations where workspace_id = p_ws and settled_at is null;
  if spent + held + p_amount > b then return false; end if;
  insert into budget_reservations(id, workspace_id, amount_eur, expires_at) values (p_id, p_ws, p_amount, now() + make_interval(secs => p_ttl_s))
    on conflict (id) do nothing;
  return true;
end $$;

-- Close a reservation and record the actual cost (kind says how trustworthy the number is).
create or replace function app_budget_settle(p_ws uuid, p_id uuid, p_provider text, p_model text, p_tin int, p_tout int, p_cost numeric, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_budget_assert(p_ws);
  perform pg_advisory_xact_lock(hashtextextended(p_ws::text, 4242));
  update budget_reservations set settled_at = now() where id = p_id and workspace_id = p_ws and settled_at is null;
  insert into cost_events(id, workspace_id, run_id, provider, model, tokens_in, tokens_out, cost_eur, kind, reservation_id)
    values (gen_random_uuid(), p_ws, null, p_provider, p_model, p_tin, p_tout, p_cost, p_kind, p_id);
end $$;

-- The call provably did not happen (rejected before inference): free the reservation, record nothing.
create or replace function app_budget_release(p_ws uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_budget_assert(p_ws);
  perform pg_advisory_xact_lock(hashtextextended(p_ws::text, 4242));
  update budget_reservations set settled_at = now() where id = p_id and workspace_id = p_ws and settled_at is null;
end $$;

revoke execute on function app_budget_assert(uuid), app_budget_sweep(uuid) from public, anon, authenticated, aaf_service;
grant execute on function app_budget_reserve(uuid, uuid, numeric, int), app_budget_settle(uuid, uuid, text, text, int, int, numeric, text), app_budget_release(uuid, uuid) to authenticated, aaf_service;

-- ---------------------------------------------------------------- approvals: an execution that may have happened
-- 'unknown_outcome': the external effect might have occurred (timeout/crash mid-send). It is NEVER retried automatically;
-- an operator reconciles it (delivered / not delivered).
alter table approvals drop constraint approvals_status_check;
alter table approvals add constraint approvals_status_check
  check (status in ('proposed','awaiting_approval','approved','rejected','expired','executing','succeeded','failed','unknown_outcome'));

-- When execution started: lets a sweep find executions whose worker died mid-flight.
alter table approvals add column executing_at timestamptz;
