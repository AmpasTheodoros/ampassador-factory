-- An approval authorises one exact payload. Once inserted, the payload, its hash and the tool cannot change.
create or replace function approvals_payload_immutable() returns trigger language plpgsql as $$
begin
  if new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash
     or new.tool_id is distinct from old.tool_id
     or new.workspace_id is distinct from old.workspace_id then
    raise exception 'approval payload is immutable after creation';
  end if;
  return new;
end $$;
create trigger approvals_payload_lock before update on approvals
  for each row execute function approvals_payload_immutable();
