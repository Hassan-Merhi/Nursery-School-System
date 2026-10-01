-- Step 6 — Rentals

insert into document_sequence(document_type,prefix) values
  ('landlord','LND'),
  ('rental_agreement','RNT'),
  ('rent_payment','RPAY')
on conflict (document_type) do nothing;

alter table accounting_configuration
  add column if not exists rentals_journal_id uuid references journal(id) on delete restrict;

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('rent_expense','Rent Expense','Expense recognized for occupied rental periods.','expense'),
  ('prepaid_rent','Prepaid Rent','Asset holding rent paid before the related rental period is recognized.','asset'),
  ('rent_payable','Rent Payable','Liability for recognized rent that has not yet been paid.','liability'),
  ('rent_deposit','Rent Deposit','Asset holding refundable rental/security deposits paid to landlords.','asset')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create table landlord (
  id uuid primary key default gen_random_uuid(),
  landlord_number text not null unique,
  name text not null,
  contact_name text,
  email text,
  phone text,
  address text,
  tax_number text,
  notes text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);
create index landlord_name_idx on landlord(lower(name));

create table rental_agreement (
  id uuid primary key default gen_random_uuid(),
  agreement_number text not null unique,
  landlord_id uuid not null references landlord(id) on delete restrict,
  property_name text not null,
  property_address text not null,
  start_on date not null,
  end_on date not null,
  recurring_amount numeric(14,2) not null check (recurring_amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  frequency text not null default 'monthly' check (frequency in ('monthly','quarterly','yearly')),
  due_day integer not null default 1 check (due_day between 1 and 31),
  deposit_amount numeric(14,2) not null default 0 check (deposit_amount>=0),
  reference text,
  notes text,
  status text not null default 'draft' check (status in ('draft','active','ended')),
  activated_at timestamptz,
  activated_by uuid references app_user(id) on delete set null,
  ended_at timestamptz,
  ended_by uuid references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  check (end_on>=start_on)
);
create index rental_agreement_landlord_idx on rental_agreement(landlord_id,start_on desc);
create index rental_agreement_status_idx on rental_agreement(status,end_on);

create table rent_schedule (
  id uuid primary key default gen_random_uuid(),
  rental_agreement_id uuid not null references rental_agreement(id) on delete restrict,
  sequence integer not null check (sequence>0),
  period_start date not null,
  period_end date not null,
  due_on date not null,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (rental_agreement_id,sequence),
  unique (rental_agreement_id,period_start),
  check (period_end>=period_start),
  check (due_on between period_start and period_end)
);
create index rent_schedule_due_idx on rent_schedule(due_on,rental_agreement_id);

create table rent_payment (
  id uuid primary key default gen_random_uuid(),
  rent_payment_number text not null unique,
  rental_agreement_id uuid not null references rental_agreement(id) on delete restrict,
  payment_type text not null default 'rent' check (payment_type in ('rent','deposit')),
  payment_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_on date not null,
  method text not null default 'bank_transfer'
    check (method in ('cash','card','bank_transfer','check','other')),
  cheque_number text,
  cheque_due_on date,
  reference text,
  notes text,
  status text not null default 'posted' check (status in ('posted','reversed')),
  journal_entry_id uuid references journal_entry(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index rent_payment_agreement_idx on rent_payment(rental_agreement_id,paid_on desc);
create index rent_payment_status_idx on rent_payment(status,paid_on desc);

create table rent_payment_allocation (
  id uuid primary key default gen_random_uuid(),
  rent_payment_id uuid not null references rent_payment(id) on delete restrict,
  rent_schedule_id uuid not null references rent_schedule(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  allocation_type text not null check (allocation_type in ('prepaid','payable')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (rent_payment_id,rent_schedule_id)
);
create index rent_payment_allocation_schedule_idx on rent_payment_allocation(rent_schedule_id);

create table rent_recognition (
  id uuid primary key default gen_random_uuid(),
  rent_schedule_id uuid not null references rent_schedule(id) on delete restrict,
  recognition_date date not null,
  amount numeric(14,2) not null check (amount>0),
  prepaid_amount numeric(14,2) not null default 0 check (prepaid_amount>=0),
  payable_amount numeric(14,2) not null default 0 check (payable_amount>=0),
  rent_expense_account_id uuid not null references account(id) on delete restrict,
  prepaid_rent_account_id uuid not null references account(id) on delete restrict,
  rent_payable_account_id uuid not null references account(id) on delete restrict,
  journal_entry_id uuid references journal_entry(id) on delete restrict,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (prepaid_amount+payable_amount=amount)
);
create unique index rent_recognition_one_active_idx
  on rent_recognition(rent_schedule_id)
  where status='posted';
create index rent_recognition_date_idx on rent_recognition(recognition_date,status);

create table rent_payment_reversal_reclass (
  id uuid primary key default gen_random_uuid(),
  rent_payment_id uuid not null references rent_payment(id) on delete restrict,
  rent_schedule_id uuid not null references rent_schedule(id) on delete restrict,
  rent_recognition_id uuid not null references rent_recognition(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  prepaid_rent_account_id uuid not null references account(id) on delete restrict,
  rent_payable_account_id uuid not null references account(id) on delete restrict,
  journal_entry_id uuid not null references journal_entry(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (rent_payment_id,rent_schedule_id,rent_recognition_id)
);
create index rent_payment_reclass_schedule_idx on rent_payment_reversal_reclass(rent_schedule_id);

create table rental_attachment (
  id uuid primary key default gen_random_uuid(),
  rental_agreement_id uuid not null references rental_agreement(id) on delete restrict,
  document_id uuid not null references stored_document(id) on delete restrict,
  document_type text not null,
  notes text,
  attached_at timestamptz not null default now(),
  attached_by uuid references app_user(id) on delete set null,
  unique (rental_agreement_id,document_id)
);
create index rental_attachment_agreement_idx on rental_attachment(rental_agreement_id,attached_at desc);

create table rental_history (
  id bigint generated always as identity primary key,
  rental_agreement_id uuid not null references rental_agreement(id) on delete restrict,
  event_type text not null,
  event_date date not null default current_date,
  summary text not null,
  details jsonb,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references app_user(id) on delete set null
);
create index rental_history_agreement_idx
  on rental_history(rental_agreement_id,occurred_at desc,id desc);

create or replace function prevent_rental_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'rental_history is append-only';
end;
$$;

create trigger rental_history_immutable
before update or delete on rental_history
for each row execute function prevent_rental_history_mutation();

create or replace function protect_active_rental_agreement_terms()
returns trigger
language plpgsql
as $$
begin
  if old.status<>'draft' and (
    old.landlord_id is distinct from new.landlord_id
    or old.property_name is distinct from new.property_name
    or old.property_address is distinct from new.property_address
    or old.start_on is distinct from new.start_on
    or old.end_on is distinct from new.end_on
    or old.recurring_amount is distinct from new.recurring_amount
    or old.currency is distinct from new.currency
    or old.frequency is distinct from new.frequency
    or old.due_day is distinct from new.due_day
    or old.deposit_amount is distinct from new.deposit_amount
  ) then
    raise exception 'Activated rental financial terms are immutable; create a replacement agreement for changed terms';
  end if;

  if old.status='ended' and new.status<>'ended' then
    raise exception 'Ended rental agreements cannot be reopened';
  end if;
  if old.status='active' and new.status='draft' then
    raise exception 'Active rental agreements cannot return to draft';
  end if;

  return new;
end;
$$;

create trigger rental_agreement_terms_guard
before update on rental_agreement
for each row execute function protect_active_rental_agreement_terms();

create or replace function protect_rent_schedule()
returns trigger
language plpgsql
as $$
declare
  v_agreement uuid;
  v_status text;
begin
  v_agreement := case when tg_op='DELETE' then old.rental_agreement_id else new.rental_agreement_id end;
  select status into v_status from rental_agreement where id=v_agreement;
  if v_status is distinct from 'draft' then
    raise exception 'Activated rent schedules are immutable';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger rent_schedule_draft_only
before update or delete on rent_schedule
for each row execute function protect_rent_schedule();

create or replace function generate_rent_schedule(
  p_agreement_id uuid,
  p_user_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v rental_agreement%rowtype;
  v_start date;
  v_next date;
  v_end date;
  v_due date;
  v_month_end date;
  v_months integer;
  v_sequence integer := 1;
  v_count integer := 0;
begin
  select * into v
  from rental_agreement
  where id=p_agreement_id
  for update;

  if not found then raise exception 'Rental agreement not found'; end if;
  if v.status<>'draft' then raise exception 'Only draft rental agreements can generate a schedule'; end if;

  delete from rent_schedule where rental_agreement_id=v.id;

  v_months := case v.frequency when 'monthly' then 1 when 'quarterly' then 3 else 12 end;
  v_start := v.start_on;

  while v_start<=v.end_on loop
    v_next := (v_start + make_interval(months=>v_months))::date;
    v_end := least(v.end_on,(v_next-1));
    v_month_end := (date_trunc('month',v_start)::date + interval '1 month - 1 day')::date;
    v_due := make_date(
      extract(year from v_start)::integer,
      extract(month from v_start)::integer,
      least(v.due_day,extract(day from v_month_end)::integer)
    );
    if v_due<v_start then v_due := v_start; end if;
    if v_due>v_end then v_due := v_end; end if;

    insert into rent_schedule(
      rental_agreement_id,sequence,period_start,period_end,due_on,amount,currency,created_by
    ) values (
      v.id,v_sequence,v_start,v_end,v_due,v.recurring_amount,v.currency,p_user_id
    );

    v_count := v_count+1;
    v_sequence := v_sequence+1;
    v_start := v_next;
  end loop;

  return v_count;
end;
$$;

create or replace function activate_rental_agreement(
  p_agreement_id uuid,
  p_user_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_status text;
  v_count integer;
begin
  select status into v_status
  from rental_agreement
  where id=p_agreement_id
  for update;

  if not found then raise exception 'Rental agreement not found'; end if;
  if v_status<>'draft' then raise exception 'Only draft rental agreements can be activated'; end if;

  v_count := generate_rent_schedule(p_agreement_id,p_user_id);

  update rental_agreement
  set status='active',activated_at=now(),activated_by=p_user_id,
      updated_at=now(),updated_by=p_user_id
  where id=p_agreement_id;

  return v_count;
end;
$$;

create or replace function validate_rent_payment()
returns trigger
language plpgsql
as $$
declare
  v_agreement rental_agreement%rowtype;
  v_account_currency text;
  v_deposits numeric(14,2);
begin
  select * into v_agreement
  from rental_agreement
  where id=new.rental_agreement_id
  for update;

  if not found then raise exception 'Rental agreement not found'; end if;
  if v_agreement.status not in ('active','ended') then
    raise exception 'Rent payments require an active or ended rental agreement';
  end if;
  if v_agreement.currency<>new.currency then
    raise exception 'Rent payment and agreement currencies must match';
  end if;

  select a.currency into v_account_currency
  from cash_bank_account c
  join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id
    and c.is_active=true
    and a.status='active'
    and a.allow_posting=true;

  if v_account_currency is null then
    raise exception 'Rent payment account must be an active cash/bank account';
  end if;
  if v_account_currency<>new.currency then
    raise exception 'Rent payment and cash/bank account currencies must match';
  end if;
  if new.method='check' and coalesce(new.cheque_number,'')='' then
    raise exception 'Cheque number is required for cheque rent payments';
  end if;

  if new.payment_type='deposit' then
    if v_agreement.deposit_amount<=0 then
      raise exception 'This rental agreement has no deposit requirement';
    end if;

    select coalesce(sum(p.amount),0)::numeric(14,2) into v_deposits
    from rent_payment p
    where p.rental_agreement_id=new.rental_agreement_id
      and p.payment_type='deposit'
      and p.status='posted';

    if v_deposits+new.amount>v_agreement.deposit_amount then
      raise exception 'Deposit payment exceeds the agreement deposit amount';
    end if;
  end if;

  return new;
end;
$$;

create trigger rent_payment_validate
before insert on rent_payment
for each row execute function validate_rent_payment();

create or replace function allocate_rent_payment(
  p_payment_id uuid,
  p_user_id uuid default null
)
returns numeric
language plpgsql
as $$
declare
  v_payment rent_payment%rowtype;
  v_schedule rent_schedule%rowtype;
  v_existing numeric(14,2);
  v_used numeric(14,2);
  v_available numeric(14,2);
  v_allocate numeric(14,2);
  v_remaining numeric(14,2);
  v_type text;
begin
  select * into v_payment
  from rent_payment
  where id=p_payment_id
  for update;

  if not found then raise exception 'Rent payment not found'; end if;
  if v_payment.status<>'posted' or v_payment.payment_type<>'rent' then
    raise exception 'Only posted rent payments can be allocated';
  end if;

  select coalesce(sum(amount),0)::numeric(14,2)
    into v_existing
  from rent_payment_allocation
  where rent_payment_id=v_payment.id;

  if v_existing>0 then
    if v_existing<>v_payment.amount then
      raise exception 'Existing rent allocation does not equal the payment amount';
    end if;
    return v_existing;
  end if;

  v_remaining := v_payment.amount;

  for v_schedule in
    select *
    from rent_schedule
    where rental_agreement_id=v_payment.rental_agreement_id
    order by period_start,sequence
    for update
  loop
    select coalesce(sum(a.amount),0)::numeric(14,2)
      into v_used
    from rent_payment_allocation a
    join rent_payment p on p.id=a.rent_payment_id
    where a.rent_schedule_id=v_schedule.id
      and p.status='posted';

    v_available := v_schedule.amount-v_used;
    if v_available<=0 then continue; end if;

    v_allocate := least(v_remaining,v_available);
    v_type := case
      when exists (
        select 1 from rent_recognition r
        where r.rent_schedule_id=v_schedule.id and r.status='posted'
      ) then 'payable'
      else 'prepaid'
    end;

    insert into rent_payment_allocation(
      rent_payment_id,rent_schedule_id,amount,allocation_type,created_by
    ) values (
      v_payment.id,v_schedule.id,v_allocate,v_type,p_user_id
    );

    v_remaining := v_remaining-v_allocate;
    exit when v_remaining=0;
  end loop;

  if v_remaining<>0 then
    raise exception 'Rent payment exceeds remaining scheduled rent by %',v_remaining;
  end if;

  return v_payment.amount;
end;
$$;

create or replace view rent_schedule_balance as
with allocations as (
  select
    a.rent_schedule_id,
    coalesce(sum(a.amount),0)::numeric(14,2) as paid_amount,
    coalesce(sum(a.amount) filter (where a.allocation_type='prepaid'),0)::numeric(14,2) as prepaid_allocated,
    coalesce(sum(a.amount) filter (where a.allocation_type='payable'),0)::numeric(14,2) as payable_paid
  from rent_payment_allocation a
  join rent_payment p on p.id=a.rent_payment_id and p.status='posted'
  group by a.rent_schedule_id
), active_recognition as (
  select * from rent_recognition where status='posted'
), reclass as (
  select
    rent_schedule_id,
    coalesce(sum(amount),0)::numeric(14,2) as reclass_amount
  from rent_payment_reversal_reclass
  group by rent_schedule_id
)
select
  s.*,
  r.id as rent_recognition_id,
  r.recognition_date,
  coalesce(r.amount,0)::numeric(14,2) as recognized_amount,
  greatest(coalesce(r.prepaid_amount,0)-coalesce(rc.reclass_amount,0),0)::numeric(14,2) as recognized_prepaid_amount,
  (coalesce(r.payable_amount,0)+coalesce(rc.reclass_amount,0))::numeric(14,2) as recognized_payable_amount,
  coalesce(a.paid_amount,0)::numeric(14,2) as paid_amount,
  greatest(s.amount-coalesce(a.paid_amount,0),0)::numeric(14,2) as outstanding_amount,
  case when r.id is null then coalesce(a.prepaid_allocated,0) else 0 end::numeric(14,2) as prepaid_rent_balance,
  case when r.id is not null
    then greatest(coalesce(r.payable_amount,0)+coalesce(rc.reclass_amount,0)-coalesce(a.payable_paid,0),0)
    else 0
  end::numeric(14,2) as rent_payable_balance
from rent_schedule s
left join allocations a on a.rent_schedule_id=s.id
left join active_recognition r on r.rent_schedule_id=s.id
left join reclass rc on rc.rent_schedule_id=s.id;

create or replace view rental_agreement_balance as
with schedule_totals as (
  select
    rental_agreement_id,
    coalesce(sum(amount),0)::numeric(14,2) as scheduled_rent,
    coalesce(sum(paid_amount),0)::numeric(14,2) as paid_rent,
    coalesce(sum(outstanding_amount),0)::numeric(14,2) as outstanding_rent,
    coalesce(sum(recognized_amount),0)::numeric(14,2) as recognized_rent_expense,
    coalesce(sum(prepaid_rent_balance),0)::numeric(14,2) as prepaid_rent_balance,
    coalesce(sum(rent_payable_balance),0)::numeric(14,2) as rent_payable_balance
  from rent_schedule_balance
  group by rental_agreement_id
), deposits as (
  select
    rental_agreement_id,
    coalesce(sum(amount),0)::numeric(14,2) as deposit_paid
  from rent_payment
  where payment_type='deposit' and status='posted'
  group by rental_agreement_id
)
select
  a.*,
  l.landlord_number,l.name as landlord_name,
  coalesce(s.scheduled_rent,0)::numeric(14,2) as scheduled_rent,
  coalesce(s.paid_rent,0)::numeric(14,2) as paid_rent,
  coalesce(s.outstanding_rent,0)::numeric(14,2) as outstanding_rent,
  coalesce(s.recognized_rent_expense,0)::numeric(14,2) as recognized_rent_expense,
  coalesce(s.prepaid_rent_balance,0)::numeric(14,2) as prepaid_rent_balance,
  coalesce(s.rent_payable_balance,0)::numeric(14,2) as rent_payable_balance,
  coalesce(d.deposit_paid,0)::numeric(14,2) as deposit_paid,
  greatest(a.deposit_amount-coalesce(d.deposit_paid,0),0)::numeric(14,2) as deposit_outstanding
from rental_agreement a
join landlord l on l.id=a.landlord_id
left join schedule_totals s on s.rental_agreement_id=a.id
left join deposits d on d.rental_agreement_id=a.id;

create or replace function accounting_rentals_journal()
returns uuid
language plpgsql
stable
as $$
declare
  v_journal_id uuid;
begin
  select j.id into v_journal_id
  from accounting_configuration c
  join journal j on j.id=c.rentals_journal_id
  where c.id=1 and j.status='active';

  if v_journal_id is null then
    raise exception 'Rentals journal is not configured or is inactive';
  end if;
  return v_journal_id;
end;
$$;

create or replace function accounting_post_rent_payment(
  p_payment_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v rent_payment%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_prepaid uuid;
  v_payable uuid;
  v_deposit uuid;
  v_prepaid_amount numeric(14,2) := 0;
  v_payable_amount numeric(14,2) := 0;
  v_allocated numeric(14,2) := 0;
  v_line integer := 1;
begin
  select id into v_existing
  from journal_entry
  where source_type='rent_payment' and source_id=p_payment_id and entry_kind<>'reversal';

  if v_existing is not null then
    update rent_payment set journal_entry_id=v_existing where id=p_payment_id and journal_entry_id is null;
    return v_existing;
  end if;

  select * into v from rent_payment where id=p_payment_id for update;
  if not found or v.status<>'posted' then
    raise exception 'Only posted rent payments can be posted to accounting';
  end if;

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    accounting_rentals_journal(),'system',v.paid_on,v.currency,
    case when v.payment_type='deposit' then 'Rent deposit ' else 'Rent payment ' end || v.rent_payment_number,
    coalesce(v.reference,v.rent_payment_number),'rent_payment',v.id,p_user_id
  ) returning id into v_entry;

  if v.payment_type='deposit' then
    v_deposit := accounting_mapped_account('rent_deposit');
    insert into journal_line(
      journal_entry_id,line_number,account_id,description,debit,credit,created_by
    ) values (
      v_entry,v_line,v_deposit,'Refundable rent deposit',v.amount,0,p_user_id
    );
    v_line := v_line+1;
  else
    select
      coalesce(sum(amount) filter (where allocation_type='prepaid'),0)::numeric(14,2),
      coalesce(sum(amount) filter (where allocation_type='payable'),0)::numeric(14,2),
      coalesce(sum(amount),0)::numeric(14,2)
      into v_prepaid_amount,v_payable_amount,v_allocated
    from rent_payment_allocation
    where rent_payment_id=v.id;

    if v_allocated<>v.amount then
      raise exception 'Rent payment must be fully allocated before accounting posting';
    end if;

    if v_prepaid_amount>0 then
      v_prepaid := accounting_mapped_account('prepaid_rent');
      insert into journal_line(
        journal_entry_id,line_number,account_id,description,debit,credit,created_by
      ) values (
        v_entry,v_line,v_prepaid,'Prepaid rent',v_prepaid_amount,0,p_user_id
      );
      v_line := v_line+1;
    end if;

    if v_payable_amount>0 then
      v_payable := accounting_mapped_account('rent_payable');
      insert into journal_line(
        journal_entry_id,line_number,account_id,description,debit,credit,created_by
      ) values (
        v_entry,v_line,v_payable,'Settle rent payable',v_payable_amount,0,p_user_id
      );
      v_line := v_line+1;
    end if;
  end if;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,created_by
  ) values (
    v_entry,v_line,v.payment_account_id,'Rent cash/bank payment',0,v.amount,p_user_id
  );

  perform post_journal_entry(v_entry,p_user_id);
  update rent_payment set journal_entry_id=v_entry where id=v.id;
  return v_entry;
end;
$$;

create or replace function accounting_recognize_rent_schedule(
  p_schedule_id uuid,
  p_recognition_date date,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_schedule rent_schedule%rowtype;
  v_agreement rental_agreement%rowtype;
  v_existing uuid;
  v_recognition uuid;
  v_entry uuid;
  v_expense uuid;
  v_prepaid uuid;
  v_payable uuid;
  v_prepaid_amount numeric(14,2);
  v_payable_amount numeric(14,2);
  v_line integer := 2;
begin
  select id into v_existing
  from rent_recognition
  where rent_schedule_id=p_schedule_id and status='posted';

  if v_existing is not null then return v_existing; end if;

  select * into v_schedule
  from rent_schedule
  where id=p_schedule_id
  for update;

  if not found then raise exception 'Rent schedule item not found'; end if;

  select * into v_agreement
  from rental_agreement
  where id=v_schedule.rental_agreement_id;

  if v_agreement.status not in ('active','ended') then
    raise exception 'Rent can only be recognized for an active or ended agreement';
  end if;
  if p_recognition_date<v_schedule.period_end then
    raise exception 'Rent cannot be recognized before the rental period ends';
  end if;

  select coalesce(sum(a.amount),0)::numeric(14,2)
    into v_prepaid_amount
  from rent_payment_allocation a
  join rent_payment p on p.id=a.rent_payment_id
  where a.rent_schedule_id=v_schedule.id
    and a.allocation_type='prepaid'
    and p.status='posted';

  if v_prepaid_amount>v_schedule.amount then
    raise exception 'Prepaid rent exceeds the scheduled rent amount';
  end if;

  v_payable_amount := v_schedule.amount-v_prepaid_amount;
  v_expense := accounting_mapped_account('rent_expense');
  v_prepaid := accounting_mapped_account('prepaid_rent');
  v_payable := accounting_mapped_account('rent_payable');

  insert into rent_recognition(
    rent_schedule_id,recognition_date,amount,prepaid_amount,payable_amount,
    rent_expense_account_id,prepaid_rent_account_id,rent_payable_account_id,created_by
  ) values (
    v_schedule.id,p_recognition_date,v_schedule.amount,v_prepaid_amount,v_payable_amount,
    v_expense,v_prepaid,v_payable,p_user_id
  ) returning id into v_recognition;

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    accounting_rentals_journal(),'system',p_recognition_date,v_schedule.currency,
    'Rent recognition '||v_agreement.agreement_number||' period '||v_schedule.sequence,
    v_agreement.agreement_number||'-'||v_schedule.sequence,
    'rent_recognition',v_recognition,p_user_id
  ) returning id into v_entry;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,created_by
  ) values (
    v_entry,1,v_expense,'Rent expense',v_schedule.amount,0,p_user_id
  );

  if v_prepaid_amount>0 then
    insert into journal_line(
      journal_entry_id,line_number,account_id,description,debit,credit,created_by
    ) values (
      v_entry,v_line,v_prepaid,'Release prepaid rent',0,v_prepaid_amount,p_user_id
    );
    v_line := v_line+1;
  end if;

  if v_payable_amount>0 then
    insert into journal_line(
      journal_entry_id,line_number,account_id,description,debit,credit,created_by
    ) values (
      v_entry,v_line,v_payable,'Accrue rent payable',0,v_payable_amount,p_user_id
    );
  end if;

  perform post_journal_entry(v_entry,p_user_id);

  update rent_recognition
  set journal_entry_id=v_entry
  where id=v_recognition;

  return v_recognition;
end;
$$;

create or replace function recognize_rent_through(
  p_agreement_id uuid,
  p_through_date date,
  p_user_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_schedule record;
  v_count integer := 0;
begin
  perform 1
  from rental_agreement
  where id=p_agreement_id
  for update;

  if not found then raise exception 'Rental agreement not found'; end if;

  for v_schedule in
    select s.id,s.period_end
    from rent_schedule s
    where s.rental_agreement_id=p_agreement_id
      and s.period_end<=p_through_date
      and not exists (
        select 1 from rent_recognition r
        where r.rent_schedule_id=s.id and r.status='posted'
      )
    order by s.period_end,s.sequence
  loop
    perform accounting_recognize_rent_schedule(v_schedule.id,v_schedule.period_end,p_user_id);
    v_count := v_count+1;
  end loop;

  return v_count;
end;
$$;

create or replace function reverse_rent_recognition(
  p_recognition_id uuid,
  p_posting_date date,
  p_user_id uuid default null,
  p_reason text default 'Rent recognition reversal'
)
returns uuid
language plpgsql
as $$
declare
  v rent_recognition%rowtype;
  v_reversal uuid;
begin
  select * into v
  from rent_recognition
  where id=p_recognition_id
  for update;

  if not found or v.status<>'posted' then
    raise exception 'Only posted rent recognition can be reversed';
  end if;

  if exists (
    select 1
    from rent_payment_allocation a
    join rent_payment p on p.id=a.rent_payment_id
    where a.rent_schedule_id=v.rent_schedule_id
      and a.allocation_type='payable'
      and p.status='posted'
  ) then
    raise exception 'Reverse post-recognition rent payments before reversing rent recognition';
  end if;

  if exists (
    select 1 from rent_payment_reversal_reclass
    where rent_recognition_id=v.id
  ) then
    raise exception 'Rent recognition cannot be reversed after a consumed prepayment was reversed';
  end if;

  v_reversal := reverse_operational_source(
    'rent_recognition',v.id,p_posting_date,p_user_id,p_reason
  );

  update rent_recognition
  set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason
  where id=v.id;

  return v_reversal;
end;
$$;

create or replace function reverse_rent_payment(
  p_payment_id uuid,
  p_posting_date date,
  p_user_id uuid default null,
  p_reason text default 'Rent payment reversal'
)
returns uuid
language plpgsql
as $$
declare
  v rent_payment%rowtype;
  v_reversal uuid;
  v_reclass_entry uuid;
  v_group record;
  v_total numeric(14,2) := 0;
  v_line integer := 1;
begin
  select * into v
  from rent_payment
  where id=p_payment_id
  for update;

  if not found or v.status<>'posted' then
    raise exception 'Only posted rent payments can be reversed';
  end if;

  v_reversal := reverse_operational_source(
    'rent_payment',v.id,p_posting_date,p_user_id,p_reason
  );

  if v.payment_type='rent' then
    select coalesce(sum(a.amount),0)::numeric(14,2)
      into v_total
    from rent_payment_allocation a
    join rent_recognition r
      on r.rent_schedule_id=a.rent_schedule_id
     and r.status='posted'
    where a.rent_payment_id=v.id
      and a.allocation_type='prepaid';

    if v_total>0 then
      insert into journal_entry(
        journal_id,entry_kind,posting_date,currency,description,transaction_reference,
        source_type,source_id,created_by
      ) values (
        accounting_rentals_journal(),'system',p_posting_date,v.currency,
        'Reclass consumed prepaid rent after reversing '||v.rent_payment_number,
        v.rent_payment_number,'rent_payment_reclass',v.id,p_user_id
      ) returning id into v_reclass_entry;

      for v_group in
        select
          r.prepaid_rent_account_id,
          r.rent_payable_account_id,
          sum(a.amount)::numeric(14,2) as amount
        from rent_payment_allocation a
        join rent_recognition r
          on r.rent_schedule_id=a.rent_schedule_id
         and r.status='posted'
        where a.rent_payment_id=v.id
          and a.allocation_type='prepaid'
        group by r.prepaid_rent_account_id,r.rent_payable_account_id
      loop
        insert into journal_line(
          journal_entry_id,line_number,account_id,description,debit,credit,created_by
        ) values
          (v_reclass_entry,v_line,v_group.prepaid_rent_account_id,'Restore prepaid rent after payment reversal',v_group.amount,0,p_user_id),
          (v_reclass_entry,v_line+1,v_group.rent_payable_account_id,'Create rent payable after payment reversal',0,v_group.amount,p_user_id);
        v_line := v_line+2;
      end loop;

      perform post_journal_entry(v_reclass_entry,p_user_id);

      insert into rent_payment_reversal_reclass(
        rent_payment_id,rent_schedule_id,rent_recognition_id,amount,
        prepaid_rent_account_id,rent_payable_account_id,journal_entry_id,created_by
      )
      select
        v.id,a.rent_schedule_id,r.id,a.amount,
        r.prepaid_rent_account_id,r.rent_payable_account_id,v_reclass_entry,p_user_id
      from rent_payment_allocation a
      join rent_recognition r
        on r.rent_schedule_id=a.rent_schedule_id
       and r.status='posted'
      where a.rent_payment_id=v.id
        and a.allocation_type='prepaid';
    end if;
  end if;

  update rent_payment
  set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason
  where id=v.id;

  return v_reversal;
end;
$$;

create or replace function rental_history_events()
returns trigger
language plpgsql
as $$
declare
  v_agreement uuid;
  v_event text;
  v_date date;
  v_summary text;
  v_details jsonb;
  v_actor uuid;
begin
  if tg_table_name='rental_agreement' then
    v_agreement := new.id;
    v_actor := coalesce(new.updated_by,new.created_by);
    if tg_op='INSERT' then
      v_event := 'agreement_created';
      v_date := new.start_on;
      v_summary := 'Rental agreement '||new.agreement_number||' created';
      v_details := jsonb_build_object('property',new.property_name,'status',new.status);
    elsif old.status is distinct from new.status then
      v_event := case new.status when 'active' then 'agreement_activated' when 'ended' then 'agreement_ended' else 'agreement_status_changed' end;
      v_date := current_date;
      v_summary := 'Rental agreement '||new.agreement_number||' changed to '||new.status;
      v_details := jsonb_build_object('from',old.status,'to',new.status);
    else
      return new;
    end if;
  elsif tg_table_name='rent_payment' then
    v_agreement := new.rental_agreement_id;
    v_actor := coalesce(new.reversed_by,new.created_by);
    v_date := new.paid_on;
    if tg_op='INSERT' then
      v_event := case new.payment_type when 'deposit' then 'deposit_paid' else 'rent_paid' end;
      v_summary := new.rent_payment_number||' recorded for '||new.amount||' '||new.currency;
      v_details := jsonb_build_object('paymentId',new.id,'paymentType',new.payment_type,'amount',new.amount,'currency',new.currency);
    elsif old.status='posted' and new.status='reversed' then
      v_event := 'rent_payment_reversed';
      v_date := current_date;
      v_summary := new.rent_payment_number||' reversed';
      v_details := jsonb_build_object('paymentId',new.id,'reason',new.reversal_reason);
    else
      return new;
    end if;
  elsif tg_table_name='rent_recognition' then
    select rental_agreement_id into v_agreement
    from rent_schedule where id=new.rent_schedule_id;
    v_actor := coalesce(new.reversed_by,new.created_by);
    v_date := new.recognition_date;
    if tg_op='INSERT' then
      v_event := 'rent_recognized';
      v_summary := 'Rent expense recognized for '||new.amount||'';
      v_details := jsonb_build_object('recognitionId',new.id,'scheduleId',new.rent_schedule_id,'prepaid',new.prepaid_amount,'payable',new.payable_amount);
    elsif old.status='posted' and new.status='reversed' then
      v_event := 'rent_recognition_reversed';
      v_date := current_date;
      v_summary := 'Rent recognition reversed';
      v_details := jsonb_build_object('recognitionId',new.id,'reason',new.reversal_reason);
    else
      return new;
    end if;
  elsif tg_table_name='rental_attachment' then
    v_agreement := new.rental_agreement_id;
    v_actor := new.attached_by;
    v_date := current_date;
    v_event := 'attachment_added';
    v_summary := new.document_type||' attachment added';
    v_details := jsonb_build_object('attachmentId',new.id,'documentId',new.document_id);
  else
    return new;
  end if;

  insert into rental_history(
    rental_agreement_id,event_type,event_date,summary,details,actor_user_id
  ) values (
    v_agreement,v_event,v_date,v_summary,v_details,v_actor
  );

  return new;
end;
$$;

create trigger rental_agreement_history
after insert or update on rental_agreement
for each row execute function rental_history_events();

create trigger rent_payment_history
after insert or update on rent_payment
for each row execute function rental_history_events();

create trigger rent_recognition_history
after insert or update on rent_recognition
for each row execute function rental_history_events();

create trigger rental_attachment_history
after insert on rental_attachment
for each row execute function rental_history_events();

insert into permission(key,description) values
  ('rentals.view','View landlords, rental agreements, rent schedules, balances, and rent history'),
  ('rentals.manage','Create and maintain landlords and rental agreements'),
  ('rentals.pay','Record and reverse rent and deposit payments'),
  ('rentals.post','Recognize and reverse rental expense in accounting'),
  ('rental_documents.view','View rental agreement attachments'),
  ('rental_documents.manage','Upload rental agreement attachments')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
