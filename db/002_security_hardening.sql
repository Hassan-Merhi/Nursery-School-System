create or replace function prevent_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists audit_log_immutable on audit_log;

create trigger audit_log_immutable
before update or delete on audit_log
for each row
execute function prevent_audit_log_mutation();
