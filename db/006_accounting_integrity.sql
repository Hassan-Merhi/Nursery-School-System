-- Step 4 accounting integrity hardening and reporting fixes.

create unique index if not exists journal_entry_one_reversal_idx
  on journal_entry(reversal_of_entry_id)
  where reversal_of_entry_id is not null;

create or replace function enforce_posted_journal_balance()
returns trigger
language plpgsql
as $$
declare
  v_line_count integer;
  v_debit numeric(14,2);
  v_credit numeric(14,2);
  v_validate_post boolean := false;
begin
  if new.status in ('posted','reversed') then
    select count(*),coalesce(sum(debit),0)::numeric(14,2),coalesce(sum(credit),0)::numeric(14,2)
      into v_line_count,v_debit,v_credit
    from journal_line
    where journal_entry_id=new.id;

    if v_line_count<2 or v_debit<=0 or v_debit<>v_credit then
      raise exception 'Posted journal entries must contain at least two balanced lines';
    end if;
  end if;

  if new.status='posted' then
    if tg_op='INSERT' then
      v_validate_post := true;
    elsif tg_op='UPDATE' and old.status is distinct from 'posted' then
      v_validate_post := true;
    end if;
  end if;

  if v_validate_post then
    perform 1
    from accounting_period
    where status='open'
      and new.posting_date between starts_on and ends_on
    for share;
    if not found then
      raise exception 'Posting date is not inside an open accounting period';
    end if;

    if exists (
      select 1
      from journal_line l
      join account a on a.id=l.account_id
      where l.journal_entry_id=new.id
        and (a.status<>'active' or a.allow_posting=false)
    ) then
      raise exception 'Journal entry contains an inactive or non-posting account';
    end if;

    if exists (
      select 1
      from journal_line l
      join account a on a.id=l.account_id
      where l.journal_entry_id=new.id
        and a.currency<>new.currency
    ) then
      raise exception 'All journal accounts must use the journal entry currency';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists journal_entry_balance_guard on journal_entry;
create trigger journal_entry_balance_guard
before insert or update of status on journal_entry
for each row execute function enforce_posted_journal_balance();

create or replace function protect_account_identity_after_posting()
returns trigger
language plpgsql
as $$
begin
  if (old.account_type_id is distinct from new.account_type_id
      or old.currency is distinct from new.currency)
     and exists (
       select 1
       from journal_line jl
       join journal_entry je on je.id=jl.journal_entry_id
       where jl.account_id=old.id
         and je.status in ('posted','reversed')
     )
  then
    raise exception 'Account type and currency cannot change after the account has posted activity';
  end if;
  return new;
end;
$$;

drop trigger if exists account_identity_after_posting on account;
create trigger account_identity_after_posting
before update of account_type_id,currency on account
for each row execute function protect_account_identity_after_posting();

create or replace function protect_mapped_account_availability()
returns trigger
language plpgsql
as $$
begin
  if (new.status<>'active' or new.allow_posting=false)
     and exists (select 1 from accounting_mapping where account_id=old.id)
  then
    raise exception 'Mapped accounting accounts must remain active posting accounts until the mapping is changed';
  end if;
  return new;
end;
$$;

drop trigger if exists mapped_account_availability_guard on account;
create trigger mapped_account_availability_guard
before update of status,allow_posting on account
for each row execute function protect_mapped_account_availability();

create or replace function protect_account_type_category_in_use()
returns trigger
language plpgsql
as $$
begin
  if old.category is distinct from new.category
     and exists (select 1 from account where account_type_id=old.id)
  then
    raise exception 'Account type category cannot change while accounts use this type';
  end if;
  return new;
end;
$$;

drop trigger if exists account_type_category_in_use on account_type;
create trigger account_type_category_in_use
before update of category on account_type
for each row execute function protect_account_type_category_in_use();

create or replace function protect_period_boundaries_with_postings()
returns trigger
language plpgsql
as $$
begin
  if (old.starts_on is distinct from new.starts_on or old.ends_on is distinct from new.ends_on)
     and exists (
       select 1 from journal_entry je
       where je.status in ('posted','reversed')
         and je.posting_date between old.starts_on and old.ends_on
     )
  then
    raise exception 'Accounting period dates cannot change after transactions have been posted in the period';
  end if;
  return new;
end;
$$;

drop trigger if exists accounting_period_boundary_guard on accounting_period;
create trigger accounting_period_boundary_guard
before update of starts_on,ends_on on accounting_period
for each row execute function protect_period_boundaries_with_postings();

-- Fully discounted invoices have no accounting value and therefore require no journal entry.
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
  if v_invoice.total_amount=0 then
    return null;
  end if;
  if v_invoice.total_amount<0 then
    raise exception 'Invoice total cannot be negative for accounting posting';
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

-- Draft lines must never leak into financial statements. Reports are also currency-aware.
-- Drop the dependent views first because the currency-aware shape intentionally adds a column.
drop view accounting_position;
drop view account_balance;
drop view trial_balance;

create view trial_balance as
with posted_lines as (
  select jl.*
  from journal_line jl
  join journal_entry je on je.id=jl.journal_entry_id
  where je.status in ('posted','reversed')
), totals as (
  select
    a.id as account_id,
    a.code as account_code,
    a.name as account_name,
    a.currency,
    t.category,
    coalesce(sum(pl.debit),0)::numeric(14,2) as total_debit,
    coalesce(sum(pl.credit),0)::numeric(14,2) as total_credit
  from account a
  join account_type t on t.id=a.account_type_id
  left join posted_lines pl on pl.account_id=a.id
  group by a.id,a.code,a.name,a.currency,t.category
)
select
  account_id,account_code,account_name,currency,category,total_debit,total_credit,
  greatest(total_debit-total_credit,0)::numeric(14,2) as debit_balance,
  greatest(total_credit-total_debit,0)::numeric(14,2) as credit_balance
from totals;

create view account_balance as
select
  tb.*,
  case
    when tb.category in ('asset','expense')
      then (tb.total_debit-tb.total_credit)::numeric(14,2)
    else (tb.total_credit-tb.total_debit)::numeric(14,2)
  end as normal_balance
from trial_balance tb;

create view accounting_position as
select
  currency,
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
from account_balance
group by currency;
