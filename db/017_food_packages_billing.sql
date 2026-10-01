-- Step 10 — Food Packages & Student Food Billing
-- Food stays separate from the one-live-term tuition invoice constraint while sharing
-- family credits, student/family ledgers, Accounts Receivable, receipts and accounting.

insert into document_sequence(document_type,prefix)
values ('food_bill','FOOD')
on conflict (document_type) do nothing;

create table food_item (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);
create index food_item_name_idx on food_item(lower(name),status);

create table food_item_price (
  id uuid primary key default gen_random_uuid(),
  food_item_id uuid not null references food_item(id) on delete restrict,
  amount numeric(12,2) not null check (amount>0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (effective_to is null or effective_to>=effective_from)
);
create index food_item_price_lookup_idx
  on food_item_price(food_item_id,currency,effective_from desc);

create or replace function validate_food_item_price_overlap()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from food_item_price p
    where p.food_item_id=new.food_item_id
      and p.currency=new.currency
      and p.id<>new.id
      and daterange(p.effective_from,coalesce(p.effective_to,'infinity'::date),'[]')
          && daterange(new.effective_from,coalesce(new.effective_to,'infinity'::date),'[]')
  ) then
    raise exception 'Food item price periods cannot overlap for the same currency';
  end if;
  return new;
end;
$$;

create trigger food_item_price_no_overlap
before insert or update on food_item_price
for each row execute function validate_food_item_price_overlap();

create table food_package (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  code text not null unique,
  name text not null,
  package_kind text not null check (package_kind in ('daily','weekly','monthly','term')),
  package_price numeric(12,2) not null check (package_price>0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  available_from date,
  available_to date,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  activated_at timestamptz,
  activated_by uuid references app_user(id) on delete set null,
  foreign key (term_id,school_year_id)
    references school_term(id,school_year_id) on delete restrict,
  check (available_to is null or available_from is null or available_to>=available_from)
);
create unique index food_package_id_term_year_unique
  on food_package(id,term_id,school_year_id);
create index food_package_term_idx on food_package(term_id,status,package_kind);

create table food_package_item (
  food_package_id uuid not null references food_package(id) on delete restrict,
  food_item_id uuid not null references food_item(id) on delete restrict,
  quantity numeric(8,2) not null default 1 check (quantity>0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  primary key (food_package_id,food_item_id)
);

create or replace function protect_food_package_items()
returns trigger
language plpgsql
as $$
declare
  v_package_id uuid;
  v_status text;
  v_term_id uuid;
begin
  v_package_id := case when tg_op='DELETE' then old.food_package_id else new.food_package_id end;
  select status,term_id into v_status,v_term_id from food_package where id=v_package_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'Only draft food packages can change their item composition';
  end if;
  perform assert_school_term_open(v_term_id);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger food_package_item_draft_only
before insert or update or delete on food_package_item
for each row execute function protect_food_package_items();

create or replace function validate_food_package()
returns trigger
language plpgsql
as $$
begin
  if tg_op='INSERT'
     or new.term_id is distinct from old.term_id
     or new.package_price is distinct from old.package_price
     or (new.status is distinct from old.status and new.status in ('draft','active')) then
    perform assert_school_term_open(new.term_id);
  end if;

  if tg_op='UPDATE' and old.status<>'draft' and (
    new.school_year_id is distinct from old.school_year_id
    or new.term_id is distinct from old.term_id
    or new.code is distinct from old.code
    or new.name is distinct from old.name
    or new.package_kind is distinct from old.package_kind
    or new.package_price is distinct from old.package_price
    or new.currency is distinct from old.currency
    or new.available_from is distinct from old.available_from
    or new.available_to is distinct from old.available_to
  ) then
    raise exception 'Activated food package pricing and scope are immutable; archive it and create a replacement';
  end if;

  if new.status='active' and (tg_op='INSERT' or old.status is distinct from 'active') then
    if not exists (select 1 from food_package_item where food_package_id=new.id) then
      raise exception 'Food package requires at least one food item before activation';
    end if;
    new.activated_at := now();
  end if;

  return new;
end;
$$;

create trigger food_package_validate
before insert or update on food_package
for each row execute function validate_food_package();

create table student_food_selection (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid not null,
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  food_package_id uuid not null,
  unit_price numeric(12,2) not null check (unit_price>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  quantity numeric(8,2) not null default 1 check (quantity>0),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'active' check (status in ('active','ended','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  ended_at timestamptz,
  ended_by uuid references app_user(id) on delete set null,
  foreign key (student_id,family_id)
    references student(id,family_id) on delete restrict,
  foreign key (term_id,school_year_id)
    references school_term(id,school_year_id) on delete restrict,
  foreign key (food_package_id,term_id,school_year_id)
    references food_package(id,term_id,school_year_id) on delete restrict,
  check (ends_on>=starts_on),
  check (
    (status='active' and ended_at is null)
    or (status in ('ended','cancelled') and ended_at is not null)
  )
);
create index student_food_selection_student_idx
  on student_food_selection(student_id,term_id,status,starts_on,ends_on);
create index student_food_selection_package_idx
  on student_food_selection(food_package_id,status);

create or replace function validate_student_food_selection()
returns trigger
language plpgsql
as $$
declare
  v_family uuid;
  v_package food_package%rowtype;
  v_term_start date;
  v_term_end date;
begin
  if tg_op='UPDATE' and old.status<>'active' then
    raise exception 'Ended or cancelled food selections are immutable';
  end if;

  select family_id into v_family from student where id=new.student_id and status<>'archived';
  if v_family is null then raise exception 'Active student not found'; end if;

  select * into v_package from food_package where id=new.food_package_id;
  if not found then
    raise exception 'Food package not found';
  end if;
  if (tg_op='INSERT'
      or new.food_package_id is distinct from old.food_package_id
      or (new.status='active' and old.status is distinct from 'active'))
     and v_package.status<>'active' then
    raise exception 'Food selection requires an active food package';
  end if;

  new.family_id := v_family;
  new.school_year_id := v_package.school_year_id;
  new.term_id := v_package.term_id;
  new.unit_price := v_package.package_price;
  new.currency := v_package.currency;

  select starts_on,ends_on into v_term_start,v_term_end
  from school_term where id=new.term_id;

  if tg_op='INSERT'
     or new.food_package_id is distinct from old.food_package_id
     or (new.status='active' and old.status is distinct from 'active') then
    perform assert_school_term_open(new.term_id);
  end if;

  if new.starts_on<v_term_start or new.ends_on>v_term_end then
    raise exception 'Food selection dates must fall inside the package school term';
  end if;
  if v_package.available_from is not null and new.starts_on<v_package.available_from then
    raise exception 'Food selection starts before the package is available';
  end if;
  if v_package.available_to is not null and new.ends_on>v_package.available_to then
    raise exception 'Food selection ends after the package is available';
  end if;

  if not exists (
    select 1
    from student_enrollment e
    join student_term_enrollment te on te.enrollment_id=e.id
    where e.student_id=new.student_id
      and e.school_year_id=new.school_year_id
      and e.status<>'cancelled'
      and te.term_id=new.term_id
      and te.status<>'cancelled'
  ) then
    raise exception 'Student must be enrolled in the selected package term';
  end if;

  if new.status='active' and exists (
    select 1
    from student_food_selection s
    where s.id<>new.id
      and s.student_id=new.student_id
      and s.food_package_id=new.food_package_id
      and s.status='active'
      and daterange(s.starts_on,s.ends_on,'[]') && daterange(new.starts_on,new.ends_on,'[]')
  ) then
    raise exception 'Student already has an overlapping active selection for this food package';
  end if;

  if new.status in ('ended','cancelled') and new.ended_at is null then
    new.ended_at := now();
  end if;

  return new;
end;
$$;

create trigger student_food_selection_validate
before insert or update on student_food_selection
for each row execute function validate_student_food_selection();

create table food_bill (
  id uuid primary key default gen_random_uuid(),
  bill_number text not null unique,
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid not null,
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  food_package_id uuid not null,
  student_food_selection_id uuid not null references student_food_selection(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  due_on date not null,
  issued_on date,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(12,2) not null default 0 check (total_amount>=0),
  status text not null default 'draft'
    check (status in ('draft','issued','partially_paid','paid','void')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  voided_at timestamptz,
  voided_by uuid references app_user(id) on delete set null,
  void_reason text,
  foreign key (student_id,family_id)
    references student(id,family_id) on delete restrict,
  foreign key (term_id,school_year_id)
    references school_term(id,school_year_id) on delete restrict,
  foreign key (food_package_id,term_id,school_year_id)
    references food_package(id,term_id,school_year_id) on delete restrict,
  check (period_end>=period_start),
  check (
    (status='draft' and issued_on is null and voided_at is null)
    or (status in ('issued','partially_paid','paid') and issued_on is not null and voided_at is null)
    or (status='void' and issued_on is not null and voided_at is not null and void_reason is not null)
  )
);
create unique index food_bill_selection_period_unique
  on food_bill(student_food_selection_id,period_start,period_end)
  where status<>'void';
create index food_bill_family_idx on food_bill(family_id,created_at desc);
create index food_bill_student_idx on food_bill(student_id,created_at desc);
create index food_bill_status_idx on food_bill(status,due_on);

create table food_bill_line (
  id uuid primary key default gen_random_uuid(),
  food_bill_id uuid not null references food_bill(id) on delete restrict,
  description text not null,
  package_kind text not null check (package_kind in ('daily','weekly','monthly','term')),
  quantity numeric(8,2) not null check (quantity>0),
  unit_price numeric(12,2) not null check (unit_price>0),
  amount numeric(12,2) generated always as (round(quantity*unit_price,2)) stored,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index food_bill_line_bill_idx on food_bill_line(food_bill_id);

create or replace function protect_food_bill_lines()
returns trigger
language plpgsql
as $$
declare
  v_bill_id uuid;
  v_status text;
begin
  v_bill_id := case when tg_op='DELETE' then old.food_bill_id else new.food_bill_id end;
  select status into v_status from food_bill where id=v_bill_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'Issued food bill lines are immutable; void the bill instead';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger food_bill_line_draft_only
before insert or update or delete on food_bill_line
for each row execute function protect_food_bill_lines();

create or replace function recalculate_food_bill()
returns trigger
language plpgsql
as $$
declare
  v_bill_id uuid;
begin
  v_bill_id := case when tg_op='DELETE' then old.food_bill_id else new.food_bill_id end;
  update food_bill b
  set total_amount=coalesce(x.total,0),updated_at=now()
  from (
    select coalesce(sum(amount),0)::numeric(12,2) as total
    from food_bill_line where food_bill_id=v_bill_id
  ) x
  where b.id=v_bill_id;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger food_bill_line_recalculate
after insert or update or delete on food_bill_line
for each row execute function recalculate_food_bill();

create or replace function validate_food_bill_scope()
returns trigger
language plpgsql
as $$
declare
  v_selection student_food_selection%rowtype;
begin
  if tg_op='UPDATE' and old.status<>'draft' then
    if to_jsonb(new)-'status'-'voided_at'-'voided_by'-'void_reason'-'updated_at'-'updated_by'
       <> to_jsonb(old)-'status'-'voided_at'-'voided_by'-'void_reason'-'updated_at'-'updated_by'
    then
      raise exception 'Issued food bills are immutable; settle or void them';
    end if;
    return new;
  end if;

  select * into v_selection
  from student_food_selection
  where id=new.student_food_selection_id;

  if not found or v_selection.status='cancelled' then
    raise exception 'Food bill requires a valid student food selection';
  end if;

  new.family_id := v_selection.family_id;
  new.student_id := v_selection.student_id;
  new.school_year_id := v_selection.school_year_id;
  new.term_id := v_selection.term_id;
  new.food_package_id := v_selection.food_package_id;
  new.currency := v_selection.currency;

  perform assert_school_term_open(new.term_id);

  if new.period_start<v_selection.starts_on or new.period_end>v_selection.ends_on then
    raise exception 'Food billing period must fall within the selection dates';
  end if;

  return new;
end;
$$;

create trigger food_bill_scope_validate
before insert or update on food_bill
for each row execute function validate_food_bill_scope();

create table food_payment_allocation (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payment(id) on delete restrict,
  food_bill_id uuid not null references food_bill(id) on delete restrict,
  amount numeric(12,2) not null check (amount>0),
  allocated_on date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (payment_id,food_bill_id)
);

create table food_credit_allocation (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_note(id) on delete restrict,
  food_bill_id uuid not null references food_bill(id) on delete restrict,
  amount numeric(12,2) not null check (amount>0),
  allocated_on date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (credit_note_id,food_bill_id)
);

create or replace function prevent_food_allocation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Food allocations are immutable; reverse the source payment or credit instead';
end;
$$;

create trigger food_payment_allocation_immutable
before update or delete on food_payment_allocation
for each row execute function prevent_food_allocation_mutation();

create trigger food_credit_allocation_immutable
before update or delete on food_credit_allocation
for each row execute function prevent_food_allocation_mutation();

create or replace view food_bill_balance as
select
  b.*,
  coalesce(p.paid_amount,0)::numeric(12,2) as paid_amount,
  coalesce(c.credit_amount,0)::numeric(12,2) as credit_amount,
  case when b.status='void' then 0::numeric(12,2)
    else greatest(b.total_amount-coalesce(p.paid_amount,0)-coalesce(c.credit_amount,0),0)::numeric(12,2)
  end as balance_amount
from food_bill b
left join (
  select a.food_bill_id,sum(a.amount) as paid_amount
  from food_payment_allocation a
  join payment p on p.id=a.payment_id and p.status='posted'
  group by a.food_bill_id
) p on p.food_bill_id=b.id
left join (
  select a.food_bill_id,sum(a.amount) as credit_amount
  from food_credit_allocation a
  join credit_note c on c.id=a.credit_note_id and c.status='issued'
  group by a.food_bill_id
) c on c.food_bill_id=b.id;

create or replace function refresh_food_bill_status(p_food_bill_id uuid)
returns void
language plpgsql
as $$
declare
  v_status text;
  v_total numeric;
  v_balance numeric;
begin
  select status,total_amount into v_status,v_total
  from food_bill where id=p_food_bill_id for update;
  if not found or v_status in ('draft','void') then return; end if;

  select balance_amount into v_balance
  from food_bill_balance where id=p_food_bill_id;

  update food_bill
  set status=case
      when v_total=0 or v_balance<=0 then 'paid'
      when v_balance<v_total then 'partially_paid'
      else 'issued'
    end,
    updated_at=now()
  where id=p_food_bill_id;
end;
$$;

create or replace function validate_food_payment_allocation()
returns trigger
language plpgsql
as $$
declare
  v_payment payment%rowtype;
  v_bill food_bill%rowtype;
  v_used numeric;
  v_balance numeric;
begin
  select * into v_payment from payment where id=new.payment_id for update;
  select * into v_bill from food_bill where id=new.food_bill_id for update;

  if not found then raise exception 'Food bill not found'; end if;
  if v_payment.status<>'posted' then raise exception 'Only posted payments can be allocated'; end if;
  if v_bill.status not in ('issued','partially_paid') then
    raise exception 'Payment can only be allocated to an issued food bill with an open balance';
  end if;
  if v_payment.family_id<>v_bill.family_id then raise exception 'Payment and food bill must belong to the same family'; end if;
  if v_payment.currency<>v_bill.currency then raise exception 'Payment and food bill currencies must match'; end if;
  if v_payment.student_id is not null and v_payment.student_id<>v_bill.student_id then
    raise exception 'Student-specific payment cannot be allocated to another student';
  end if;

  select
    coalesce((select sum(amount) from payment_allocation where payment_id=new.payment_id),0)
    + coalesce((select sum(amount) from food_payment_allocation where payment_id=new.payment_id),0)
  into v_used;

  if v_used+new.amount>v_payment.amount then
    raise exception 'Combined tuition and food allocations exceed the payment amount';
  end if;

  select balance_amount into v_balance from food_bill_balance where id=new.food_bill_id;
  if new.amount>v_balance then raise exception 'Payment allocation exceeds the food bill balance'; end if;

  return new;
end;
$$;

create trigger food_payment_allocation_validate
before insert on food_payment_allocation
for each row execute function validate_food_payment_allocation();

create or replace function validate_food_credit_allocation()
returns trigger
language plpgsql
as $$
declare
  v_credit credit_note%rowtype;
  v_bill food_bill%rowtype;
  v_used numeric;
  v_balance numeric;
begin
  select * into v_credit from credit_note where id=new.credit_note_id for update;
  select * into v_bill from food_bill where id=new.food_bill_id for update;

  if not found then raise exception 'Food bill not found'; end if;
  if v_credit.status<>'issued' then raise exception 'Only issued credits can be allocated'; end if;
  if v_bill.status not in ('issued','partially_paid') then
    raise exception 'Credit can only be allocated to an issued food bill with an open balance';
  end if;
  if v_credit.family_id<>v_bill.family_id then raise exception 'Credit and food bill must belong to the same family'; end if;
  if v_credit.currency<>v_bill.currency then raise exception 'Credit and food bill currencies must match'; end if;
  if v_credit.student_id is not null and v_credit.student_id<>v_bill.student_id then
    raise exception 'Student-specific credit cannot be allocated to another student';
  end if;

  select
    coalesce((select sum(amount) from credit_note_allocation where credit_note_id=new.credit_note_id),0)
    + coalesce((select sum(amount) from food_credit_allocation where credit_note_id=new.credit_note_id),0)
  into v_used;

  if v_used+new.amount>v_credit.amount then
    raise exception 'Combined tuition and food allocations exceed the credit amount';
  end if;

  select balance_amount into v_balance from food_bill_balance where id=new.food_bill_id;
  if new.amount>v_balance then raise exception 'Credit allocation exceeds the food bill balance'; end if;

  return new;
end;
$$;

create trigger food_credit_allocation_validate
before insert on food_credit_allocation
for each row execute function validate_food_credit_allocation();

create or replace function validate_payment_allocation()
returns trigger
language plpgsql
as $$
declare
  v_payment payment%rowtype;
  v_invoice invoice%rowtype;
  v_allocated numeric;
  v_balance numeric;
begin
  select * into v_payment from payment where id=new.payment_id for update;
  select * into v_invoice from invoice where id=new.invoice_id for update;

  if v_payment.status<>'posted' then raise exception 'Only posted payments can be allocated'; end if;
  if v_invoice.status not in ('issued','partially_paid') then
    raise exception 'Payments can only be allocated to issued invoices with an open balance';
  end if;
  if v_payment.family_id<>v_invoice.family_id then raise exception 'Payment and invoice must belong to the same family'; end if;
  if v_payment.currency<>v_invoice.currency then raise exception 'Payment and invoice currencies must match'; end if;
  if v_payment.student_id is not null and v_payment.student_id<>v_invoice.student_id then
    raise exception 'Student-specific payment cannot be allocated to another student';
  end if;

  select
    coalesce((select sum(amount) from payment_allocation where payment_id=new.payment_id),0)
    + coalesce((select sum(amount) from food_payment_allocation where payment_id=new.payment_id),0)
  into v_allocated;

  if v_allocated+new.amount>v_payment.amount then
    raise exception 'Combined tuition and food allocations exceed the payment amount';
  end if;

  select balance_amount into v_balance from invoice_balance where id=new.invoice_id;
  if new.amount>v_balance then raise exception 'Payment allocation exceeds the invoice balance'; end if;

  return new;
end;
$$;

create or replace function validate_credit_note_allocation()
returns trigger
language plpgsql
as $$
declare
  v_credit credit_note%rowtype;
  v_invoice invoice%rowtype;
  v_allocated numeric;
  v_balance numeric;
begin
  select * into v_credit from credit_note where id=new.credit_note_id for update;
  select * into v_invoice from invoice where id=new.invoice_id for update;

  if v_credit.status<>'issued' then raise exception 'Only issued credit notes can be allocated'; end if;
  if v_invoice.status not in ('issued','partially_paid') then
    raise exception 'Credits can only be allocated to issued invoices with an open balance';
  end if;
  if v_credit.family_id<>v_invoice.family_id then raise exception 'Credit note and invoice must belong to the same family'; end if;
  if v_credit.currency<>v_invoice.currency then raise exception 'Credit note and invoice currencies must match'; end if;
  if v_credit.student_id is not null and v_credit.student_id<>v_invoice.student_id then
    raise exception 'Student-specific credit cannot be allocated to another student';
  end if;

  select
    coalesce((select sum(amount) from credit_note_allocation where credit_note_id=new.credit_note_id),0)
    + coalesce((select sum(amount) from food_credit_allocation where credit_note_id=new.credit_note_id),0)
  into v_allocated;

  if v_allocated+new.amount>v_credit.amount then
    raise exception 'Combined tuition and food allocations exceed the credit amount';
  end if;

  select balance_amount into v_balance from invoice_balance where id=new.invoice_id;
  if new.amount>v_balance then raise exception 'Credit allocation exceeds the invoice balance'; end if;

  return new;
end;
$$;

create or replace function refresh_food_after_allocation()
returns trigger
language plpgsql
as $$
begin
  perform refresh_food_bill_status(new.food_bill_id);
  return new;
end;
$$;

create trigger food_payment_allocation_refresh
after insert on food_payment_allocation
for each row execute function refresh_food_after_allocation();

create trigger food_credit_allocation_refresh
after insert on food_credit_allocation
for each row execute function refresh_food_after_allocation();

create or replace function refresh_food_after_payment_status()
returns trigger
language plpgsql
as $$
declare
  v_bill_id uuid;
begin
  if old.status is distinct from new.status then
    for v_bill_id in
      select distinct food_bill_id from food_payment_allocation where payment_id=new.id
    loop
      perform refresh_food_bill_status(v_bill_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger food_payment_status_refresh
after update of status on payment
for each row execute function refresh_food_after_payment_status();

create or replace function refresh_food_after_credit_status()
returns trigger
language plpgsql
as $$
declare
  v_bill_id uuid;
begin
  if old.status is distinct from new.status then
    for v_bill_id in
      select distinct food_bill_id from food_credit_allocation where credit_note_id=new.id
    loop
      perform refresh_food_bill_status(v_bill_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger food_credit_status_refresh
after update of status on credit_note
for each row execute function refresh_food_after_credit_status();

create or replace view payment_balance as
select
  p.id,p.receipt_number,p.family_id,p.student_id,p.payment_kind,p.amount,p.currency,
  p.received_on,p.method,p.reference,p.notes,p.status,p.reversed_at,p.reversed_by,
  p.reversal_reason,p.created_at,p.created_by,
  coalesce(a.allocated_amount,0)::numeric(12,2) as allocated_amount,
  (p.amount-coalesce(a.allocated_amount,0))::numeric(12,2) as unallocated_amount,
  case
    when p.status='reversed' then 'reversed'
    when p.amount-coalesce(a.allocated_amount,0)<=0 then 'fully_allocated'
    when p.payment_kind='prepayment' then 'prepayment'
    when coalesce(a.allocated_amount,0)>0 then 'overpayment'
    else 'unapplied_payment'
  end as balance_type,
  p.payment_account_id,p.cheque_number,p.cheque_due_on
from payment p
left join (
  select x.payment_id,sum(x.amount) as allocated_amount
  from (
    select payment_id,amount from payment_allocation
    union all
    select payment_id,amount from food_payment_allocation
  ) x
  join payment p2 on p2.id=x.payment_id and p2.status='posted'
  group by x.payment_id
) a on a.payment_id=p.id;

create or replace view credit_note_balance as
select
  c.*,
  coalesce(a.allocated_amount,0)::numeric(12,2) as allocated_amount,
  (c.amount-coalesce(a.allocated_amount,0))::numeric(12,2) as unallocated_amount
from credit_note c
left join (
  select x.credit_note_id,sum(x.amount) as allocated_amount
  from (
    select credit_note_id,amount from credit_note_allocation
    union all
    select credit_note_id,amount from food_credit_allocation
  ) x
  join credit_note c2 on c2.id=x.credit_note_id and c2.status='issued'
  group by x.credit_note_id
) a on a.credit_note_id=c.id;

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('food_income','Food Income','Income credited when student food bills are issued.','income')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create or replace function accounting_post_food_bill(
  p_food_bill_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_bill food_bill%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_ar uuid;
  v_income uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='food_bill' and source_id=p_food_bill_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_bill from food_bill where id=p_food_bill_id;
  if not found or v_bill.status not in ('issued','partially_paid','paid') then
    raise exception 'Only issued food bills can be posted to accounting';
  end if;
  if v_bill.total_amount<=0 then raise exception 'Food bill total must be greater than zero'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_income := accounting_mapped_account('food_income');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    accounting_system_journal(),'system',v_bill.issued_on,v_bill.currency,
    'Food bill '||v_bill.bill_number,v_bill.bill_number,
    'food_bill',v_bill.id,p_user_id
  ) returning id into v_entry;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry,1,v_ar,'Student food receivable',v_bill.total_amount,0,v_bill.family_id,v_bill.student_id,p_user_id),
    (v_entry,2,v_income,'Student food income',0,v_bill.total_amount,v_bill.family_id,v_bill.student_id,p_user_id);

  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function accounting_post_food_payment_allocation(
  p_allocation_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v record;
  v_existing uuid;
  v_entry uuid;
  v_ar uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='food_payment_allocation' and source_id=p_allocation_id;
  if v_existing is not null then return v_existing; end if;

  select a.id,a.amount,a.allocated_on,p.receipt_number,p.currency,p.family_id,b.student_id
  into v
  from food_payment_allocation a
  join payment p on p.id=a.payment_id
  join food_bill b on b.id=a.food_bill_id
  where a.id=p_allocation_id and p.status='posted';

  if not found then raise exception 'Posted food payment allocation not found'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    accounting_system_journal(),'system',v.allocated_on,v.currency,
    'Allocate family funds to food receivable',v.receipt_number,
    'food_payment_allocation',v.id,p_user_id
  ) returning id into v_entry;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry,1,v_deposits,'Apply customer deposit to food',v.amount,0,v.family_id,v.student_id,p_user_id),
    (v_entry,2,v_ar,'Settle student food receivable',0,v.amount,v.family_id,v.student_id,p_user_id);

  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function accounting_post_food_credit_allocation(
  p_allocation_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v record;
  v_existing uuid;
  v_entry uuid;
  v_ar uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='food_credit_allocation' and source_id=p_allocation_id;
  if v_existing is not null then return v_existing; end if;

  select a.id,a.amount,a.allocated_on,c.credit_note_number,c.currency,c.family_id,b.student_id
  into v
  from food_credit_allocation a
  join credit_note c on c.id=a.credit_note_id
  join food_bill b on b.id=a.food_bill_id
  where a.id=p_allocation_id and c.status='issued';

  if not found then raise exception 'Issued food credit allocation not found'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    accounting_system_journal(),'system',v.allocated_on,v.currency,
    'Allocate family credit to food receivable',v.credit_note_number,
    'food_credit_allocation',v.id,p_user_id
  ) returning id into v_entry;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry,1,v_deposits,'Apply family credit to food',v.amount,0,v.family_id,v.student_id,p_user_id),
    (v_entry,2,v_ar,'Settle student food receivable',0,v.amount,v.family_id,v.student_id,p_user_id);

  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function issue_food_bill(
  p_food_bill_id uuid,
  p_issued_on date,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_bill food_bill%rowtype;
  v_entry uuid;
begin
  select * into v_bill from food_bill where id=p_food_bill_id for update;
  if not found then raise exception 'Food bill not found'; end if;
  if v_bill.status<>'draft' then raise exception 'Only draft food bills can be issued'; end if;
  perform assert_school_term_open(v_bill.term_id);
  if v_bill.total_amount<=0 then raise exception 'Food bill requires at least one positive line'; end if;

  update food_bill
  set status='issued',issued_on=p_issued_on,updated_at=now(),updated_by=p_user_id
  where id=p_food_bill_id;

  v_entry := accounting_post_food_bill(p_food_bill_id,p_user_id);
  return v_entry;
end;
$$;

create or replace function void_food_bill(
  p_food_bill_id uuid,
  p_reversal_date date,
  p_user_id uuid default null,
  p_reason text default 'Food bill void'
)
returns void
language plpgsql
as $$
declare
  v_bill food_bill%rowtype;
  v_entry uuid;
begin
  select * into v_bill from food_bill where id=p_food_bill_id for update;
  if not found then raise exception 'Food bill not found'; end if;
  if v_bill.status not in ('issued','partially_paid','paid') then
    raise exception 'Only issued food bills can be voided';
  end if;
  if exists (select 1 from food_payment_allocation where food_bill_id=p_food_bill_id)
     or exists (select 1 from food_credit_allocation where food_bill_id=p_food_bill_id) then
    raise exception 'Reverse allocated payments or credits before voiding the food bill';
  end if;

  select id into v_entry
  from journal_entry
  where source_type='food_bill' and source_id=p_food_bill_id and status='posted';

  if v_entry is not null then
    perform reverse_journal_entry(v_entry,p_reversal_date,p_user_id,p_reason);
  end if;

  update food_bill
  set status='void',voided_at=now(),voided_by=p_user_id,void_reason=p_reason,
      updated_at=now(),updated_by=p_user_id
  where id=p_food_bill_id;
end;
$$;

create or replace function accounting_reverse_payment(
  p_payment_id uuid,
  p_posting_date date,
  p_user_id uuid default null,
  p_reason text default 'Payment reversal'
)
returns void
language plpgsql
as $$
declare
  v_entry_id uuid;
begin
  for v_entry_id in
    select je.id
    from journal_entry je
    where je.status='posted'
      and (
        (je.source_type='billing_payment' and je.source_id=p_payment_id)
        or (
          je.source_type='billing_payment_allocation'
          and je.source_id in (select pa.id from payment_allocation pa where pa.payment_id=p_payment_id)
        )
        or (
          je.source_type='food_payment_allocation'
          and je.source_id in (select fa.id from food_payment_allocation fa where fa.payment_id=p_payment_id)
        )
      )
    order by
      case
        when je.source_type in ('billing_payment_allocation','food_payment_allocation') then 1
        else 2
      end,
      je.posted_at
  loop
    perform reverse_journal_entry(v_entry_id,p_posting_date,p_user_id,p_reason);
  end loop;
end;
$$;

create or replace function accounting_reverse_credit_note(
  p_credit_note_id uuid,
  p_posting_date date,
  p_user_id uuid default null,
  p_reason text default 'Credit note reversal'
)
returns void
language plpgsql
as $$
declare
  v_entry_id uuid;
begin
  for v_entry_id in
    select je.id
    from journal_entry je
    where je.status='posted'
      and (
        (je.source_type='billing_credit_note' and je.source_id=p_credit_note_id)
        or (
          je.source_type='billing_credit_allocation'
          and je.source_id in (select ca.id from credit_note_allocation ca where ca.credit_note_id=p_credit_note_id)
        )
        or (
          je.source_type='food_credit_allocation'
          and je.source_id in (select fa.id from food_credit_allocation fa where fa.credit_note_id=p_credit_note_id)
        )
      )
    order by
      case
        when je.source_type in ('billing_credit_allocation','food_credit_allocation') then 1
        else 2
      end,
      je.posted_at
  loop
    perform reverse_journal_entry(v_entry_id,p_posting_date,p_user_id,p_reason);
  end loop;
end;
$$;

create or replace view family_ledger as
select
  i.family_id,i.student_id,i.issued_on as entry_date,i.created_at as occurred_at,
  'invoice'::text as entry_type,i.id as source_id,i.invoice_number as reference,
  ('Term invoice '||t.name)::text as description,
  i.total_amount::numeric(12,2) as debit_amount,0::numeric(12,2) as credit_amount
from invoice i join school_term t on t.id=i.term_id
where i.status not in ('draft','void')
union all
select
  b.family_id,b.student_id,b.issued_on,b.created_at,'food_bill',b.id,b.bill_number,
  ('Food bill '||p.name||' · '||b.period_start||' to '||b.period_end)::text,
  b.total_amount::numeric(12,2),0::numeric(12,2)
from food_bill b join food_package p on p.id=b.food_package_id
where b.issued_on is not null
union all
select
  b.family_id,b.student_id,coalesce(b.voided_at::date,b.issued_on),b.voided_at,
  'food_bill_void',b.id,b.bill_number,coalesce(b.void_reason,'Food bill voided'),
  0::numeric(12,2),b.total_amount::numeric(12,2)
from food_bill b where b.status='void'
union all
select
  p.family_id,p.student_id,p.received_on,p.created_at,
  case when p.payment_kind='prepayment' then 'prepayment' else 'payment' end,
  p.id,p.receipt_number,coalesce(p.notes,'Payment received'),
  0::numeric(12,2),p.amount::numeric(12,2)
from payment p
union all
select
  p.family_id,p.student_id,coalesce(p.reversed_at::date,p.received_on),p.reversed_at,
  'payment_reversal',p.id,p.receipt_number,coalesce(p.reversal_reason,'Payment reversed'),
  p.amount::numeric(12,2),0::numeric(12,2)
from payment p where p.status='reversed'
union all
select
  c.family_id,c.student_id,c.issued_on,c.created_at,'credit_note',c.id,c.credit_note_number,
  c.reason,0::numeric(12,2),c.amount::numeric(12,2)
from credit_note c
union all
select
  c.family_id,c.student_id,coalesce(c.reversed_at::date,c.issued_on),c.reversed_at,
  'credit_note_reversal',c.id,c.credit_note_number,coalesce(c.reversal_reason,'Credit note reversed'),
  c.amount::numeric(12,2),0::numeric(12,2)
from credit_note c where c.status='reversed';

create or replace view student_ledger as
select
  i.family_id,i.student_id,i.issued_on as entry_date,i.created_at as occurred_at,
  'invoice'::text as entry_type,i.id as source_id,i.invoice_number as reference,
  ('Term invoice '||t.name)::text as description,
  i.total_amount::numeric(12,2) as debit_amount,0::numeric(12,2) as credit_amount
from invoice i join school_term t on t.id=i.term_id
where i.status not in ('draft','void')
union all
select
  b.family_id,b.student_id,b.issued_on,b.created_at,'food_bill',b.id,b.bill_number,
  ('Food bill '||p.name||' · '||b.period_start||' to '||b.period_end)::text,
  b.total_amount::numeric(12,2),0::numeric(12,2)
from food_bill b join food_package p on p.id=b.food_package_id
where b.issued_on is not null
union all
select
  b.family_id,b.student_id,coalesce(b.voided_at::date,b.issued_on),b.voided_at,
  'food_bill_void',b.id,b.bill_number,coalesce(b.void_reason,'Food bill voided'),
  0::numeric(12,2),b.total_amount::numeric(12,2)
from food_bill b where b.status='void'
union all
select
  p.family_id,p.student_id,p.received_on,p.created_at,
  case when p.payment_kind='prepayment' then 'prepayment' else 'payment' end,
  p.id,p.receipt_number,coalesce(p.notes,'Payment received'),
  0::numeric(12,2),p.amount::numeric(12,2)
from payment p where p.student_id is not null
union all
select
  p.family_id,p.student_id,coalesce(p.reversed_at::date,p.received_on),p.reversed_at,
  'payment_reversal',p.id,p.receipt_number,coalesce(p.reversal_reason,'Payment reversed'),
  p.amount::numeric(12,2),0::numeric(12,2)
from payment p where p.student_id is not null and p.status='reversed'
union all
select
  p.family_id,i.student_id,p.received_on,pa.created_at,'payment_allocation',pa.id,p.receipt_number,
  'Family payment allocated to invoice',0::numeric(12,2),pa.amount::numeric(12,2)
from payment_allocation pa
join payment p on p.id=pa.payment_id and p.student_id is null
join invoice i on i.id=pa.invoice_id
union all
select
  p.family_id,i.student_id,coalesce(p.reversed_at::date,p.received_on),p.reversed_at,
  'payment_allocation_reversal',pa.id,p.receipt_number,coalesce(p.reversal_reason,'Family payment allocation reversed'),
  pa.amount::numeric(12,2),0::numeric(12,2)
from payment_allocation pa
join payment p on p.id=pa.payment_id and p.student_id is null and p.status='reversed'
join invoice i on i.id=pa.invoice_id
union all
select
  p.family_id,b.student_id,p.received_on,fa.created_at,'food_payment_allocation',fa.id,p.receipt_number,
  'Family payment allocated to food bill',0::numeric(12,2),fa.amount::numeric(12,2)
from food_payment_allocation fa
join payment p on p.id=fa.payment_id and p.student_id is null
join food_bill b on b.id=fa.food_bill_id
union all
select
  p.family_id,b.student_id,coalesce(p.reversed_at::date,p.received_on),p.reversed_at,
  'food_payment_allocation_reversal',fa.id,p.receipt_number,coalesce(p.reversal_reason,'Family food payment allocation reversed'),
  fa.amount::numeric(12,2),0::numeric(12,2)
from food_payment_allocation fa
join payment p on p.id=fa.payment_id and p.student_id is null and p.status='reversed'
join food_bill b on b.id=fa.food_bill_id
union all
select
  c.family_id,c.student_id,c.issued_on,c.created_at,'credit_note',c.id,c.credit_note_number,
  c.reason,0::numeric(12,2),c.amount::numeric(12,2)
from credit_note c where c.student_id is not null
union all
select
  c.family_id,c.student_id,coalesce(c.reversed_at::date,c.issued_on),c.reversed_at,
  'credit_note_reversal',c.id,c.credit_note_number,coalesce(c.reversal_reason,'Credit note reversed'),
  c.amount::numeric(12,2),0::numeric(12,2)
from credit_note c where c.student_id is not null and c.status='reversed'
union all
select
  c.family_id,i.student_id,c.issued_on,ca.created_at,'credit_allocation',ca.id,c.credit_note_number,
  'Family credit allocated to invoice',0::numeric(12,2),ca.amount::numeric(12,2)
from credit_note_allocation ca
join credit_note c on c.id=ca.credit_note_id and c.student_id is null
join invoice i on i.id=ca.invoice_id
union all
select
  c.family_id,i.student_id,coalesce(c.reversed_at::date,c.issued_on),c.reversed_at,
  'credit_allocation_reversal',ca.id,c.credit_note_number,coalesce(c.reversal_reason,'Family credit allocation reversed'),
  ca.amount::numeric(12,2),0::numeric(12,2)
from credit_note_allocation ca
join credit_note c on c.id=ca.credit_note_id and c.student_id is null and c.status='reversed'
join invoice i on i.id=ca.invoice_id
union all
select
  c.family_id,b.student_id,c.issued_on,fa.created_at,'food_credit_allocation',fa.id,c.credit_note_number,
  'Family credit allocated to food bill',0::numeric(12,2),fa.amount::numeric(12,2)
from food_credit_allocation fa
join credit_note c on c.id=fa.credit_note_id and c.student_id is null
join food_bill b on b.id=fa.food_bill_id
union all
select
  c.family_id,b.student_id,coalesce(c.reversed_at::date,c.issued_on),c.reversed_at,
  'food_credit_allocation_reversal',fa.id,c.credit_note_number,coalesce(c.reversal_reason,'Family food credit allocation reversed'),
  fa.amount::numeric(12,2),0::numeric(12,2)
from food_credit_allocation fa
join credit_note c on c.id=fa.credit_note_id and c.student_id is null and c.status='reversed'
join food_bill b on b.id=fa.food_bill_id;

create or replace function report_receivables(p_through date)
returns table (
  invoice_id uuid, invoice_number text, family_id uuid, family_number text, family_name text,
  student_id uuid, student_number text, student_name text, issued_on date, due_on date,
  currency text, total_amount numeric(12,2), paid_amount numeric(12,2),
  credit_amount numeric(12,2), balance_amount numeric(12,2)
)
language sql stable
as $$
  with tuition_paid as (
    select pa.invoice_id,sum(pa.amount)::numeric(12,2) amount
    from payment_allocation pa join payment p on p.id=pa.payment_id
    where pa.allocated_on<=p_through and p.received_on<=p_through
      and (p.status='posted' or p.reversed_at::date>p_through)
    group by pa.invoice_id
  ), tuition_credit as (
    select ca.invoice_id,sum(ca.amount)::numeric(12,2) amount
    from credit_note_allocation ca join credit_note c on c.id=ca.credit_note_id
    where ca.allocated_on<=p_through and c.issued_on<=p_through
      and (c.status='issued' or c.reversed_at::date>p_through)
    group by ca.invoice_id
  ), food_paid as (
    select a.food_bill_id,sum(a.amount)::numeric(12,2) amount
    from food_payment_allocation a join payment p on p.id=a.payment_id
    where a.allocated_on<=p_through and p.received_on<=p_through
      and (p.status='posted' or p.reversed_at::date>p_through)
    group by a.food_bill_id
  ), food_credit as (
    select a.food_bill_id,sum(a.amount)::numeric(12,2) amount
    from food_credit_allocation a join credit_note c on c.id=a.credit_note_id
    where a.allocated_on<=p_through and c.issued_on<=p_through
      and (c.status='issued' or c.reversed_at::date>p_through)
    group by a.food_bill_id
  )
  select i.id,i.invoice_number,i.family_id,f.family_number,f.display_name,
    i.student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name),
    i.issued_on,i.due_on,i.currency,i.total_amount,
    coalesce(p.amount,0)::numeric(12,2),coalesce(c.amount,0)::numeric(12,2),
    greatest(i.total_amount-coalesce(p.amount,0)-coalesce(c.amount,0),0)::numeric(12,2)
  from invoice i
  join family f on f.id=i.family_id
  join student s on s.id=i.student_id
  left join tuition_paid p on p.invoice_id=i.id
  left join tuition_credit c on c.invoice_id=i.id
  where i.issued_on is not null and i.issued_on<=p_through and i.status not in ('draft','void')
  union all
  select b.id,b.bill_number,b.family_id,f.family_number,f.display_name,
    b.student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name),
    b.issued_on,b.due_on,b.currency,b.total_amount,
    coalesce(p.amount,0)::numeric(12,2),coalesce(c.amount,0)::numeric(12,2),
    greatest(b.total_amount-coalesce(p.amount,0)-coalesce(c.amount,0),0)::numeric(12,2)
  from food_bill b
  join family f on f.id=b.family_id
  join student s on s.id=b.student_id
  left join food_paid p on p.food_bill_id=b.id
  left join food_credit c on c.food_bill_id=b.id
  where b.issued_on is not null and b.issued_on<=p_through
    and (b.status<>'void' or b.voided_at::date>p_through);
$$;

create or replace function report_family_credits(p_through date)
returns table (
  family_id uuid, family_number text, family_name text, currency text,
  unallocated_payments numeric(14,2), unallocated_credits numeric(14,2),
  refunded_amount numeric(14,2), available_credit numeric(14,2)
)
language sql stable
as $$
  with payment_totals as (
    select p.id,p.family_id,p.currency,p.amount,
      (
        coalesce((select sum(pa.amount) from payment_allocation pa
          where pa.payment_id=p.id and pa.allocated_on<=p_through),0)
        + coalesce((select sum(fa.amount) from food_payment_allocation fa
          where fa.payment_id=p.id and fa.allocated_on<=p_through),0)
      ) as allocated
    from payment p
    where p.received_on<=p_through and (p.status='posted' or p.reversed_at::date>p_through)
  ), credit_totals as (
    select c.id,c.family_id,c.currency,c.amount,
      (
        coalesce((select sum(ca.amount) from credit_note_allocation ca
          where ca.credit_note_id=c.id and ca.allocated_on<=p_through),0)
        + coalesce((select sum(fa.amount) from food_credit_allocation fa
          where fa.credit_note_id=c.id and fa.allocated_on<=p_through),0)
      ) as allocated
    from credit_note c
    where c.issued_on<=p_through and (c.status='issued' or c.reversed_at::date>p_through)
  ), refunds as (
    select r.family_id,r.currency,sum(r.amount)::numeric(14,2) as amount
    from parent_refund r
    where r.refunded_on<=p_through and (r.status='posted' or r.reversed_at::date>p_through)
    group by r.family_id,r.currency
  ), currencies as (
    select family_id,currency from payment_totals
    union select family_id,currency from credit_totals
    union select family_id,currency from refunds
  ), p as (
    select family_id,currency,sum(greatest(amount-allocated,0))::numeric(14,2) amount
    from payment_totals group by family_id,currency
  ), c as (
    select family_id,currency,sum(greatest(amount-allocated,0))::numeric(14,2) amount
    from credit_totals group by family_id,currency
  )
  select x.family_id,f.family_number,f.display_name,x.currency,
    coalesce(p.amount,0)::numeric(14,2),coalesce(c.amount,0)::numeric(14,2),
    coalesce(r.amount,0)::numeric(14,2),
    (coalesce(p.amount,0)+coalesce(c.amount,0)-coalesce(r.amount,0))::numeric(14,2)
  from currencies x
  join family f on f.id=x.family_id
  left join p on p.family_id=x.family_id and p.currency=x.currency
  left join c on c.family_id=x.family_id and c.currency=x.currency
  left join refunds r on r.family_id=x.family_id and r.currency=x.currency;
$$;

create or replace view food_income_report as
select
  b.id,b.bill_number,b.issued_on,b.due_on,b.period_start,b.period_end,b.status,
  b.currency,b.total_amount,bb.paid_amount,bb.credit_amount,bb.balance_amount,
  f.id as family_id,f.family_number,f.display_name as family_name,
  s.id as student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
  p.id as food_package_id,p.code as package_code,p.name as package_name,p.package_kind
from food_bill b
join food_bill_balance bb on bb.id=b.id
join family f on f.id=b.family_id
join student s on s.id=b.student_id
join food_package p on p.id=b.food_package_id
where b.issued_on is not null;

insert into permission(key,description) values
  ('food.view','View food items, packages, selections, bills, receipts and food income'),
  ('food.manage','Create and maintain food items, prices, packages and student selections'),
  ('food.billing','Create, issue and void student food bills'),
  ('food.payments','Record food payments and allocate parent payments or credits to food bills')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
