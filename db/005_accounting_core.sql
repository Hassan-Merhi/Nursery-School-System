insert into document_sequence(document_type,prefix)
values ('journal_entry','JE')
on conflict (document_type) do nothing;

create table account_type (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null
    check (category in ('asset','liability','equity','income','expense')),
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);

insert into account_type(code,name,category,is_system)
values
  ('ASSET','Asset','asset',true),
  ('LIABILITY','Liability','liability',true),
  ('EQUITY','Equity','equity',true),
  ('INCOME','Income','income',true),
  ('EXPENSE','Expense','expense',true)
on conflict (code) do update
set name=excluded.name,category=excluded.category,is_system=true;

create table account (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  account_type_id uuid not null references account_type(id) on delete restrict,
  parent_account_id uuid references account(id) on delete restrict,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  allow_posting boolean not null default true,
  status text not null default 'active' check (status in ('active','inactive')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_by uuid references app_user(id) on delete set null,
  check (parent_account_id is null or parent_account_id<>id)
);
create index account_parent_idx on account(parent_account_id);
create index account_type_idx on account(account_type_id,status);

create or replace function validate_account_parent()
returns trigger
language plpgsql
as $$
declare
  v_parent_category text;
  v_child_category text;
  v_cursor uuid;
begin
  if new.parent_account_id is null then
    return new;
  end if;

  select t.category into v_child_category
  from account_type t
  where t.id=new.account_type_id;

  select t.category into v_parent_category
  from account p
  join account_type t on t.id=p.account_type_id
  where p.id=new.parent_account_id;

  if v_parent_category is null then
    raise exception 'Parent account not found';
  end if;

  if v_parent_category<>v_child_category then
    raise exception 'Parent and child accounts must use the same accounting category';
  end if;

  v_cursor := new.parent_account_id;
  while v_cursor is not null loop
    if v_cursor=new.id then
      raise exception 'Account hierarchy cannot contain a cycle';
    end if;
    select parent_account_id into v_cursor from account where id=v_cursor;
  end loop;

  return new;
end;
$$;

create trigger account_parent_validate
before insert or update of parent_account_id,account_type_id on account
for each row execute function validate_account_parent();

create table accounting_period (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open','locked')),
  locked_at timestamptz,
  locked_by uuid references app_user(id) on delete set null,
  lock_note text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (ends_on>=starts_on),
  check (
    (status='open' and locked_at is null)
    or
    (status='locked' and locked_at is not null)
  )
);

create or replace function prevent_accounting_period_overlap()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from accounting_period p
    where p.id<>new.id
      and daterange(p.starts_on,p.ends_on,'[]') && daterange(new.starts_on,new.ends_on,'[]')
  ) then
    raise exception 'Accounting periods cannot overlap';
  end if;
  return new;
end;
$$;

create trigger accounting_period_no_overlap
before insert or update of starts_on,ends_on on accounting_period
for each row execute function prevent_accounting_period_overlap();

create table journal (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);

create table journal_entry (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references journal(id) on delete restrict,
  entry_number text unique,
  entry_kind text not null default 'manual'
    check (entry_kind in ('manual','opening_balance','receipt','expense','transfer','system','reversal')),
  posting_date date not null,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  description text not null,
  transaction_reference text,
  source_type text,
  source_id uuid,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  reversal_of_entry_id uuid references journal_entry(id) on delete restrict,
  reversed_by_entry_id uuid references journal_entry(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references app_user(id) on delete set null,
  check (
    (status='draft' and posted_at is null and entry_number is null)
    or
    (status in ('posted','reversed') and posted_at is not null and entry_number is not null)
  ),
  check (reversal_of_entry_id is null or reversal_of_entry_id<>id),
  check (reversed_by_entry_id is null or reversed_by_entry_id<>id)
);
create index journal_entry_posting_idx on journal_entry(posting_date,status);
create index journal_entry_journal_idx on journal_entry(journal_id,posting_date);
create index journal_entry_reference_idx on journal_entry(transaction_reference);
create index journal_entry_source_idx on journal_entry(source_type,source_id);
create unique index journal_entry_source_unique
  on journal_entry(source_type,source_id)
  where source_type is not null
    and source_id is not null
    and entry_kind<>'reversal';

create table journal_line (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references journal_entry(id) on delete restrict,
  line_number integer not null check (line_number>0),
  account_id uuid not null references account(id) on delete restrict,
  description text,
  debit numeric(14,2) not null default 0 check (debit>=0),
  credit numeric(14,2) not null default 0 check (credit>=0),
  family_id uuid references family(id) on delete restrict,
  student_id uuid references student(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (journal_entry_id,line_number),
  check (
    (debit>0 and credit=0)
    or
    (credit>0 and debit=0)
  )
);
create index journal_line_account_idx on journal_line(account_id,journal_entry_id);
create index journal_line_family_idx on journal_line(family_id);
create index journal_line_student_idx on journal_line(student_id);

create or replace function protect_posted_journal_lines()
returns trigger
language plpgsql
as $$
declare
  v_entry_id uuid;
  v_status text;
begin
  v_entry_id := case when tg_op='DELETE' then old.journal_entry_id else new.journal_entry_id end;
  select status into v_status from journal_entry where id=v_entry_id;
  if v_status is distinct from 'draft' then
    raise exception 'Posted journal lines are immutable; reverse the journal entry instead';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger journal_line_draft_only
before insert or update or delete on journal_line
for each row execute function protect_posted_journal_lines();

create or replace function protect_posted_journal_entry()
returns trigger
language plpgsql
as $$
begin
  if tg_op='DELETE' then
    if old.status<>'draft' then
      raise exception 'Posted journal entries cannot be deleted; reverse them instead';
    end if;
    return old;
  end if;

  if old.status in ('posted','reversed') then
    if old.status='posted'
       and new.status='reversed'
       and new.reversed_by_entry_id is not null
       and to_jsonb(new)-'status'-'reversed_by_entry_id'-'reversal_reason'
           = to_jsonb(old)-'status'-'reversed_by_entry_id'-'reversal_reason'
    then
      return new;
    end if;
    raise exception 'Posted journal entries are immutable; reverse them instead';
  end if;

  return new;
end;
$$;

create trigger journal_entry_immutable_after_post
before update or delete on journal_entry
for each row execute function protect_posted_journal_entry();

create or replace function post_journal_entry(
  p_entry_id uuid,
  p_user_id uuid default null
)
returns text
language plpgsql
as $$
declare
  v_entry journal_entry%rowtype;
  v_prefix text;
  v_number bigint;
  v_entry_number text;
  v_debit numeric(14,2);
  v_credit numeric(14,2);
begin
  select * into v_entry
  from journal_entry
  where id=p_entry_id
  for update;

  if not found then
    raise exception 'Journal entry not found';
  end if;
  if v_entry.status<>'draft' then
    raise exception 'Only draft journal entries can be posted';
  end if;

  if not exists (
    select 1 from accounting_period
    where status='open'
      and v_entry.posting_date between starts_on and ends_on
  ) then
    raise exception 'Posting date is not inside an open accounting period';
  end if;

  if (select count(*) from journal_line where journal_entry_id=p_entry_id)<2 then
    raise exception 'A journal entry requires at least two lines';
  end if;

  select
    coalesce(sum(debit),0)::numeric(14,2),
    coalesce(sum(credit),0)::numeric(14,2)
  into v_debit,v_credit
  from journal_line
  where journal_entry_id=p_entry_id;

  if v_debit<=0 or v_debit<>v_credit then
    raise exception 'Journal entry is not balanced: total debit % must equal total credit %',v_debit,v_credit;
  end if;

  if exists (
    select 1
    from journal_line l
    join account a on a.id=l.account_id
    where l.journal_entry_id=p_entry_id
      and (a.status<>'active' or a.allow_posting=false)
  ) then
    raise exception 'Journal entry contains an inactive or non-posting account';
  end if;

  if exists (
    select 1
    from journal_line l
    join account a on a.id=l.account_id
    where l.journal_entry_id=p_entry_id
      and a.currency<>v_entry.currency
  ) then
    raise exception 'All journal accounts must use the journal entry currency';
  end if;

  select prefix,next_number into v_prefix,v_number
  from document_sequence
  where document_type='journal_entry'
  for update;

  if v_prefix is null then
    raise exception 'Journal entry numbering is not configured';
  end if;

  v_entry_number := v_prefix || '-' || lpad(v_number::text,6,'0');

  update document_sequence
  set next_number=next_number+1,updated_at=now(),updated_by=p_user_id
  where document_type='journal_entry';

  update journal_entry
  set
    entry_number=v_entry_number,
    status='posted',
    posted_at=now(),
    posted_by=p_user_id
  where id=p_entry_id;

  return v_entry_number;
end;
$$;

create or replace function reverse_journal_entry(
  p_entry_id uuid,
  p_posting_date date,
  p_user_id uuid default null,
  p_reason text default 'Reversal'
)
returns uuid
language plpgsql
as $$
declare
  v_original journal_entry%rowtype;
  v_reversal_id uuid;
  v_line record;
begin
  select * into v_original
  from journal_entry
  where id=p_entry_id
  for update;

  if not found then
    raise exception 'Journal entry not found';
  end if;
  if v_original.status<>'posted' then
    raise exception 'Only posted journal entries can be reversed';
  end if;
  if exists (select 1 from journal_entry where reversal_of_entry_id=p_entry_id) then
    raise exception 'Journal entry already has a reversal';
  end if;

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,reversal_of_entry_id,reversal_reason,created_by
  ) values (
    v_original.journal_id,'reversal',p_posting_date,v_original.currency,
    'Reversal of ' || v_original.entry_number || ': ' || v_original.description,
    v_original.transaction_reference,
    'journal_reversal',v_original.id,v_original.id,p_reason,p_user_id
  ) returning id into v_reversal_id;

  for v_line in
    select * from journal_line
    where journal_entry_id=p_entry_id
    order by line_number
  loop
    insert into journal_line(
      journal_entry_id,line_number,account_id,description,debit,credit,
      family_id,student_id,created_by
    ) values (
      v_reversal_id,v_line.line_number,v_line.account_id,
      coalesce(v_line.description,'Reversal'),
      v_line.credit,v_line.debit,
      v_line.family_id,v_line.student_id,p_user_id
    );
  end loop;

  perform post_journal_entry(v_reversal_id,p_user_id);

  update journal_entry
  set
    status='reversed',
    reversed_by_entry_id=v_reversal_id,
    reversal_reason=p_reason
  where id=p_entry_id;

  return v_reversal_id;
end;
$$;

create table accounting_role_definition (
  role_key text primary key,
  name text not null,
  description text not null,
  required_category text not null
    check (required_category in ('asset','liability','equity','income','expense'))
);

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('accounts_receivable','Accounts Receivable','Asset account debited when tuition invoices are issued and credited when balances are settled.','asset'),
  ('billing_income','Billing Income','Income account credited for issued student billing and debited for credit notes.','income'),
  ('customer_deposits','Customer Deposits','Liability account holding unapplied family prepayments, overpayments, and credits.','liability'),
  ('payment_asset','Payment Asset','Asset account receiving posted student payments, such as a bank or cash account.','asset')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create table accounting_mapping (
  role_key text primary key references accounting_role_definition(role_key) on delete restrict,
  account_id uuid not null references account(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create or replace function validate_accounting_mapping()
returns trigger
language plpgsql
as $$
declare
  v_required text;
  v_actual text;
begin
  select required_category into v_required
  from accounting_role_definition
  where role_key=new.role_key;

  select t.category into v_actual
  from account a
  join account_type t on t.id=a.account_type_id
  where a.id=new.account_id
    and a.status='active'
    and a.allow_posting=true;

  if v_actual is null then
    raise exception 'Accounting mapping requires an active posting account';
  end if;
  if v_actual<>v_required then
    raise exception 'Accounting mapping % requires a % account, not %',new.role_key,v_required,v_actual;
  end if;

  return new;
end;
$$;

create trigger accounting_mapping_validate
before insert or update on accounting_mapping
for each row execute function validate_accounting_mapping();

alter table payment_allocation
  add column allocated_on date not null default current_date;

alter table credit_note_allocation
  add column allocated_on date not null default current_date;

create or replace function accounting_mapped_account(p_role text)
returns uuid
language plpgsql
stable
as $$
declare
  v_account_id uuid;
begin
  select account_id into v_account_id
  from accounting_mapping
  where role_key=p_role;

  if v_account_id is null then
    raise exception 'Accounting mapping % is not configured',p_role;
  end if;
  return v_account_id;
end;
$$;

create or replace function accounting_post_invoice(
  p_invoice_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_invoice invoice%rowtype;
  v_existing uuid;
  v_entry_id uuid;
  v_journal_id uuid;
  v_ar uuid;
  v_income uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='billing_invoice' and source_id=p_invoice_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_invoice from invoice where id=p_invoice_id;
  if not found or v_invoice.status not in ('issued','partially_paid','paid') then
    raise exception 'Only issued invoices can be posted to accounting';
  end if;
  if v_invoice.total_amount<=0 then
    raise exception 'Invoice total must be greater than zero for accounting posting';
  end if;

  select id into v_journal_id from journal where status='active' order by created_at,id limit 1;
  if v_journal_id is null then raise exception 'Create an active journal before posting billing'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_income := accounting_mapped_account('billing_income');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    v_journal_id,'system',v_invoice.issued_on,v_invoice.currency,
    'Student invoice ' || v_invoice.invoice_number,v_invoice.invoice_number,
    'billing_invoice',v_invoice.id,p_user_id
  ) returning id into v_entry_id;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry_id,1,v_ar,'Student receivable',v_invoice.total_amount,0,v_invoice.family_id,v_invoice.student_id,p_user_id),
    (v_entry_id,2,v_income,'Student billing income',0,v_invoice.total_amount,v_invoice.family_id,v_invoice.student_id,p_user_id);

  perform post_journal_entry(v_entry_id,p_user_id);
  return v_entry_id;
end;
$$;

create or replace function accounting_post_payment(
  p_payment_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_payment payment%rowtype;
  v_existing uuid;
  v_entry_id uuid;
  v_journal_id uuid;
  v_asset uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='billing_payment' and source_id=p_payment_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_payment from payment where id=p_payment_id;
  if not found or v_payment.status<>'posted' then
    raise exception 'Only posted payments can be posted to accounting';
  end if;

  select id into v_journal_id from journal where status='active' order by created_at,id limit 1;
  if v_journal_id is null then raise exception 'Create an active journal before posting billing'; end if;

  v_asset := accounting_mapped_account('payment_asset');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    v_journal_id,'system',v_payment.received_on,v_payment.currency,
    'Student payment ' || v_payment.receipt_number,v_payment.receipt_number,
    'billing_payment',v_payment.id,p_user_id
  ) returning id into v_entry_id;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry_id,1,v_asset,'Payment received',v_payment.amount,0,v_payment.family_id,v_payment.student_id,p_user_id),
    (v_entry_id,2,v_deposits,'Family funds received',0,v_payment.amount,v_payment.family_id,v_payment.student_id,p_user_id);

  perform post_journal_entry(v_entry_id,p_user_id);
  return v_entry_id;
end;
$$;

create or replace function accounting_post_payment_allocation(
  p_allocation_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_allocation record;
  v_existing uuid;
  v_entry_id uuid;
  v_journal_id uuid;
  v_ar uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='billing_payment_allocation' and source_id=p_allocation_id;
  if v_existing is not null then return v_existing; end if;

  select
    pa.id,pa.amount,pa.allocated_on,p.receipt_number,p.currency,p.family_id,
    i.student_id
  into v_allocation
  from payment_allocation pa
  join payment p on p.id=pa.payment_id
  join invoice i on i.id=pa.invoice_id
  where pa.id=p_allocation_id and p.status='posted';

  if not found then raise exception 'Posted payment allocation not found'; end if;

  select id into v_journal_id from journal where status='active' order by created_at,id limit 1;
  if v_journal_id is null then raise exception 'Create an active journal before posting billing'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    v_journal_id,'system',v_allocation.allocated_on,v_allocation.currency,
    'Allocate family funds to receivable',v_allocation.receipt_number,
    'billing_payment_allocation',v_allocation.id,p_user_id
  ) returning id into v_entry_id;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry_id,1,v_deposits,'Apply customer deposit',v_allocation.amount,0,v_allocation.family_id,v_allocation.student_id,p_user_id),
    (v_entry_id,2,v_ar,'Settle student receivable',0,v_allocation.amount,v_allocation.family_id,v_allocation.student_id,p_user_id);

  perform post_journal_entry(v_entry_id,p_user_id);
  return v_entry_id;
end;
$$;

create or replace function accounting_post_credit_note(
  p_credit_note_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_credit credit_note%rowtype;
  v_existing uuid;
  v_entry_id uuid;
  v_journal_id uuid;
  v_income uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='billing_credit_note' and source_id=p_credit_note_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_credit from credit_note where id=p_credit_note_id;
  if not found or v_credit.status<>'issued' then
    raise exception 'Only issued credit notes can be posted to accounting';
  end if;

  select id into v_journal_id from journal where status='active' order by created_at,id limit 1;
  if v_journal_id is null then raise exception 'Create an active journal before posting billing'; end if;

  v_income := accounting_mapped_account('billing_income');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    v_journal_id,'system',v_credit.issued_on,v_credit.currency,
    'Student credit note ' || v_credit.credit_note_number,v_credit.credit_note_number,
    'billing_credit_note',v_credit.id,p_user_id
  ) returning id into v_entry_id;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry_id,1,v_income,'Reverse student billing income',v_credit.amount,0,v_credit.family_id,v_credit.student_id,p_user_id),
    (v_entry_id,2,v_deposits,'Family credit available',0,v_credit.amount,v_credit.family_id,v_credit.student_id,p_user_id);

  perform post_journal_entry(v_entry_id,p_user_id);
  return v_entry_id;
end;
$$;

create or replace function accounting_post_credit_allocation(
  p_allocation_id uuid,
  p_user_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_allocation record;
  v_existing uuid;
  v_entry_id uuid;
  v_journal_id uuid;
  v_ar uuid;
  v_deposits uuid;
begin
  select id into v_existing
  from journal_entry
  where source_type='billing_credit_allocation' and source_id=p_allocation_id;
  if v_existing is not null then return v_existing; end if;

  select
    ca.id,ca.amount,ca.allocated_on,c.credit_note_number,c.currency,c.family_id,
    i.student_id
  into v_allocation
  from credit_note_allocation ca
  join credit_note c on c.id=ca.credit_note_id
  join invoice i on i.id=ca.invoice_id
  where ca.id=p_allocation_id and c.status='issued';

  if not found then raise exception 'Issued credit allocation not found'; end if;

  select id into v_journal_id from journal where status='active' order by created_at,id limit 1;
  if v_journal_id is null then raise exception 'Create an active journal before posting billing'; end if;

  v_ar := accounting_mapped_account('accounts_receivable');
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(
    journal_id,entry_kind,posting_date,currency,description,transaction_reference,
    source_type,source_id,created_by
  ) values (
    v_journal_id,'system',v_allocation.allocated_on,v_allocation.currency,
    'Allocate family credit to receivable',v_allocation.credit_note_number,
    'billing_credit_allocation',v_allocation.id,p_user_id
  ) returning id into v_entry_id;

  insert into journal_line(
    journal_entry_id,line_number,account_id,description,debit,credit,
    family_id,student_id,created_by
  ) values
    (v_entry_id,1,v_deposits,'Apply family credit',v_allocation.amount,0,v_allocation.family_id,v_allocation.student_id,p_user_id),
    (v_entry_id,2,v_ar,'Settle student receivable',0,v_allocation.amount,v_allocation.family_id,v_allocation.student_id,p_user_id);

  perform post_journal_entry(v_entry_id,p_user_id);
  return v_entry_id;
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
        or
        (
          je.source_type='billing_payment_allocation'
          and je.source_id in (
            select pa.id from payment_allocation pa where pa.payment_id=p_payment_id
          )
        )
      )
    order by case when je.source_type='billing_payment_allocation' then 1 else 2 end,je.posted_at
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
        or
        (
          je.source_type='billing_credit_allocation'
          and je.source_id in (
            select ca.id from credit_note_allocation ca where ca.credit_note_id=p_credit_note_id
          )
        )
      )
    order by case when je.source_type='billing_credit_allocation' then 1 else 2 end,je.posted_at
  loop
    perform reverse_journal_entry(v_entry_id,p_posting_date,p_user_id,p_reason);
  end loop;
end;
$$;

create or replace view general_ledger as
select
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  t.category,
  je.id as journal_entry_id,
  je.entry_number,
  je.entry_kind,
  je.posting_date,
  je.transaction_reference,
  je.description as entry_description,
  jl.id as journal_line_id,
  jl.line_number,
  jl.description as line_description,
  jl.debit,
  jl.credit,
  je.currency,
  jl.family_id,
  jl.student_id,
  sum(
    case
      when t.category in ('asset','expense') then jl.debit-jl.credit
      else jl.credit-jl.debit
    end
  ) over (
    partition by a.id
    order by je.posting_date,je.posted_at,je.id,jl.line_number,jl.id
    rows between unbounded preceding and current row
  )::numeric(14,2) as running_balance
from journal_line jl
join journal_entry je on je.id=jl.journal_entry_id
join account a on a.id=jl.account_id
join account_type t on t.id=a.account_type_id
where je.status in ('posted','reversed');

create or replace view trial_balance as
with totals as (
  select
    a.id as account_id,
    a.code as account_code,
    a.name as account_name,
    t.category,
    coalesce(sum(jl.debit),0)::numeric(14,2) as total_debit,
    coalesce(sum(jl.credit),0)::numeric(14,2) as total_credit
  from account a
  join account_type t on t.id=a.account_type_id
  left join journal_line jl on jl.account_id=a.id
  left join journal_entry je
    on je.id=jl.journal_entry_id
   and je.status in ('posted','reversed')
  group by a.id,a.code,a.name,t.category
)
select
  account_id,account_code,account_name,category,total_debit,total_credit,
  greatest(total_debit-total_credit,0)::numeric(14,2) as debit_balance,
  greatest(total_credit-total_debit,0)::numeric(14,2) as credit_balance
from totals;

create or replace view account_balance as
select
  tb.*,
  case
    when tb.category in ('asset','expense')
      then (tb.total_debit-tb.total_credit)::numeric(14,2)
    else (tb.total_credit-tb.total_debit)::numeric(14,2)
  end as normal_balance
from trial_balance tb;

create or replace view accounting_position as
select
  coalesce(sum(normal_balance) filter (where category='asset'),0)::numeric(14,2) as assets,
  coalesce(sum(normal_balance) filter (where category='liability'),0)::numeric(14,2) as liabilities,
  coalesce(sum(normal_balance) filter (where category='equity'),0)::numeric(14,2) as equity,
  coalesce(sum(normal_balance) filter (where category='income'),0)::numeric(14,2) as income,
  coalesce(sum(normal_balance) filter (where category='expense'),0)::numeric(14,2) as expenses,
  (
    coalesce(sum(normal_balance) filter (where category='income'),0)
    - coalesce(sum(normal_balance) filter (where category='expense'),0)
  )::numeric(14,2) as current_surplus,
  (
    coalesce(sum(normal_balance) filter (where category='asset'),0)
    - coalesce(sum(normal_balance) filter (where category='liability'),0)
  )::numeric(14,2) as net_position,
  (
    coalesce(sum(normal_balance) filter (where category='asset'),0)
    - (
      coalesce(sum(normal_balance) filter (where category='liability'),0)
      + coalesce(sum(normal_balance) filter (where category='equity'),0)
      + coalesce(sum(normal_balance) filter (where category='income'),0)
      - coalesce(sum(normal_balance) filter (where category='expense'),0)
    )
  )::numeric(14,2) as equation_difference
from account_balance;

insert into permission(key,description) values
  ('accounting.view','View chart of accounts, journals, ledgers, trial balance, and net position'),
  ('accounting.manage','Create and maintain account types, accounts, journals, periods, and draft entries'),
  ('accounting.post','Post balanced journal entries and create accounting transactions'),
  ('accounting.period_lock','Lock or reopen accounting periods'),
  ('accounting.mapping','Configure billing-to-accounting account mappings')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
