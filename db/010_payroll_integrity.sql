
create or replace function payroll_adjustment_draft_only()
returns trigger
language plpgsql
as $$
declare v_run uuid; v_status text;
begin
  v_run := case when tg_op='DELETE'
    then (select payroll_run_id from payroll_run_item where id=old.payroll_run_item_id)
    else (select payroll_run_id from payroll_run_item where id=new.payroll_run_item_id) end;
  select status into v_status from payroll_run where id=v_run;
  if v_status is distinct from 'draft' then raise exception 'Payroll adjustments can only change while the run is draft'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger payroll_adjustment_guard
before insert or update or delete on payroll_adjustment
for each row execute function payroll_adjustment_draft_only();

create or replace function protect_payroll_run_item()
returns trigger
language plpgsql
as $$
declare v_run uuid; v_status text;
begin
  v_run := case when tg_op='DELETE' then old.payroll_run_id else new.payroll_run_id end;
  select status into v_status from payroll_run where id=v_run;
  if tg_op='INSERT' and v_status is distinct from 'draft' then raise exception 'Payroll items can only be added while the run is draft'; end if;
  if tg_op='UPDATE' and v_status in ('locked','paid') then raise exception 'Locked payroll items are immutable'; end if;
  if tg_op='DELETE' and v_status is distinct from 'draft' then raise exception 'Payroll items can only be removed while the run is draft'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger payroll_run_item_guard
before insert or update or delete on payroll_run_item
for each row execute function protect_payroll_run_item();

create or replace function prevent_advance_schedule_mutation()
returns trigger language plpgsql as $$
begin raise exception 'Salary advance repayment schedules are immutable'; end; $$;
create trigger advance_schedule_immutable
before update or delete on salary_advance_repayment_schedule
for each row execute function prevent_advance_schedule_mutation();

create or replace function protect_locked_payroll_run()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('locked','paid') and (
    old.period_start is distinct from new.period_start or
    old.period_end is distinct from new.period_end or
    old.pay_date is distinct from new.pay_date or
    old.currency is distinct from new.currency
  ) then raise exception 'Locked payroll financial dates and currency are immutable'; end if;
  if old.status='paid' and new.status<>'paid' then
    if new.status='locked' and exists(select 1 from payroll_payment p where p.payroll_run_id=old.id and p.status='reversed') then return new; end if;
    raise exception 'Paid payroll cannot be reopened directly';
  end if;
  if old.status='locked' and new.status not in ('locked','paid') then raise exception 'Locked payroll cannot be unlocked'; end if;
  return new;
end;
$$;
create trigger payroll_run_lock_guard
before update on payroll_run
for each row execute function protect_locked_payroll_run();

create or replace function prevent_advance_allocation_mutation()
returns trigger language plpgsql as $$
begin raise exception 'Salary advance repayment allocations are immutable once payroll is locked'; end; $$;
create trigger advance_allocation_immutable
before update or delete on salary_advance_repayment_allocation
for each row execute function prevent_advance_allocation_mutation();

create or replace function payroll_journal()
returns uuid
language plpgsql stable
as $$
declare v_id uuid;
begin
  select j.id into v_id from accounting_configuration c join journal j on j.id=c.payroll_journal_id
  where c.id=1 and j.status='active';
  if v_id is null then raise exception 'Payroll journal is not configured or is inactive'; end if;
  return v_id;
end;
$$;

create or replace function monthly_due_date(p_start date,p_offset integer)
returns date
language sql immutable
as $$
  select (
    date_trunc('month',p_start)::date + make_interval(months=>p_offset)
    + (least(extract(day from p_start)::int,
        extract(day from (date_trunc('month',p_start)::date + make_interval(months=>p_offset+1) - interval '1 day'))::int)-1) * interval '1 day'
  )::date
$$;
