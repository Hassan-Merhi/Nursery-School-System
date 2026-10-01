-- Step 7 — Employees, Payroll & Salary Advances

insert into document_sequence(document_type,prefix) values
  ('employee','EMP'),
  ('salary_advance','ADV'),
  ('payroll_run','PAY'),
  ('payroll_payment','PPAY')
on conflict (document_type) do nothing;

alter table accounting_configuration
  add column if not exists payroll_journal_id uuid references journal(id) on delete restrict;

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('payroll_expense','Payroll Expense','Expense account for salary, allowances and bonuses net of payroll deductions.','expense'),
  ('salary_payable','Salary Payable','Liability for locked payroll that has not yet been paid.','liability'),
  ('salary_advance','Salary Advances','Asset account for employee salary advances outstanding and recovered through payroll.','asset')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create table job_title (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

create table employee (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null unique,
  first_name text not null,
  last_name text not null,
  job_title_id uuid references job_title(id) on delete restrict,
  email text,
  phone text,
  address text,
  start_on date not null,
  end_on date,
  status text not null default 'active' check (status in ('active','inactive','terminated')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  check (end_on is null or end_on>=start_on),
  check (status<>'terminated' or end_on is not null)
);
create index employee_name_idx on employee(lower(last_name),lower(first_name));
create index employee_status_idx on employee(status,start_on,end_on);

-- Salary agreements are append-only. The effective end is derived from the next
-- agreement rather than stored/updated, which makes salary history impossible to overwrite.
create table employee_salary_agreement (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employee(id) on delete restrict,
  effective_from date not null,
  monthly_salary numeric(14,2) not null check (monthly_salary>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (employee_id,effective_from)
);
create index employee_salary_effective_idx on employee_salary_agreement(employee_id,effective_from desc);

create or replace function prevent_salary_agreement_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Salary history is append-only; create a new salary agreement for a salary change';
end;
$$;
create trigger salary_agreement_immutable
before update or delete on employee_salary_agreement
for each row execute function prevent_salary_agreement_mutation();

create view employee_salary_history as
select
  s.id,s.employee_id,s.effective_from,
  (lead(s.effective_from) over (partition by s.employee_id order by s.effective_from)-1) as effective_to,
  s.monthly_salary,s.currency,s.notes,s.created_at,s.created_by
from employee_salary_agreement s;

create table salary_advance (
  id uuid primary key default gen_random_uuid(),
  advance_number text not null unique,
  employee_id uuid not null references employee(id) on delete restrict,
  advance_date date not null,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  payment_account_id uuid not null references account(id) on delete restrict,
  installments_count integer not null check (installments_count between 1 and 120),
  first_repayment_on date not null,
  reference text,
  notes text,
  status text not null default 'posted' check (status in ('posted','repaid','reversed')),
  journal_entry_id uuid references journal_entry(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (first_repayment_on>=advance_date)
);
create index salary_advance_employee_idx on salary_advance(employee_id,advance_date desc);
create index salary_advance_status_idx on salary_advance(status,first_repayment_on);

create table salary_advance_repayment_schedule (
  id uuid primary key default gen_random_uuid(),
  salary_advance_id uuid not null references salary_advance(id) on delete restrict,
  installment_number integer not null check (installment_number>0),
  due_on date not null,
  amount numeric(14,2) not null check (amount>0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (salary_advance_id,installment_number)
);
create index salary_advance_schedule_due_idx on salary_advance_repayment_schedule(due_on,salary_advance_id);

create table payroll_run (
  id uuid primary key default gen_random_uuid(),
  run_number text not null unique,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (status in ('draft','pending','approved','locked','paid')),
  notes text,
  submitted_at timestamptz,
  submitted_by uuid references app_user(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references app_user(id) on delete set null,
  locked_at timestamptz,
  locked_by uuid references app_user(id) on delete set null,
  journal_entry_id uuid references journal_entry(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  check (period_end>=period_start),
  unique (period_start,period_end,currency)
);
create index payroll_run_period_idx on payroll_run(period_end desc,status);

create table payroll_run_item (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references payroll_run(id) on delete restrict,
  employee_id uuid not null references employee(id) on delete restrict,
  salary_agreement_id uuid not null references employee_salary_agreement(id) on delete restrict,
  base_salary numeric(14,2) not null check (base_salary>0),
  allowance_total numeric(14,2) not null default 0 check (allowance_total>=0),
  bonus_total numeric(14,2) not null default 0 check (bonus_total>=0),
  deduction_total numeric(14,2) not null default 0 check (deduction_total>=0),
  advance_repayment_total numeric(14,2) not null default 0 check (advance_repayment_total>=0),
  gross_pay numeric(14,2) not null default 0 check (gross_pay>=0),
  payroll_expense numeric(14,2) not null default 0 check (payroll_expense>=0),
  net_pay numeric(14,2) not null default 0 check (net_pay>=0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (payroll_run_id,employee_id)
);
create index payroll_run_item_employee_idx on payroll_run_item(employee_id,payroll_run_id);

create table payroll_adjustment (
  id uuid primary key default gen_random_uuid(),
  payroll_run_item_id uuid not null references payroll_run_item(id) on delete restrict,
  adjustment_type text not null check (adjustment_type in ('allowance','bonus','deduction')),
  description text not null,
  amount numeric(14,2) not null check (amount>0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index payroll_adjustment_item_idx on payroll_adjustment(payroll_run_item_id,adjustment_type);

create table salary_advance_repayment_allocation (
  id uuid primary key default gen_random_uuid(),
  repayment_schedule_id uuid not null references salary_advance_repayment_schedule(id) on delete restrict,
  payroll_run_item_id uuid not null references payroll_run_item(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (repayment_schedule_id,payroll_run_item_id)
);
create index salary_advance_allocation_item_idx on salary_advance_repayment_allocation(payroll_run_item_id);

create table payroll_payment (
  id uuid primary key default gen_random_uuid(),
  payment_number text not null unique,
  payroll_run_id uuid not null references payroll_run(id) on delete restrict,
  payment_account_id uuid not null references account(id) on delete restrict,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_on date not null,
  method text not null default 'bank_transfer' check (method in ('cash','bank_transfer','check','other')),
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
create unique index payroll_payment_one_active_idx on payroll_payment(payroll_run_id) where status='posted';
create index payroll_payment_date_idx on payroll_payment(paid_on desc,status);

create or replace function validate_salary_advance_cash_account()
returns trigger
language plpgsql
as $$
declare v_currency text;
begin
  select a.currency into v_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_currency is null then raise exception 'Salary advance payment account must be an active cash/bank account'; end if;
  if v_currency<>new.currency then raise exception 'Salary advance and payment account currencies must match'; end if;
  return new;
end;
$$;

create or replace function validate_payroll_payment_cash_account()
returns trigger
language plpgsql
as $$
declare v_currency text;
begin
  select a.currency into v_currency
  from cash_bank_account c join account a on a.id=c.account_id
  where c.account_id=new.payment_account_id and c.is_active=true
    and a.status='active' and a.allow_posting=true;
  if v_currency is null then raise exception 'Payroll payment account must be an active cash/bank account'; end if;
  if v_currency<>new.currency then raise exception 'Payroll payment and cash/bank account currencies must match'; end if;
  if new.method='check' and coalesce(new.cheque_number,'')='' then raise exception 'Cheque number is required for cheque payroll payments'; end if;
  return new;
end;
$$;

create trigger salary_advance_cash_validate
before insert or update of payment_account_id,currency on salary_advance
for each row execute function validate_salary_advance_cash_account();

create trigger payroll_payment_cash_validate
before insert or update of payment_account_id,currency,method,cheque_number on payroll_payment
for each row execute function validate_payroll_payment_cash_account();
