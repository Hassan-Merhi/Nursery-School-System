
-- Step 5 — Payments, Expenses, Suppliers & Cash/Bank

insert into document_sequence(document_type,prefix) values
  ('supplier','SUP'),
  ('expense','EXP'),
  ('supplier_invoice','BILL'),
  ('supplier_payment','SPAY'),
  ('supplier_credit','SCR'),
  ('refund','REF'),
  ('bank_transaction','CBT'),
  ('bank_reconciliation','REC')
on conflict (document_type) do nothing;

alter table accounting_configuration
  add column if not exists operations_journal_id uuid references journal(id) on delete restrict;

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('accounts_payable','Accounts Payable','Liability credited when supplier invoices are posted and debited by supplier payments or credits.','liability')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create table cash_bank_account (
  account_id uuid primary key references account(id) on delete restrict,
  account_kind text not null check (account_kind in ('cash','bank')),
  display_name text not null,
  bank_name text,
  account_identifier text,
  iban text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create or replace function validate_cash_bank_account()
returns trigger
language plpgsql
as $$
declare
  v_category text;
  v_status text;
  v_allow boolean;
begin
  select t.category,a.status,a.allow_posting
    into v_category,v_status,v_allow
  from account a
  join account_type t on t.id=a.account_type_id
  where a.id=new.account_id;

  if v_category is distinct from 'asset' or v_status is distinct from 'active' or not coalesce(v_allow,false) then
    raise exception 'Cash/bank records require an active posting asset account';
  end if;

  if new.account_kind='cash' then
    new.bank_name := null;
    new.account_identifier := null;
    new.iban := null;
  end if;

  return new;
end;
$$;

create trigger cash_bank_account_validate
before insert or update on cash_bank_account
for each row execute function validate_cash_bank_account();

alter table payment
  add column if not exists payment_account_id uuid references account(id) on delete restrict,
  add column if not exists cheque_number text,
  add column if not exists cheque_due_on date;

create or replace function validate_student_payment_account()
returns trigger
language plpgsql
as $$
declare
  v_currency text;
begin
  if new.payment_account_id is null then return new; end if;

  select a.currency into v_currency
  from cash_bank_account c
  join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id
    and c.is_active=true
    and a.status='active'
    and a.allow_posting=true;

  if v_currency is null then
    raise exception 'Student payment account must be an active cash/bank account';
  end if;
  if v_currency<>new.currency then
    raise exception 'Student payment and cash/bank account currencies must match';
  end if;
  if new.method='check' and coalesce(new.cheque_number,'')='' then
    raise exception 'Cheque number is required for cheque payments';
  end if;
  return new;
end;
$$;

create trigger student_payment_account_validate
before insert or update of payment_account_id,currency,method,cheque_number on payment
for each row execute function validate_student_payment_account();

create table supplier (
  id uuid primary key default gen_random_uuid(),
  supplier_number text not null unique,
  name text not null,
  contact_name text,
  email text,
  phone text,
  address text,
  tax_number text,
  default_expense_account_id uuid references account(id) on delete restrict,
  default_payment_account_id uuid references account(id) on delete restrict,
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 3650),
  notes text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);
create index supplier_name_idx on supplier(lower(name));

create or replace function validate_supplier_defaults()
returns trigger
language plpgsql
as $$
declare
  v_category text;
begin
  if new.default_expense_account_id is not null then
    select t.category into v_category
    from account a join account_type t on t.id=a.account_type_id
    where a.id=new.default_expense_account_id and a.status='active' and a.allow_posting=true;
    if v_category is distinct from 'expense' then
      raise exception 'Supplier default expense account must be an active posting expense account';
    end if;
  end if;

  if new.default_payment_account_id is not null and not exists (
    select 1 from cash_bank_account c
    join account a on a.id=c.account_id
    where c.account_id=new.default_payment_account_id
      and c.is_active=true and a.status='active' and a.allow_posting=true
  ) then
    raise exception 'Supplier default payment account must be an active cash/bank account';
  end if;
  return new;
end;
$$;

create trigger supplier_defaults_validate
before insert or update of default_expense_account_id,default_payment_account_id on supplier
for each row execute function validate_supplier_defaults();

create table expense (
  id uuid primary key default gen_random_uuid(),
  expense_number text not null unique,
  supplier_id uuid references supplier(id) on delete restrict,
  expense_account_id uuid not null references account(id) on delete restrict,
  payment_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  incurred_on date not null,
  payment_method text not null default 'bank_transfer'
    check (payment_method in ('cash','card','bank_transfer','check','other')),
  cheque_number text,
  cheque_due_on date,
  reference text,
  notes text,
  status text not null default 'draft'
    check (status in ('draft','pending','approved','posted','reversed')),
  submitted_at timestamptz,
  submitted_by uuid references app_user(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references app_user(id) on delete set null,
  approval_note text,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);
create index expense_date_idx on expense(incurred_on desc,status);
create index expense_supplier_idx on expense(supplier_id,incurred_on desc);

create or replace function validate_expense_accounts()
returns trigger
language plpgsql
as $$
declare
  v_expense_currency text;
  v_expense_category text;
  v_payment_currency text;
begin
  select a.currency,t.category into v_expense_currency,v_expense_category
  from account a join account_type t on t.id=a.account_type_id
  where a.id=new.expense_account_id and a.status='active' and a.allow_posting=true;

  if v_expense_category is distinct from 'expense' then
    raise exception 'Expense entry requires an active posting expense account';
  end if;

  select a.currency into v_payment_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;

  if v_payment_currency is null then
    raise exception 'Expense payment account must be an active cash/bank account';
  end if;
  if v_expense_currency<>new.currency or v_payment_currency<>new.currency then
    raise exception 'Expense, expense account, and payment account currencies must match';
  end if;
  if new.payment_method='check' and coalesce(new.cheque_number,'')='' then
    raise exception 'Cheque number is required for cheque expenses';
  end if;
  return new;
end;
$$;

create trigger expense_accounts_validate
before insert or update of expense_account_id,payment_account_id,currency,payment_method,cheque_number on expense
for each row execute function validate_expense_accounts();

create table expense_receipt (
  expense_id uuid not null references expense(id) on delete restrict,
  document_id uuid not null references stored_document(id) on delete restrict,
  attached_at timestamptz not null default now(),
  attached_by uuid references app_user(id) on delete set null,
  primary key (expense_id,document_id)
);
create index expense_receipt_document_idx on expense_receipt(document_id);

create table supplier_invoice (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_number text not null unique,
  supplier_id uuid not null references supplier(id) on delete restrict,
  supplier_reference text,
  expense_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  invoice_date date not null,
  due_on date not null,
  notes text,
  status text not null default 'draft'
    check (status in ('draft','approved','posted','partially_paid','paid','reversed')),
  approved_at timestamptz,
  approved_by uuid references app_user(id) on delete set null,
  posted_at timestamptz,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  check (due_on>=invoice_date)
);
create index supplier_invoice_supplier_idx on supplier_invoice(supplier_id,invoice_date desc);
create index supplier_invoice_status_idx on supplier_invoice(status,due_on);

create or replace function validate_supplier_invoice_account()
returns trigger
language plpgsql
as $$
declare
  v_currency text;
  v_category text;
begin
  select a.currency,t.category into v_currency,v_category
  from account a join account_type t on t.id=a.account_type_id
  where a.id=new.expense_account_id and a.status='active' and a.allow_posting=true;
  if v_category is distinct from 'expense' then
    raise exception 'Supplier invoice requires an active posting expense account';
  end if;
  if v_currency<>new.currency then
    raise exception 'Supplier invoice and expense account currencies must match';
  end if;
  return new;
end;
$$;

create trigger supplier_invoice_account_validate
before insert or update of expense_account_id,currency on supplier_invoice
for each row execute function validate_supplier_invoice_account();

create table supplier_payment (
  id uuid primary key default gen_random_uuid(),
  supplier_payment_number text not null unique,
  supplier_id uuid not null references supplier(id) on delete restrict,
  supplier_invoice_id uuid not null references supplier_invoice(id) on delete restrict,
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
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index supplier_payment_invoice_idx on supplier_payment(supplier_invoice_id,paid_on desc);
create index supplier_payment_supplier_idx on supplier_payment(supplier_id,paid_on desc);

create table supplier_credit (
  id uuid primary key default gen_random_uuid(),
  supplier_credit_number text not null unique,
  supplier_id uuid not null references supplier(id) on delete restrict,
  supplier_invoice_id uuid not null references supplier_invoice(id) on delete restrict,
  expense_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  credited_on date not null,
  reference text,
  reason text not null,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index supplier_credit_invoice_idx on supplier_credit(supplier_invoice_id,credited_on desc);

create or replace view supplier_invoice_balance as
select
  i.*,
  coalesce(p.paid_amount,0)::numeric(14,2) as paid_amount,
  coalesce(c.credit_amount,0)::numeric(14,2) as credit_amount,
  greatest(i.amount-coalesce(p.paid_amount,0)-coalesce(c.credit_amount,0),0)::numeric(14,2) as balance_amount
from supplier_invoice i
left join (
  select supplier_invoice_id,sum(amount) as paid_amount
  from supplier_payment
  where status='posted'
  group by supplier_invoice_id
) p on p.supplier_invoice_id=i.id
left join (
  select supplier_invoice_id,sum(amount) as credit_amount
  from supplier_credit
  where status='posted'
  group by supplier_invoice_id
) c on c.supplier_invoice_id=i.id;

create or replace function refresh_supplier_invoice_status(p_invoice_id uuid)
returns void
language plpgsql
as $$
declare
  v_status text;
  v_amount numeric;
  v_balance numeric;
begin
  select status,amount into v_status,v_amount
  from supplier_invoice
  where id=p_invoice_id
  for update;

  if not found or v_status in ('draft','approved','reversed') then return; end if;

  select balance_amount into v_balance from supplier_invoice_balance where id=p_invoice_id;

  update supplier_invoice
  set status=case
    when v_balance<=0 then 'paid'
    when v_balance<v_amount then 'partially_paid'
    else 'posted'
  end,
  updated_at=now()
  where id=p_invoice_id;
end;
$$;

create or replace function validate_supplier_payment()
returns trigger
language plpgsql
as $$
declare
  v_invoice supplier_invoice%rowtype;
  v_balance numeric;
  v_account_currency text;
begin
  select * into v_invoice from supplier_invoice where id=new.supplier_invoice_id for update;
  if not found then raise exception 'Supplier invoice not found'; end if;
  if v_invoice.supplier_id<>new.supplier_id then raise exception 'Supplier payment and invoice supplier must match'; end if;
  if v_invoice.status not in ('posted','partially_paid') then raise exception 'Supplier payment requires an open posted supplier invoice'; end if;
  if v_invoice.currency<>new.currency then raise exception 'Supplier payment and invoice currencies must match'; end if;

  select a.currency into v_account_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_account_currency is null then raise exception 'Supplier payment account must be an active cash/bank account'; end if;
  if v_account_currency<>new.currency then raise exception 'Supplier payment and cash/bank account currencies must match'; end if;
  if new.method='check' and coalesce(new.cheque_number,'')='' then raise exception 'Cheque number is required for cheque payments'; end if;

  select balance_amount into v_balance from supplier_invoice_balance where id=new.supplier_invoice_id;
  if new.status='posted' and new.amount>v_balance then raise exception 'Supplier payment exceeds invoice balance'; end if;
  return new;
end;
$$;

create trigger supplier_payment_validate
before insert on supplier_payment
for each row execute function validate_supplier_payment();

create or replace function validate_supplier_credit()
returns trigger
language plpgsql
as $$
declare
  v_invoice supplier_invoice%rowtype;
  v_balance numeric;
  v_category text;
  v_currency text;
begin
  select * into v_invoice from supplier_invoice where id=new.supplier_invoice_id for update;
  if not found then raise exception 'Supplier invoice not found'; end if;
  if v_invoice.supplier_id<>new.supplier_id then raise exception 'Supplier credit and invoice supplier must match'; end if;
  if v_invoice.status not in ('posted','partially_paid') then raise exception 'Supplier credit requires an open posted supplier invoice'; end if;
  if v_invoice.currency<>new.currency then raise exception 'Supplier credit and invoice currencies must match'; end if;

  select t.category,a.currency into v_category,v_currency
  from account a join account_type t on t.id=a.account_type_id
  where a.id=new.expense_account_id and a.status='active' and a.allow_posting=true;
  if v_category is distinct from 'expense' then raise exception 'Supplier credit requires an active posting expense account'; end if;
  if v_currency<>new.currency then raise exception 'Supplier credit and expense account currencies must match'; end if;

  select balance_amount into v_balance from supplier_invoice_balance where id=new.supplier_invoice_id;
  if new.status='posted' and new.amount>v_balance then raise exception 'Supplier credit exceeds invoice balance'; end if;
  return new;
end;
$$;

create trigger supplier_credit_validate
before insert on supplier_credit
for each row execute function validate_supplier_credit();

create or replace function refresh_supplier_invoice_after_activity()
returns trigger
language plpgsql
as $$
begin
  perform refresh_supplier_invoice_status(coalesce(new.supplier_invoice_id,old.supplier_invoice_id));
  return new;
end;
$$;

create trigger supplier_payment_refresh
after insert or update of status on supplier_payment
for each row execute function refresh_supplier_invoice_after_activity();

create trigger supplier_credit_refresh
after insert or update of status on supplier_credit
for each row execute function refresh_supplier_invoice_after_activity();

create table parent_refund (
  id uuid primary key default gen_random_uuid(),
  refund_number text not null unique,
  family_id uuid not null references family(id) on delete restrict,
  student_id uuid references student(id) on delete restrict,
  payment_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  refunded_on date not null,
  method text not null default 'bank_transfer'
    check (method in ('cash','card','bank_transfer','check','other')),
  cheque_number text,
  cheque_due_on date,
  reference text,
  reason text not null,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  foreign key (student_id,family_id) references student(id,family_id) on delete restrict
);
create index parent_refund_family_idx on parent_refund(family_id,refunded_on desc);

create view family_credit_balance as
with currencies as (
  select family_id,currency from payment_balance where status='posted'
  union
  select family_id,currency from credit_note_balance where status='issued'
  union
  select family_id,currency from parent_refund where status='posted'
), payments as (
  select family_id,currency,sum(unallocated_amount) as unallocated_payments
  from payment_balance where status='posted'
  group by family_id,currency
), credits as (
  select family_id,currency,sum(unallocated_amount) as unallocated_credits
  from credit_note_balance where status='issued'
  group by family_id,currency
), refunds as (
  select family_id,currency,sum(amount) as refunded_amount
  from parent_refund where status='posted'
  group by family_id,currency
)
select
  x.family_id,x.currency,
  coalesce(p.unallocated_payments,0)::numeric(14,2) as unallocated_payments,
  coalesce(c.unallocated_credits,0)::numeric(14,2) as unallocated_credits,
  coalesce(r.refunded_amount,0)::numeric(14,2) as refunded_amount,
  (coalesce(p.unallocated_payments,0)+coalesce(c.unallocated_credits,0)-coalesce(r.refunded_amount,0))::numeric(14,2) as available_credit
from currencies x
left join payments p on p.family_id=x.family_id and p.currency=x.currency
left join credits c on c.family_id=x.family_id and c.currency=x.currency
left join refunds r on r.family_id=x.family_id and r.currency=x.currency;

create or replace function validate_parent_refund()
returns trigger
language plpgsql
as $$
declare
  v_available numeric;
  v_account_currency text;
begin
  perform 1 from family where id=new.family_id for update;
  if not found then raise exception 'Family not found'; end if;

  if new.student_id is not null and not exists (
    select 1 from student where id=new.student_id and family_id=new.family_id
  ) then
    raise exception 'Refund student must belong to the family';
  end if;

  select a.currency into v_account_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_account_currency is null then raise exception 'Refund account must be an active cash/bank account'; end if;
  if v_account_currency<>new.currency then raise exception 'Refund and cash/bank account currencies must match'; end if;
  if new.method='check' and coalesce(new.cheque_number,'')='' then raise exception 'Cheque number is required for cheque refunds'; end if;

  select available_credit into v_available from family_credit_balance where family_id=new.family_id and currency=new.currency;
  if new.status='posted' and new.amount>coalesce(v_available,0) then
    raise exception 'Refund exceeds available family credit';
  end if;
  return new;
end;
$$;

create trigger parent_refund_validate
before insert on parent_refund
for each row execute function validate_parent_refund();

create table cash_bank_transaction (
  id uuid primary key default gen_random_uuid(),
  transaction_number text not null unique,
  transaction_kind text not null check (transaction_kind in ('transfer','deposit','withdrawal')),
  account_id uuid not null references account(id) on delete restrict,
  contra_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transaction_date date not null,
  reference text,
  notes text,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (account_id<>contra_account_id)
);
create index cash_bank_transaction_date_idx on cash_bank_transaction(transaction_date desc);

create or replace function validate_cash_bank_transaction()
returns trigger
language plpgsql
as $$
declare
  v_account_currency text;
  v_contra_currency text;
begin
  select a.currency into v_account_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_account_currency is null then raise exception 'Transaction account must be an active cash/bank account'; end if;

  select currency into v_contra_currency
  from account
  where id=new.contra_account_id and status='active' and allow_posting=true;
  if v_contra_currency is null then raise exception 'Contra account must be an active posting account'; end if;
  if v_account_currency<>new.currency or v_contra_currency<>new.currency then
    raise exception 'Cash/bank transaction accounts and transaction currency must match';
  end if;

  if new.transaction_kind='transfer' and not exists (
    select 1 from cash_bank_account where account_id=new.contra_account_id and is_active=true
  ) then
    raise exception 'Transfers require both sides to be cash/bank accounts';
  end if;
  return new;
end;
$$;

create trigger cash_bank_transaction_validate
before insert on cash_bank_transaction
for each row execute function validate_cash_bank_transaction();

create table recurring_expense_category (
  category_key text primary key,
  name text not null,
  sort_order integer not null
);
insert into recurring_expense_category(category_key,name,sort_order) values
  ('social_media','Social media',10),
  ('accounting_fee','Accounting fee',20),
  ('internet','Internet',30),
  ('cleaning','Cleaning',40),
  ('software','Software',50),
  ('other','Other repeating expense',100)
on conflict (category_key) do update set name=excluded.name,sort_order=excluded.sort_order;

create table recurring_expense (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_key text not null references recurring_expense_category(category_key) on delete restrict,
  supplier_id uuid references supplier(id) on delete restrict,
  expense_account_id uuid not null references account(id) on delete restrict,
  payment_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  frequency text not null default 'monthly'
    check (frequency in ('monthly','quarterly','yearly')),
  next_due_on date not null,
  payment_method text not null default 'bank_transfer'
    check (payment_method in ('cash','card','bank_transfer','check','other')),
  reference_prefix text,
  notes text,
  status text not null default 'active' check (status in ('active','paused','ended')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create or replace function validate_recurring_expense()
returns trigger
language plpgsql
as $$
declare
  v_expense_category text;
  v_expense_currency text;
  v_payment_currency text;
begin
  select t.category,a.currency into v_expense_category,v_expense_currency
  from account a join account_type t on t.id=a.account_type_id
  where a.id=new.expense_account_id and a.status='active' and a.allow_posting=true;
  if v_expense_category is distinct from 'expense' then
    raise exception 'Recurring expense requires an active posting expense account';
  end if;

  select a.currency into v_payment_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_payment_currency is null then raise exception 'Recurring expense requires an active cash/bank payment account'; end if;
  if v_expense_currency<>new.currency or v_payment_currency<>new.currency then
    raise exception 'Recurring expense accounts and currency must match';
  end if;
  return new;
end;
$$;

create trigger recurring_expense_validate
before insert or update of expense_account_id,payment_account_id,currency on recurring_expense
for each row execute function validate_recurring_expense();

create table recurring_expense_occurrence (
  id uuid primary key default gen_random_uuid(),
  recurring_expense_id uuid not null references recurring_expense(id) on delete restrict,
  due_on date not null,
  expense_id uuid not null unique references expense(id) on delete restrict,
  generated_at timestamptz not null default now(),
  generated_by uuid references app_user(id) on delete set null,
  unique (recurring_expense_id,due_on)
);

create table bank_reconciliation (
  id uuid primary key default gen_random_uuid(),
  reconciliation_number text not null unique,
  account_id uuid not null references account(id) on delete restrict,
  statement_starts_on date not null,
  statement_ends_on date not null,
  statement_ending_balance numeric(14,2) not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','completed')),
  completed_at timestamptz,
  completed_by uuid references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (statement_ends_on>=statement_starts_on),
  check (
    (status='draft' and completed_at is null)
    or
    (status='completed' and completed_at is not null)
  )
);
create index bank_reconciliation_account_idx on bank_reconciliation(account_id,statement_ends_on desc);

create table bank_reconciliation_item (
  reconciliation_id uuid not null references bank_reconciliation(id) on delete restrict,
  journal_line_id uuid not null references journal_line(id) on delete restrict,
  added_at timestamptz not null default now(),
  added_by uuid references app_user(id) on delete set null,
  primary key (reconciliation_id,journal_line_id),
  unique (journal_line_id)
);

create or replace function validate_bank_reconciliation()
returns trigger
language plpgsql
as $$
declare
  v_currency text;
begin
  select a.currency into v_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.account_id and c.is_active=true;
  if v_currency is null then raise exception 'Reconciliation requires an active cash/bank account'; end if;
  if exists (
    select 1 from bank_reconciliation r
    where r.id<>new.id and r.account_id=new.account_id
      and r.status='completed'
      and daterange(r.statement_starts_on,r.statement_ends_on,'[]')
          && daterange(new.statement_starts_on,new.statement_ends_on,'[]')
  ) then
    raise exception 'Completed reconciliation periods cannot overlap for the same account';
  end if;
  return new;
end;
$$;

create trigger bank_reconciliation_validate
before insert or update of account_id,statement_starts_on,statement_ends_on on bank_reconciliation
for each row execute function validate_bank_reconciliation();

create or replace function validate_bank_reconciliation_item()
returns trigger
language plpgsql
as $$
declare
  v_account uuid;
  v_start date;
  v_end date;
  v_status text;
  v_line_account uuid;
  v_posting_date date;
  v_entry_status text;
begin
  select account_id,statement_starts_on,statement_ends_on,status
    into v_account,v_start,v_end,v_status
  from bank_reconciliation where id=new.reconciliation_id for update;
  if v_status is distinct from 'draft' then raise exception 'Completed reconciliation cannot be changed'; end if;

  select jl.account_id,je.posting_date,je.status
    into v_line_account,v_posting_date,v_entry_status
  from journal_line jl join journal_entry je on je.id=jl.journal_entry_id
  where jl.id=new.journal_line_id;

  if v_line_account is distinct from v_account then raise exception 'Reconciliation line belongs to a different account'; end if;
  if v_entry_status not in ('posted','reversed') then raise exception 'Only posted journal lines can be reconciled'; end if;
  if v_posting_date<v_start or v_posting_date>v_end then raise exception 'Reconciliation line is outside the statement period'; end if;
  return new;
end;
$$;

create trigger bank_reconciliation_item_validate
before insert on bank_reconciliation_item
for each row execute function validate_bank_reconciliation_item();

create or replace function protect_completed_reconciliation_items()
returns trigger
language plpgsql
as $$
declare
  v_id uuid;
begin
  v_id := case when tg_op='DELETE' then old.reconciliation_id else new.reconciliation_id end;
  if exists (select 1 from bank_reconciliation where id=v_id and status='completed') then
    raise exception 'Completed reconciliation items are immutable';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger bank_reconciliation_item_immutable
before update or delete on bank_reconciliation_item
for each row execute function protect_completed_reconciliation_items();

create or replace view bank_reconciliation_summary as
with previous as (
  select r.id,
    coalesce((
      select prior.statement_ending_balance
      from bank_reconciliation prior
      where prior.account_id=r.account_id
        and prior.status='completed'
        and prior.statement_ends_on<r.statement_starts_on
      order by prior.statement_ends_on desc,prior.created_at desc
      limit 1
    ),0)::numeric(14,2) as opening_reconciled_balance
  from bank_reconciliation r
), movement as (
  select
    ri.reconciliation_id,
    coalesce(sum(
      case when t.category in ('asset','expense')
        then jl.debit-jl.credit else jl.credit-jl.debit end
    ),0)::numeric(14,2) as cleared_movement
  from bank_reconciliation_item ri
  join journal_line jl on jl.id=ri.journal_line_id
  join account a on a.id=jl.account_id
  join account_type t on t.id=a.account_type_id
  group by ri.reconciliation_id
)
select
  r.*,
  p.opening_reconciled_balance,
  coalesce(m.cleared_movement,0)::numeric(14,2) as cleared_movement,
  (p.opening_reconciled_balance+coalesce(m.cleared_movement,0))::numeric(14,2) as reconciled_book_balance,
  (r.statement_ending_balance-(p.opening_reconciled_balance+coalesce(m.cleared_movement,0)))::numeric(14,2) as difference
from bank_reconciliation r
join previous p on p.id=r.id
left join movement m on m.reconciliation_id=r.id;

create or replace view cash_bank_balance as
select
  c.account_id,c.account_kind,c.display_name,c.bank_name,c.account_identifier,c.iban,c.is_active,
  a.code as account_code,a.name as account_name,a.currency,
  coalesce(ab.normal_balance,0)::numeric(14,2) as balance
from cash_bank_account c
join account a on a.id=c.account_id
left join account_balance ab on ab.account_id=c.account_id;

create or replace view supplier_statement as
with activity as (
  select
    i.supplier_id,i.currency,i.invoice_date as entry_date,i.created_at as occurred_at,
    'invoice'::text as entry_type,i.id as source_id,i.supplier_invoice_number as reference,
    coalesce(i.supplier_reference,'Supplier invoice') as description,
    i.amount::numeric(14,2) as payable_increase,0::numeric(14,2) as payable_decrease
  from supplier_invoice i
  where i.status not in ('draft','approved','reversed')
  union all
  select
    p.supplier_id,p.currency,p.paid_on,p.created_at,'payment',p.id,p.supplier_payment_number,
    coalesce(p.notes,'Supplier payment'),0::numeric(14,2),p.amount::numeric(14,2)
  from supplier_payment p where p.status='posted'
  union all
  select
    c.supplier_id,c.currency,c.credited_on,c.created_at,'credit',c.id,c.supplier_credit_number,
    c.reason,0::numeric(14,2),c.amount::numeric(14,2)
  from supplier_credit c where c.status='posted'
)
select
  a.*,
  sum(a.payable_increase-a.payable_decrease) over (
    partition by a.supplier_id,a.currency
    order by a.entry_date,a.occurred_at,a.source_id
    rows between unbounded preceding and current row
  )::numeric(14,2) as running_payable_balance
from activity a;

create or replace function accounting_operations_journal()
returns uuid
language plpgsql
stable
as $$
declare
  v_journal_id uuid;
begin
  select j.id into v_journal_id
  from accounting_configuration c
  join journal j on j.id=c.operations_journal_id
  where c.id=1 and j.status='active';
  if v_journal_id is null then
    raise exception 'Operations journal is not configured or is inactive';
  end if;
  return v_journal_id;
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

  v_journal_id := accounting_system_journal();
  v_asset := coalesce(v_payment.payment_account_id,accounting_mapped_account('payment_asset'));
  v_deposits := accounting_mapped_account('customer_deposits');

  if not exists (
    select 1 from account a
    join account_type t on t.id=a.account_type_id
    where a.id=v_asset and t.category='asset' and a.currency=v_payment.currency
      and a.status='active' and a.allow_posting=true
  ) then
    raise exception 'Payment asset account must be an active posting asset account in the payment currency';
  end if;

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

create or replace function accounting_post_expense(p_expense_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v expense%rowtype;
  v_existing uuid;
  v_entry uuid;
begin
  select id into v_existing from journal_entry where source_type='expense' and source_id=p_expense_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from expense where id=p_expense_id;
  if not found or v.status<>'approved' then raise exception 'Only approved expenses can be posted'; end if;

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'expense',v.incurred_on,v.currency,'Expense '||v.expense_number,
          coalesce(v.reference,v.expense_number),'expense',v.id,p_user_id)
  returning id into v_entry;

  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v.expense_account_id,coalesce(v.notes,'Expense'),v.amount,0,p_user_id),
    (v_entry,2,v.payment_account_id,'Expense payment',0,v.amount,p_user_id);

  perform post_journal_entry(v_entry,p_user_id);
  update expense set status='posted',updated_at=now(),updated_by=p_user_id where id=v.id;
  return v_entry;
end;
$$;

create or replace function accounting_post_supplier_invoice(p_invoice_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v supplier_invoice%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_ap uuid;
begin
  select id into v_existing from journal_entry where source_type='supplier_invoice' and source_id=p_invoice_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from supplier_invoice where id=p_invoice_id;
  if not found or v.status<>'approved' then raise exception 'Only approved supplier invoices can be posted'; end if;
  v_ap := accounting_mapped_account('accounts_payable');

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'system',v.invoice_date,v.currency,'Supplier invoice '||v.supplier_invoice_number,
          coalesce(v.supplier_reference,v.supplier_invoice_number),'supplier_invoice',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v.expense_account_id,'Supplier expense',v.amount,0,p_user_id),
    (v_entry,2,v_ap,'Accounts payable',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  update supplier_invoice set status='posted',posted_at=now(),updated_at=now(),updated_by=p_user_id where id=v.id;
  return v_entry;
end;
$$;

create or replace function accounting_post_supplier_payment(p_payment_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v supplier_payment%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_ap uuid;
begin
  select id into v_existing from journal_entry where source_type='supplier_payment' and source_id=p_payment_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from supplier_payment where id=p_payment_id;
  if not found or v.status<>'posted' then raise exception 'Only posted supplier payments can be posted'; end if;
  v_ap := accounting_mapped_account('accounts_payable');

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'system',v.paid_on,v.currency,'Supplier payment '||v.supplier_payment_number,
          coalesce(v.reference,v.supplier_payment_number),'supplier_payment',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v_ap,'Reduce accounts payable',v.amount,0,p_user_id),
    (v_entry,2,v.payment_account_id,'Supplier payment',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function accounting_post_supplier_credit(p_credit_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v supplier_credit%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_ap uuid;
begin
  select id into v_existing from journal_entry where source_type='supplier_credit' and source_id=p_credit_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from supplier_credit where id=p_credit_id;
  if not found or v.status<>'posted' then raise exception 'Only posted supplier credits can be posted'; end if;
  v_ap := accounting_mapped_account('accounts_payable');

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'system',v.credited_on,v.currency,'Supplier credit '||v.supplier_credit_number,
          coalesce(v.reference,v.supplier_credit_number),'supplier_credit',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v_ap,'Reduce accounts payable',v.amount,0,p_user_id),
    (v_entry,2,v.expense_account_id,'Supplier expense credit',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function accounting_post_parent_refund(p_refund_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v parent_refund%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_deposits uuid;
begin
  select id into v_existing from journal_entry where source_type='parent_refund' and source_id=p_refund_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from parent_refund where id=p_refund_id;
  if not found or v.status<>'posted' then raise exception 'Only posted parent refunds can be posted'; end if;
  v_deposits := accounting_mapped_account('customer_deposits');

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'system',v.refunded_on,v.currency,'Parent refund '||v.refund_number,
          coalesce(v.reference,v.refund_number),'parent_refund',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,family_id,student_id,created_by)
  values
    (v_entry,1,v_deposits,'Refund family credit',v.amount,0,v.family_id,v.student_id,p_user_id),
    (v_entry,2,v.payment_account_id,'Refund paid',0,v.amount,v.family_id,v.student_id,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function accounting_post_cash_bank_transaction(p_transaction_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v cash_bank_transaction%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_debit uuid;
  v_credit uuid;
begin
  select id into v_existing from journal_entry where source_type='cash_bank_transaction' and source_id=p_transaction_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from cash_bank_transaction where id=p_transaction_id;
  if not found or v.status<>'posted' then raise exception 'Only posted cash/bank transactions can be posted'; end if;

  if v.transaction_kind in ('transfer','deposit') then
    v_debit := v.account_id;
    v_credit := v.contra_account_id;
  else
    v_debit := v.contra_account_id;
    v_credit := v.account_id;
  end if;

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),
          case when v.transaction_kind='transfer' then 'transfer' else 'system' end,
          v.transaction_date,v.currency,
          initcap(v.transaction_kind)||' '||v.transaction_number,
          coalesce(v.reference,v.transaction_number),'cash_bank_transaction',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v_debit,initcap(v.transaction_kind),v.amount,0,p_user_id),
    (v_entry,2,v_credit,initcap(v.transaction_kind),0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  return v_entry;
end;
$$;

create or replace function reverse_operational_source(
  p_source_type text,p_source_id uuid,p_posting_date date,p_user_id uuid default null,p_reason text default 'Reversal'
)
returns uuid language plpgsql as $$
declare
  v_entry uuid;
begin
  select id into v_entry from journal_entry
  where source_type=p_source_type and source_id=p_source_id and status='posted';
  if v_entry is null then raise exception 'Posted accounting entry not found for source'; end if;
  return reverse_journal_entry(v_entry,p_posting_date,p_user_id,p_reason);
end;
$$;

create or replace function complete_bank_reconciliation(p_reconciliation_id uuid,p_user_id uuid default null)
returns void language plpgsql as $$
declare
  v_difference numeric;
  v_status text;
begin
  select status into v_status
  from bank_reconciliation
  where id=p_reconciliation_id
  for update;
  if not found then raise exception 'Reconciliation not found'; end if;
  if v_status is distinct from 'draft' then raise exception 'Only draft reconciliations can be completed'; end if;

  select difference into v_difference
  from bank_reconciliation_summary
  where id=p_reconciliation_id;
  if v_difference<>0 then raise exception 'Reconciliation difference must be zero before completion'; end if;

  update bank_reconciliation
  set status='completed',completed_at=now(),completed_by=p_user_id
  where id=p_reconciliation_id;
end;
$$;

insert into permission(key,description) values
  ('expenses.view','View expenses and expense receipts'),
  ('expenses.manage','Create and edit expenses'),
  ('expenses.approve','Approve submitted expenses and supplier bills'),
  ('expenses.post','Post approved expenses and supplier bills to accounting'),
  ('suppliers.view','View suppliers, bills, credits, payments, and statements'),
  ('suppliers.manage','Create and manage suppliers, bills, credits, and payments'),
  ('banking.view','View cash/bank accounts, balances, and transactions'),
  ('banking.manage','Manage cash/bank accounts, deposits, withdrawals, and transfers'),
  ('banking.reconcile','Create and complete bank/cash reconciliations'),
  ('recurring_expenses.view','View recurring expense templates'),
  ('recurring_expenses.manage','Create, pause, and generate recurring expenses'),
  ('refunds.manage','Refund available parent credits')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
