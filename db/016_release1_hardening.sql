-- Step 9 — Release 1 Hardening
-- Adds explicit term closure protection and a read-only release reconciliation gate.

alter table school_term
  add column if not exists status text not null default 'open';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid='school_term'::regclass
      and conname='school_term_status_check'
  ) then
    alter table school_term
      add constraint school_term_status_check
      check (status in ('open','closed'));
  end if;
end;
$$;

create index if not exists school_term_status_idx
  on school_term(school_year_id,status,sequence);

create or replace function assert_school_term_open(p_term_id uuid)
returns void
language plpgsql
stable
as $$
declare
  v_term_status text;
  v_year_status text;
begin
  select t.status,y.status
  into v_term_status,v_year_status
  from school_term t
  join school_year y on y.id=t.school_year_id
  where t.id=p_term_id;

  if not found then
    raise exception 'School term not found';
  end if;

  if v_term_status='closed' or v_year_status='closed' then
    raise exception 'The selected school term is closed and cannot accept new academic or billing activity';
  end if;
end;
$$;

create or replace function guard_student_term_enrollment_closed_term()
returns trigger
language plpgsql
as $$
begin
  if tg_op='INSERT'
     or new.term_id is distinct from old.term_id
     or (new.status='enrolled' and old.status is distinct from 'enrolled') then
    perform assert_school_term_open(new.term_id);
  end if;
  return new;
end;
$$;

drop trigger if exists release_student_term_open_guard on student_term_enrollment;
create trigger release_student_term_open_guard
before insert or update on student_term_enrollment
for each row execute function guard_student_term_enrollment_closed_term();

create or replace function guard_student_discount_closed_term()
returns trigger
language plpgsql
as $$
begin
  if tg_op='INSERT'
     or new.term_id is distinct from old.term_id
     or (
       new.status in ('pending','approved')
       and (
         new.status is distinct from old.status
         or new.override_kind is distinct from old.override_kind
         or new.override_value is distinct from old.override_value
         or new.priority_override is distinct from old.priority_override
       )
     ) then
    perform assert_school_term_open(new.term_id);
  end if;
  return new;
end;
$$;

drop trigger if exists release_student_discount_open_guard on student_discount;
create trigger release_student_discount_open_guard
before insert or update on student_discount
for each row execute function guard_student_discount_closed_term();

create or replace function guard_fee_schedule_closed_term()
returns trigger
language plpgsql
as $$
begin
  if tg_op='INSERT'
     or new.term_id is distinct from old.term_id
     or new.name is distinct from old.name
     or new.standard_fee is distinct from old.standard_fee
     or new.currency is distinct from old.currency
     or (new.status is distinct from old.status and new.status in ('draft','active')) then
    perform assert_school_term_open(new.term_id);
  end if;
  return new;
end;
$$;

drop trigger if exists release_fee_schedule_open_guard on fee_schedule;
create trigger release_fee_schedule_open_guard
before insert or update on fee_schedule
for each row execute function guard_fee_schedule_closed_term();

create or replace function guard_invoice_closed_term()
returns trigger
language plpgsql
as $$
begin
  if tg_op='INSERT'
     or new.term_id is distinct from old.term_id
     or (old.status='draft' and new.status='issued') then
    perform assert_school_term_open(new.term_id);
  end if;
  return new;
end;
$$;

drop trigger if exists release_invoice_open_guard on invoice;
create trigger release_invoice_open_guard
before insert or update on invoice
for each row execute function guard_invoice_closed_term();

create or replace function guard_invoice_line_closed_term()
returns trigger
language plpgsql
as $$
declare
  v_invoice_id uuid;
  v_term_id uuid;
  v_status text;
begin
  v_invoice_id := case when tg_op='DELETE' then old.invoice_id else new.invoice_id end;
  select i.term_id,i.status into v_term_id,v_status
  from invoice i
  where i.id=v_invoice_id;

  if v_status='draft' then
    perform assert_school_term_open(v_term_id);
  end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists release_invoice_line_open_guard on invoice_line;
create trigger release_invoice_line_open_guard
before insert or update or delete on invoice_line
for each row execute function guard_invoice_line_closed_term();

create or replace function guard_invoice_line_discount_closed_term()
returns trigger
language plpgsql
as $$
declare
  v_line_id uuid;
  v_term_id uuid;
  v_status text;
begin
  v_line_id := case when tg_op='DELETE' then old.invoice_line_id else new.invoice_line_id end;
  select i.term_id,i.status into v_term_id,v_status
  from invoice_line l
  join invoice i on i.id=l.invoice_id
  where l.id=v_line_id;

  if v_status='draft' then
    perform assert_school_term_open(v_term_id);
  end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists release_invoice_line_discount_open_guard on invoice_line_discount;
create trigger release_invoice_line_discount_open_guard
before insert or update or delete on invoice_line_discount
for each row execute function guard_invoice_line_discount_closed_term();

create or replace function release_reconciliation_gate(p_through date)
returns table (
  check_name text,
  currency text,
  system_amount numeric(14,2),
  ledger_amount numeric(14,2),
  difference numeric(14,2),
  passed boolean,
  details text
)
language sql
stable
as $$
with currencies as (
  select distinct a.currency
  from account a
),
ar_ops as (
  select r.currency,sum(r.balance_amount)::numeric(14,2) amount
  from report_receivables(p_through) r
  group by r.currency
),
ar_ledger as (
  select c.currency,m.account_id,a.id matched_account,
    b.normal_balance::numeric(14,2) amount
  from currencies c
  left join accounting_mapping m on m.role_key='accounts_receivable'
  left join account a on a.id=m.account_id and a.currency=c.currency
  left join report_account_balances(p_through) b on b.account_id=a.id
),
credit_ops as (
  select r.currency,sum(r.available_credit)::numeric(14,2) amount
  from report_family_credits(p_through) r
  group by r.currency
),
credit_ledger as (
  select c.currency,m.account_id,a.id matched_account,
    b.normal_balance::numeric(14,2) amount
  from currencies c
  left join accounting_mapping m on m.role_key='customer_deposits'
  left join account a on a.id=m.account_id and a.currency=c.currency
  left join report_account_balances(p_through) b on b.account_id=a.id
),
ap_ops as (
  select r.currency,sum(r.balance_amount)::numeric(14,2) amount
  from report_payables(p_through) r
  group by r.currency
),
ap_ledger as (
  select c.currency,m.account_id,a.id matched_account,
    b.normal_balance::numeric(14,2) amount
  from currencies c
  left join accounting_mapping m on m.role_key='accounts_payable'
  left join account a on a.id=m.account_id and a.currency=c.currency
  left join report_account_balances(p_through) b on b.account_id=a.id
),
cash_screen as (
  select r.currency,r.account_kind,sum(r.balance)::numeric(14,2) amount
  from report_cash_bank_balances(p_through) r
  group by r.currency,r.account_kind
),
cash_ledger as (
  select a.currency,c.account_kind,sum(coalesce(b.normal_balance,0))::numeric(14,2) amount
  from cash_bank_account c
  join account a on a.id=c.account_id
  left join report_account_balances(p_through) b on b.account_id=c.account_id
  group by a.currency,c.account_kind
),
payroll_ops as (
  select s.currency,sum(s.payroll_expense)::numeric(14,2) amount
  from payroll_run_summary s
  where s.status in ('locked','paid') and s.pay_date<=p_through
  group by s.currency
),
payroll_ledger as (
  select c.currency,m.account_id,a.id matched_account,
    coalesce(sum(jl.debit-jl.credit) filter (where je.id is not null),0)::numeric(14,2) amount
  from currencies c
  left join accounting_mapping m on m.role_key='payroll_expense'
  left join account a on a.id=m.account_id and a.currency=c.currency
  left join journal_line jl on jl.account_id=a.id
  left join journal_entry je on je.id=jl.journal_entry_id
    and je.status in ('posted','reversed')
    and je.source_type='payroll_run'
    and je.posting_date<=p_through
  group by c.currency,m.account_id,a.id
),
position as (
  select p.currency,p.net_position,
    (p.equity+p.current_surplus)::numeric(14,2) ledger_position
  from report_position(p_through) p
),
trial as (
  select t.currency,
    sum(t.debit_balance)::numeric(14,2) debits,
    sum(t.credit_balance)::numeric(14,2) credits
  from report_trial_balance(p_through) t
  group by t.currency
)
select
  'Student balances = Accounts Receivable',c.currency,
  coalesce(o.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(o.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  (l.matched_account is not null and abs(coalesce(o.amount,0)-coalesce(l.amount,0))<0.005),
  case when l.matched_account is null then 'Accounts Receivable mapping is missing or uses another currency'
       else 'Open student invoices compared with the mapped receivables control account' end
from currencies c
left join ar_ops o on o.currency=c.currency
left join ar_ledger l on l.currency=c.currency

union all

select
  'Family credits = Customer Deposits',c.currency,
  coalesce(o.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(o.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  (l.matched_account is not null and abs(coalesce(o.amount,0)-coalesce(l.amount,0))<0.005),
  case when l.matched_account is null then 'Customer Deposits mapping is missing or uses another currency'
       else 'Unallocated payments, credits and refunds compared with the deposits liability' end
from currencies c
left join credit_ops o on o.currency=c.currency
left join credit_ledger l on l.currency=c.currency

union all

select
  'Supplier balances = Accounts Payable',c.currency,
  coalesce(o.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(o.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  (l.matched_account is not null and abs(coalesce(o.amount,0)-coalesce(l.amount,0))<0.005),
  case when l.matched_account is null then 'Accounts Payable mapping is missing or uses another currency'
       else 'Open supplier invoices compared with the mapped payables control account' end
from currencies c
left join ap_ops o on o.currency=c.currency
left join ap_ledger l on l.currency=c.currency

union all

select
  'Cash screens = Cash ledger',c.currency,
  coalesce(s.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(s.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  abs(coalesce(s.amount,0)-coalesce(l.amount,0))<0.005,
  'Cash workspace balances compared with posted ledger balances'
from currencies c
left join cash_screen s on s.currency=c.currency and s.account_kind='cash'
left join cash_ledger l on l.currency=c.currency and l.account_kind='cash'

union all

select
  'Bank screens = Bank ledger',c.currency,
  coalesce(s.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(s.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  abs(coalesce(s.amount,0)-coalesce(l.amount,0))<0.005,
  'Bank workspace balances compared with posted ledger balances'
from currencies c
left join cash_screen s on s.currency=c.currency and s.account_kind='bank'
left join cash_ledger l on l.currency=c.currency and l.account_kind='bank'

union all

select
  'Payroll reports = Payroll accounting',c.currency,
  coalesce(o.amount,0)::numeric(14,2),coalesce(l.amount,0)::numeric(14,2),
  (coalesce(o.amount,0)-coalesce(l.amount,0))::numeric(14,2),
  (l.matched_account is not null and abs(coalesce(o.amount,0)-coalesce(l.amount,0))<0.005),
  case when l.matched_account is null then 'Payroll Expense mapping is missing or uses another currency'
       else 'Locked payroll expense compared with payroll-source ledger postings' end
from currencies c
left join payroll_ops o on o.currency=c.currency
left join payroll_ledger l on l.currency=c.currency

union all

select
  'Net Position = Accounting ledger',c.currency,
  coalesce(p.net_position,0)::numeric(14,2),coalesce(p.ledger_position,0)::numeric(14,2),
  (coalesce(p.net_position,0)-coalesce(p.ledger_position,0))::numeric(14,2),
  abs(coalesce(p.net_position,0)-coalesce(p.ledger_position,0))<0.005,
  'Assets minus liabilities compared with equity plus current surplus'
from currencies c
left join position p on p.currency=c.currency

union all

select
  'Trial Balance debits = Trial Balance credits',c.currency,
  coalesce(t.debits,0)::numeric(14,2),coalesce(t.credits,0)::numeric(14,2),
  (coalesce(t.debits,0)-coalesce(t.credits,0))::numeric(14,2),
  abs(coalesce(t.debits,0)-coalesce(t.credits,0))<0.005,
  'Posted debit and credit balances through the release gate date'
from currencies c
left join trial t on t.currency=c.currency
order by 2,1;
$$;
