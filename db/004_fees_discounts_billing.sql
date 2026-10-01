create table billing_configuration (
  id smallint primary key default 1 check (id = 1),
  discount_combination_mode text not null default 'best_single'
    check (discount_combination_mode in ('best_single','additive','sequential')),
  max_discount_percent numeric(5,2) not null default 100.00
    check (max_discount_percent > 0 and max_discount_percent <= 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

insert into billing_configuration(id) values (1)
on conflict (id) do nothing;

create table discount_definition (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  system_key text unique
    check (system_key is null or system_key in ('sibling','teacher_child','custom')),
  discount_kind text not null
    check (discount_kind in ('percentage','fixed')),
  default_value numeric(12,2) not null
    check (
      default_value >= 0
      and (discount_kind <> 'percentage' or default_value <= 100)
    ),
  default_priority integer not null default 100 check (default_priority between 1 and 1000),
  requires_approval boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);

insert into discount_definition(
  code,name,system_key,discount_kind,default_value,default_priority,requires_approval
) values
  ('SIBLING10','Sibling discount','sibling','percentage',10.00,20,true),
  ('TEACHER50','Teacher-child discount','teacher_child','percentage',50.00,10,true),
  ('CUSTOM','Custom discount','custom','percentage',0.00,50,true)
on conflict (code) do update set
  name=excluded.name,
  system_key=excluded.system_key,
  discount_kind=excluded.discount_kind,
  default_value=excluded.default_value,
  default_priority=excluded.default_priority,
  requires_approval=excluded.requires_approval;

create table student_discount (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references student(id) on delete restrict,
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  discount_definition_id uuid not null references discount_definition(id) on delete restrict,
  custom_name text,
  override_kind text check (override_kind is null or override_kind in ('percentage','fixed')),
  override_value numeric(12,2),
  priority_override integer check (priority_override is null or priority_override between 1 and 1000),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','revoked')),
  eligibility_note text,
  requested_at timestamptz not null default now(),
  requested_by uuid references app_user(id) on delete set null,
  reviewed_at timestamptz,
  reviewed_by uuid references app_user(id) on delete set null,
  review_note text,
  revoked_at timestamptz,
  revoked_by uuid references app_user(id) on delete set null,
  foreign key (term_id, school_year_id)
    references school_term(id, school_year_id) on delete restrict,
  check (
    (override_kind is null and override_value is null)
    or
    (
      override_kind is not null
      and override_value is not null
      and override_value > 0
      and (override_kind <> 'percentage' or override_value <= 100)
    )
  )
);
create index student_discount_student_term_idx
  on student_discount(student_id, term_id, status);
create index student_discount_review_idx
  on student_discount(status, requested_at);

create or replace function validate_student_discount()
returns trigger
language plpgsql
as $$
declare
  v_system_key text;
begin
  select system_key into v_system_key
  from discount_definition
  where id = new.discount_definition_id;

  if v_system_key = 'custom' then
    if new.custom_name is null or btrim(new.custom_name) = '' then
      raise exception 'Custom discount name is required';
    end if;
    if new.override_kind is null or new.override_value is null then
      raise exception 'Custom discount kind and value are required';
    end if;
  elsif new.override_kind is not null or new.override_value is not null then
    raise exception 'System discount values cannot be overridden';
  end if;

  return new;
end;
$$;

create trigger student_discount_validate
before insert or update on student_discount
for each row execute function validate_student_discount();

create table discount_history (
  id bigint generated always as identity primary key,
  student_discount_id uuid not null references student_discount(id) on delete restrict,
  event_type text not null
    check (event_type in ('requested','approved','rejected','revoked')),
  snapshot jsonb not null,
  note text,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references app_user(id) on delete set null
);
create index discount_history_discount_idx
  on discount_history(student_discount_id, occurred_at desc, id desc);

create or replace function prevent_discount_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'discount_history is append-only';
end;
$$;

create trigger discount_history_immutable
before update or delete on discount_history
for each row execute function prevent_discount_history_mutation();

create or replace view student_discount_effective as
select
  sd.id,
  sd.student_id,
  sd.school_year_id,
  sd.term_id,
  sd.discount_definition_id,
  d.code,
  d.system_key,
  coalesce(sd.custom_name,d.name) as discount_name,
  coalesce(sd.override_kind,d.discount_kind) as discount_kind,
  coalesce(sd.override_value,d.default_value) as discount_value,
  coalesce(sd.priority_override,d.default_priority) as priority,
  d.requires_approval,
  sd.status,
  sd.eligibility_note,
  sd.requested_at,
  sd.requested_by,
  sd.reviewed_at,
  sd.reviewed_by,
  sd.review_note,
  sd.revoked_at,
  sd.revoked_by
from student_discount sd
join discount_definition d on d.id=sd.discount_definition_id;

create table fee_schedule (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  name text not null,
  standard_fee numeric(12,2) not null check (standard_fee > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  activated_at timestamptz,
  activated_by uuid references app_user(id) on delete set null,
  foreign key (term_id, school_year_id)
    references school_term(id, school_year_id) on delete restrict,
  unique (term_id, name)
);
create unique index fee_schedule_id_term_year_unique
  on fee_schedule(id, term_id, school_year_id);
create unique index one_active_fee_schedule_per_term
  on fee_schedule(term_id) where status='active';

create table invoice (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid not null,
  school_year_id uuid not null references school_year(id) on delete restrict,
  term_id uuid not null,
  fee_schedule_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft'
    check (status in ('draft','issued','partially_paid','paid','void')),
  due_on date not null,
  issued_on date,
  subtotal_amount numeric(12,2) not null default 0 check (subtotal_amount >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  foreign key (student_id, family_id)
    references student(id, family_id) on delete restrict,
  foreign key (term_id, school_year_id)
    references school_term(id, school_year_id) on delete restrict,
  foreign key (fee_schedule_id, term_id, school_year_id)
    references fee_schedule(id, term_id, school_year_id) on delete restrict,
  check ((status='draft' and issued_on is null) or status='void' or issued_on is not null)
);
create unique index invoice_id_family_unique on invoice(id, family_id);
create unique index one_live_term_invoice_per_student
  on invoice(student_id, term_id) where status <> 'void';
create index invoice_family_idx on invoice(family_id, created_at desc);
create index invoice_student_idx on invoice(student_id, created_at desc);
create index invoice_status_idx on invoice(status, due_on);

create table invoice_line (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoice(id) on delete restrict,
  line_type text not null check (line_type in ('nursery_fee','additional_charge')),
  description text not null,
  gross_amount numeric(12,2) not null check (gross_amount >= 0),
  discount_amount numeric(12,2) not null default 0
    check (discount_amount >= 0 and discount_amount <= gross_amount),
  net_amount numeric(12,2) generated always as (gross_amount - discount_amount) stored,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create unique index one_nursery_fee_line_per_invoice
  on invoice_line(invoice_id) where line_type='nursery_fee';
create index invoice_line_invoice_idx on invoice_line(invoice_id);

create table invoice_line_discount (
  id uuid primary key default gen_random_uuid(),
  invoice_line_id uuid not null references invoice_line(id) on delete restrict,
  student_discount_id uuid not null references student_discount(id) on delete restrict,
  discount_label text not null,
  discount_kind text not null check (discount_kind in ('percentage','fixed')),
  discount_value numeric(12,2) not null,
  priority integer not null,
  application_order integer not null,
  applied_amount numeric(12,2) not null check (applied_amount > 0),
  combination_mode text not null
    check (combination_mode in ('best_single','additive','sequential')),
  created_at timestamptz not null default now(),
  unique (invoice_line_id, student_discount_id)
);
create index invoice_line_discount_line_idx on invoice_line_discount(invoice_line_id);

create or replace function ensure_invoice_draft_for_line()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
  v_status text;
begin
  v_invoice_id := case when tg_op='DELETE' then old.invoice_id else new.invoice_id end;
  select status into v_status from invoice where id=v_invoice_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'Issued invoice lines are immutable; use a credit note or reversal';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger invoice_line_draft_only
before insert or update or delete on invoice_line
for each row execute function ensure_invoice_draft_for_line();

create or replace function ensure_invoice_line_discount_draft()
returns trigger
language plpgsql
as $$
declare
  v_line_id uuid;
  v_status text;
begin
  v_line_id := case when tg_op='DELETE' then old.invoice_line_id else new.invoice_line_id end;
  select i.status into v_status
  from invoice_line l
  join invoice i on i.id=l.invoice_id
  where l.id=v_line_id
  for update of i;

  if v_status is distinct from 'draft' then
    raise exception 'Issued invoice discount snapshots are immutable';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger invoice_line_discount_draft_only
before insert or update or delete on invoice_line_discount
for each row execute function ensure_invoice_line_discount_draft();

create or replace function recalculate_invoice_totals()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
begin
  v_invoice_id := case when tg_op='DELETE' then old.invoice_id else new.invoice_id end;
  update invoice i
  set
    subtotal_amount=coalesce(x.subtotal,0),
    discount_amount=coalesce(x.discount_total,0),
    total_amount=coalesce(x.total,0),
    updated_at=now()
  from (
    select
      coalesce(sum(gross_amount),0)::numeric(12,2) as subtotal,
      coalesce(sum(discount_amount),0)::numeric(12,2) as discount_total,
      coalesce(sum(net_amount),0)::numeric(12,2) as total
    from invoice_line
    where invoice_id=v_invoice_id
  ) x
  where i.id=v_invoice_id;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger invoice_line_recalculate
after insert or update or delete on invoice_line
for each row execute function recalculate_invoice_totals();

create or replace function billing_discount_breakdown(
  p_student_id uuid,
  p_term_id uuid,
  p_base_amount numeric
)
returns table (
  student_discount_id uuid,
  discount_label text,
  discount_kind text,
  discount_value numeric,
  priority integer,
  application_order integer,
  applied_amount numeric,
  combination_mode text
)
language plpgsql
stable
as $$
declare
  v_mode text;
  v_max_percent numeric;
  v_cap numeric;
  v_remaining numeric;
  v_total numeric := 0;
  v_order integer := 0;
  v_candidate numeric;
  v_allowed numeric;
  rec record;
begin
  if p_base_amount < 0 then
    raise exception 'Base amount cannot be negative';
  end if;

  select discount_combination_mode,max_discount_percent
  into v_mode,v_max_percent
  from billing_configuration
  where id=1;

  v_cap := round(p_base_amount * v_max_percent / 100.0,2);
  v_remaining := p_base_amount;

  if v_mode='best_single' then
    return query
    with candidates as (
      select
        e.id,
        e.discount_name,
        e.discount_kind,
        e.discount_value,
        e.priority,
        case
          when e.discount_kind='percentage'
            then round(p_base_amount * e.discount_value / 100.0,2)
          else e.discount_value
        end as candidate_amount
      from student_discount_effective e
      join school_term t on t.id=p_term_id and t.school_year_id=e.school_year_id
      where e.student_id=p_student_id
        and e.term_id=p_term_id
        and e.status='approved'
        and (
          e.system_key <> 'sibling'
          or exists (
            select 1
            from student target
            join student sibling
              on sibling.family_id=target.family_id
             and sibling.id<>target.id
            join student_enrollment se
              on se.student_id=sibling.id
             and se.school_year_id=t.school_year_id
             and se.status<>'cancelled'
            join student_term_enrollment ste
              on ste.enrollment_id=se.id
             and ste.term_id=p_term_id
             and ste.status<>'cancelled'
            where target.id=p_student_id
          )
        )
    )
    select
      c.id,
      c.discount_name,
      c.discount_kind,
      c.discount_value,
      c.priority,
      1,
      least(c.candidate_amount,v_cap,p_base_amount)::numeric,
      v_mode
    from candidates c
    where c.candidate_amount > 0
    order by c.candidate_amount desc,c.priority,c.id
    limit 1;
    return;
  end if;

  for rec in
    select
      e.id,
      e.discount_name,
      e.discount_kind,
      e.discount_value,
      e.priority
    from student_discount_effective e
    join school_term t on t.id=p_term_id and t.school_year_id=e.school_year_id
    where e.student_id=p_student_id
      and e.term_id=p_term_id
      and e.status='approved'
      and (
        e.system_key <> 'sibling'
        or exists (
          select 1
          from student target
          join student sibling
            on sibling.family_id=target.family_id
           and sibling.id<>target.id
          join student_enrollment se
            on se.student_id=sibling.id
           and se.school_year_id=t.school_year_id
           and se.status<>'cancelled'
          join student_term_enrollment ste
            on ste.enrollment_id=se.id
           and ste.term_id=p_term_id
           and ste.status<>'cancelled'
          where target.id=p_student_id
        )
      )
    order by e.priority,e.requested_at,e.id
  loop
    v_order := v_order + 1;

    if rec.discount_kind='percentage' then
      if v_mode='additive' then
        v_candidate := round(p_base_amount * rec.discount_value / 100.0,2);
      else
        v_candidate := round(v_remaining * rec.discount_value / 100.0,2);
      end if;
    else
      v_candidate := rec.discount_value;
    end if;

    v_allowed := greatest(
      least(v_candidate, v_cap-v_total, v_remaining),
      0
    );

    if v_allowed > 0 then
      student_discount_id := rec.id;
      discount_label := rec.discount_name;
      discount_kind := rec.discount_kind;
      discount_value := rec.discount_value;
      priority := rec.priority;
      application_order := v_order;
      applied_amount := v_allowed::numeric;
      combination_mode := v_mode;
      return next;

      v_total := v_total + v_allowed;
      v_remaining := v_remaining - v_allowed;
    end if;

    exit when v_remaining <= 0 or v_total >= v_cap;
  end loop;
end;
$$;

create table payment (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid,
  payment_kind text not null default 'payment'
    check (payment_kind in ('payment','prepayment')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  received_on date not null default current_date,
  method text not null
    check (method in ('cash','card','bank_transfer','check','other')),
  reference text,
  notes text,
  status text not null default 'posted'
    check (status in ('posted','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  foreign key (student_id, family_id)
    references student(id, family_id) on delete restrict,
  check (
    (status='posted' and reversed_at is null)
    or
    (status='reversed' and reversed_at is not null and reversal_reason is not null)
  )
);
create unique index payment_id_family_unique on payment(id, family_id);
create index payment_family_idx on payment(family_id, received_on desc);

create table payment_allocation (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payment(id) on delete restrict,
  invoice_id uuid not null references invoice(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (payment_id, invoice_id)
);

insert into document_sequence(document_type,prefix)
values ('credit_note','CRN')
on conflict (document_type) do nothing;

create table credit_note (
  id uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique,
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid,
  original_invoice_id uuid,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null,
  issued_on date not null default current_date,
  status text not null default 'issued'
    check (status in ('issued','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  foreign key (student_id, family_id)
    references student(id, family_id) on delete restrict,
  foreign key (original_invoice_id, family_id)
    references invoice(id, family_id) on delete restrict,
  check (
    (status='issued' and reversed_at is null)
    or
    (status='reversed' and reversed_at is not null and reversal_reason is not null)
  )
);
create index credit_note_family_idx on credit_note(family_id, issued_on desc);

create table credit_note_allocation (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references credit_note(id) on delete restrict,
  invoice_id uuid not null references invoice(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (credit_note_id, invoice_id)
);

create or replace view invoice_balance as
select
  i.id,
  i.invoice_number,
  i.family_id,
  i.student_id,
  i.school_year_id,
  i.term_id,
  i.currency,
  i.status,
  i.total_amount,
  coalesce(p.paid_amount,0)::numeric(12,2) as paid_amount,
  coalesce(c.credit_amount,0)::numeric(12,2) as credit_amount,
  greatest(i.total_amount-coalesce(p.paid_amount,0)-coalesce(c.credit_amount,0),0)::numeric(12,2)
    as balance_amount
from invoice i
left join (
  select pa.invoice_id,sum(pa.amount) as paid_amount
  from payment_allocation pa
  join payment p on p.id=pa.payment_id and p.status='posted'
  group by pa.invoice_id
) p on p.invoice_id=i.id
left join (
  select ca.invoice_id,sum(ca.amount) as credit_amount
  from credit_note_allocation ca
  join credit_note c on c.id=ca.credit_note_id and c.status='issued'
  group by ca.invoice_id
) c on c.invoice_id=i.id;

create or replace function refresh_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
as $$
declare
  v_status text;
  v_total numeric;
  v_balance numeric;
begin
  select status,total_amount into v_status,v_total
  from invoice
  where id=p_invoice_id
  for update;

  if not found or v_status in ('draft','void') then
    return;
  end if;

  select balance_amount into v_balance
  from invoice_balance
  where id=p_invoice_id;

  update invoice
  set
    status=case
      when v_total=0 or v_balance<=0 then 'paid'
      when v_balance<v_total then 'partially_paid'
      else 'issued'
    end,
    updated_at=now()
  where id=p_invoice_id;
end;
$$;

create or replace function prevent_allocation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Allocations are immutable; reverse the payment or credit note instead';
end;
$$;

create trigger payment_allocation_immutable
before update or delete on payment_allocation
for each row execute function prevent_allocation_mutation();

create trigger credit_note_allocation_immutable
before update or delete on credit_note_allocation
for each row execute function prevent_allocation_mutation();

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

  if v_payment.status<>'posted' then
    raise exception 'Only posted payments can be allocated';
  end if;
  if v_invoice.status not in ('issued','partially_paid') then
    raise exception 'Payments can only be allocated to issued invoices with an open balance';
  end if;
  if v_payment.family_id<>v_invoice.family_id then
    raise exception 'Payment and invoice must belong to the same family';
  end if;
  if v_payment.currency<>v_invoice.currency then
    raise exception 'Payment and invoice currencies must match';
  end if;
  if v_payment.student_id is not null and v_payment.student_id<>v_invoice.student_id then
    raise exception 'Student-specific payment cannot be allocated to another student';
  end if;

  select coalesce(sum(amount),0) into v_allocated
  from payment_allocation
  where payment_id=new.payment_id;

  if v_allocated+new.amount>v_payment.amount then
    raise exception 'Payment allocation exceeds the payment amount';
  end if;

  select balance_amount into v_balance from invoice_balance where id=new.invoice_id;
  if new.amount>v_balance then
    raise exception 'Payment allocation exceeds the invoice balance';
  end if;

  return new;
end;
$$;

create trigger payment_allocation_validate
before insert on payment_allocation
for each row execute function validate_payment_allocation();

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

  if v_credit.status<>'issued' then
    raise exception 'Only issued credit notes can be allocated';
  end if;
  if v_invoice.status not in ('issued','partially_paid') then
    raise exception 'Credits can only be allocated to issued invoices with an open balance';
  end if;
  if v_credit.family_id<>v_invoice.family_id then
    raise exception 'Credit note and invoice must belong to the same family';
  end if;
  if v_credit.currency<>v_invoice.currency then
    raise exception 'Credit note and invoice currencies must match';
  end if;
  if v_credit.student_id is not null and v_credit.student_id<>v_invoice.student_id then
    raise exception 'Student-specific credit cannot be allocated to another student';
  end if;

  select coalesce(sum(amount),0) into v_allocated
  from credit_note_allocation
  where credit_note_id=new.credit_note_id;

  if v_allocated+new.amount>v_credit.amount then
    raise exception 'Credit allocation exceeds the credit note amount';
  end if;

  select balance_amount into v_balance from invoice_balance where id=new.invoice_id;
  if new.amount>v_balance then
    raise exception 'Credit allocation exceeds the invoice balance';
  end if;

  return new;
end;
$$;

create trigger credit_note_allocation_validate
before insert on credit_note_allocation
for each row execute function validate_credit_note_allocation();

create or replace function refresh_invoice_after_allocation()
returns trigger
language plpgsql
as $$
begin
  perform refresh_invoice_status(new.invoice_id);
  return new;
end;
$$;

create trigger payment_allocation_refresh
after insert on payment_allocation
for each row execute function refresh_invoice_after_allocation();

create trigger credit_note_allocation_refresh
after insert on credit_note_allocation
for each row execute function refresh_invoice_after_allocation();

create or replace function refresh_invoices_after_payment_status()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
begin
  if old.status is distinct from new.status then
    for v_invoice_id in
      select distinct invoice_id from payment_allocation where payment_id=new.id
    loop
      perform refresh_invoice_status(v_invoice_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger payment_status_refresh
after update of status on payment
for each row execute function refresh_invoices_after_payment_status();

create or replace function refresh_invoices_after_credit_status()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
begin
  if old.status is distinct from new.status then
    for v_invoice_id in
      select distinct invoice_id from credit_note_allocation where credit_note_id=new.id
    loop
      perform refresh_invoice_status(v_invoice_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger credit_note_status_refresh
after update of status on credit_note
for each row execute function refresh_invoices_after_credit_status();

create or replace view payment_balance as
select
  p.*,
  coalesce(a.allocated_amount,0)::numeric(12,2) as allocated_amount,
  (p.amount-coalesce(a.allocated_amount,0))::numeric(12,2) as unallocated_amount,
  case
    when p.status='reversed' then 'reversed'
    when p.amount-coalesce(a.allocated_amount,0)<=0 then 'fully_allocated'
    when p.payment_kind='prepayment' then 'prepayment'
    when coalesce(a.allocated_amount,0)>0 then 'overpayment'
    else 'unapplied_payment'
  end as balance_type
from payment p
left join (
  select pa.payment_id,sum(pa.amount) as allocated_amount
  from payment_allocation pa
  join payment p2 on p2.id=pa.payment_id and p2.status='posted'
  group by pa.payment_id
) a on a.payment_id=p.id;

create or replace view credit_note_balance as
select
  c.*,
  coalesce(a.allocated_amount,0)::numeric(12,2) as allocated_amount,
  (c.amount-coalesce(a.allocated_amount,0))::numeric(12,2) as unallocated_amount
from credit_note c
left join (
  select ca.credit_note_id,sum(ca.amount) as allocated_amount
  from credit_note_allocation ca
  join credit_note c2 on c2.id=ca.credit_note_id and c2.status='issued'
  group by ca.credit_note_id
) a on a.credit_note_id=c.id;

create or replace view family_ledger as
select
  i.family_id,
  i.student_id,
  i.issued_on as entry_date,
  i.created_at as occurred_at,
  'invoice'::text as entry_type,
  i.id as source_id,
  i.invoice_number as reference,
  ('Term invoice ' || t.name)::text as description,
  i.total_amount::numeric(12,2) as debit_amount,
  0::numeric(12,2) as credit_amount
from invoice i
join school_term t on t.id=i.term_id
where i.status not in ('draft','void')
union all
select
  p.family_id,
  p.student_id,
  p.received_on,
  p.created_at,
  case when p.payment_kind='prepayment' then 'prepayment' else 'payment' end,
  p.id,
  p.receipt_number,
  coalesce(p.notes,'Payment received'),
  0::numeric(12,2),
  p.amount::numeric(12,2)
from payment p
where p.status='posted'
union all
select
  c.family_id,
  c.student_id,
  c.issued_on,
  c.created_at,
  'credit_note',
  c.id,
  c.credit_note_number,
  c.reason,
  0::numeric(12,2),
  c.amount::numeric(12,2)
from credit_note c
where c.status='issued';

create or replace view student_ledger as
select
  i.family_id,
  i.student_id,
  i.issued_on as entry_date,
  i.created_at as occurred_at,
  'invoice'::text as entry_type,
  i.id as source_id,
  i.invoice_number as reference,
  ('Term invoice ' || t.name)::text as description,
  i.total_amount::numeric(12,2) as debit_amount,
  0::numeric(12,2) as credit_amount
from invoice i
join school_term t on t.id=i.term_id
where i.status not in ('draft','void')
union all
select
  p.family_id,
  p.student_id,
  p.received_on,
  p.created_at,
  case when p.payment_kind='prepayment' then 'prepayment' else 'payment' end,
  p.id,
  p.receipt_number,
  coalesce(p.notes,'Payment received'),
  0::numeric(12,2),
  p.amount::numeric(12,2)
from payment p
where p.status='posted' and p.student_id is not null
union all
select
  p.family_id,
  i.student_id,
  p.received_on,
  pa.created_at,
  'payment_allocation',
  pa.id,
  p.receipt_number,
  'Family payment allocated to invoice',
  0::numeric(12,2),
  pa.amount::numeric(12,2)
from payment_allocation pa
join payment p on p.id=pa.payment_id and p.status='posted' and p.student_id is null
join invoice i on i.id=pa.invoice_id
union all
select
  c.family_id,
  c.student_id,
  c.issued_on,
  c.created_at,
  'credit_note',
  c.id,
  c.credit_note_number,
  c.reason,
  0::numeric(12,2),
  c.amount::numeric(12,2)
from credit_note c
where c.status='issued' and c.student_id is not null
union all
select
  c.family_id,
  i.student_id,
  c.issued_on,
  ca.created_at,
  'credit_allocation',
  ca.id,
  c.credit_note_number,
  'Family credit allocated to invoice',
  0::numeric(12,2),
  ca.amount::numeric(12,2)
from credit_note_allocation ca
join credit_note c on c.id=ca.credit_note_id and c.status='issued' and c.student_id is null
join invoice i on i.id=ca.invoice_id;

insert into permission(key, description) values
  ('billing.view', 'View fee schedules, invoices, balances, and ledgers'),
  ('billing.manage', 'Create fee schedules, invoices, charges, and credit notes'),
  ('discounts.view', 'View discount definitions, assignments, approvals, and history'),
  ('discounts.manage', 'Request and revoke student discounts'),
  ('discounts.approve', 'Approve or reject discounts and configure combination rules'),
  ('payments.view', 'View payments, prepayments, overpayments, and allocations'),
  ('payments.manage', 'Record, allocate, and reverse payments')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id, permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
