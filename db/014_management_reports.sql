-- Step 8 — Net Position, Management & Reports
-- Reporting is read-only and derives financial figures from posted journal entries.
-- Step 7 owns migrations 009 through 013; Step 8 begins at 014.

create or replace function report_account_balances(p_through date)
returns table (
  account_id uuid, account_code text, account_name text, currency text, category text,
  total_debit numeric(14,2), total_credit numeric(14,2), normal_balance numeric(14,2)
)
language sql stable
as $$
  select a.id,a.code,a.name,a.currency,t.category,
    coalesce(sum(jl.debit) filter (
      where je.status in ('posted','reversed') and je.posting_date<=p_through
    ),0)::numeric(14,2),
    coalesce(sum(jl.credit) filter (
      where je.status in ('posted','reversed') and je.posting_date<=p_through
    ),0)::numeric(14,2),
    (case when t.category in ('asset','expense')
      then coalesce(sum(jl.debit-jl.credit) filter (
        where je.status in ('posted','reversed') and je.posting_date<=p_through
      ),0)
      else coalesce(sum(jl.credit-jl.debit) filter (
        where je.status in ('posted','reversed') and je.posting_date<=p_through
      ),0)
    end)::numeric(14,2)
  from account a
  join account_type t on t.id=a.account_type_id
  left join journal_line jl on jl.account_id=a.id
  left join journal_entry je on je.id=jl.journal_entry_id
  group by a.id,a.code,a.name,a.currency,t.category;
$$;

create or replace function report_trial_balance(p_through date)
returns table (
  account_id uuid, account_code text, account_name text, currency text, category text,
  total_debit numeric(14,2), total_credit numeric(14,2),
  debit_balance numeric(14,2), credit_balance numeric(14,2)
)
language sql stable
as $$
  select b.account_id,b.account_code,b.account_name,b.currency,b.category,
    b.total_debit,b.total_credit,
    greatest(b.total_debit-b.total_credit,0)::numeric(14,2),
    greatest(b.total_credit-b.total_debit,0)::numeric(14,2)
  from report_account_balances(p_through) b;
$$;

create or replace function report_position(p_through date)
returns table (
  currency text, assets numeric(14,2), liabilities numeric(14,2), equity numeric(14,2),
  income numeric(14,2), expenses numeric(14,2), current_surplus numeric(14,2),
  net_position numeric(14,2), equation_difference numeric(14,2)
)
language sql stable
as $$
  select b.currency,
    coalesce(sum(b.normal_balance) filter (where b.category='asset'),0)::numeric(14,2),
    coalesce(sum(b.normal_balance) filter (where b.category='liability'),0)::numeric(14,2),
    coalesce(sum(b.normal_balance) filter (where b.category='equity'),0)::numeric(14,2),
    coalesce(sum(b.normal_balance) filter (where b.category='income'),0)::numeric(14,2),
    coalesce(sum(b.normal_balance) filter (where b.category='expense'),0)::numeric(14,2),
    (coalesce(sum(b.normal_balance) filter (where b.category='income'),0)
      - coalesce(sum(b.normal_balance) filter (where b.category='expense'),0))::numeric(14,2),
    (coalesce(sum(b.normal_balance) filter (where b.category='asset'),0)
      - coalesce(sum(b.normal_balance) filter (where b.category='liability'),0))::numeric(14,2),
    (coalesce(sum(b.normal_balance) filter (where b.category='asset'),0)
      - (coalesce(sum(b.normal_balance) filter (where b.category='liability'),0)
        + coalesce(sum(b.normal_balance) filter (where b.category='equity'),0)
        + coalesce(sum(b.normal_balance) filter (where b.category='income'),0)
        - coalesce(sum(b.normal_balance) filter (where b.category='expense'),0)))::numeric(14,2)
  from report_account_balances(p_through) b
  group by b.currency;
$$;

create or replace function report_profit_loss(p_from date,p_to date)
returns table (
  account_id uuid, account_code text, account_name text, currency text,
  category text, amount numeric(14,2)
)
language sql stable
as $$
  select a.id,a.code,a.name,a.currency,t.category,
    (case when t.category='income' then
      coalesce(sum(jl.credit-jl.debit) filter (where je.id is not null),0)
      else coalesce(sum(jl.debit-jl.credit) filter (where je.id is not null),0)
    end)::numeric(14,2)
  from account a
  join account_type t on t.id=a.account_type_id
  left join journal_line jl on jl.account_id=a.id
  left join journal_entry je on je.id=jl.journal_entry_id
    and je.status in ('posted','reversed')
    and je.posting_date between p_from and p_to
  where t.category in ('income','expense')
  group by a.id,a.code,a.name,a.currency,t.category;
$$;

create or replace function report_general_ledger(p_from date,p_to date)
returns table (
  account_id uuid, account_code text, account_name text, category text,
  journal_entry_id uuid, entry_number text, entry_kind text, posting_date date,
  transaction_reference text, entry_description text, source_type text, source_id uuid,
  line_number integer, line_description text, debit numeric(14,2), credit numeric(14,2),
  currency text, family_id uuid, student_id uuid, running_balance numeric(14,2)
)
language sql stable
as $$
  with ledger as (
    select a.id as account_id,a.code as account_code,a.name as account_name,t.category,
      je.id as journal_entry_id,je.entry_number,je.entry_kind,je.posting_date,
      je.transaction_reference,je.description as entry_description,je.source_type,je.source_id,
      jl.line_number,jl.description as line_description,jl.debit,jl.credit,je.currency,
      jl.family_id,jl.student_id,
      sum(case when t.category in ('asset','expense')
        then jl.debit-jl.credit else jl.credit-jl.debit end) over (
          partition by a.id
          order by je.posting_date,je.posted_at,je.id,jl.line_number,jl.id
          rows between unbounded preceding and current row
      )::numeric(14,2) as running_balance
    from journal_line jl
    join journal_entry je on je.id=jl.journal_entry_id
    join account a on a.id=jl.account_id
    join account_type t on t.id=a.account_type_id
    where je.status in ('posted','reversed') and je.posting_date<=p_to
  )
  select * from ledger where posting_date>=p_from;
$$;

create or replace function report_cash_bank_balances(p_through date)
returns table (
  account_id uuid, account_kind text, display_name text, bank_name text,
  account_identifier text, iban text, currency text, balance numeric(14,2)
)
language sql stable
as $$
  select c.account_id,c.account_kind,c.display_name,c.bank_name,c.account_identifier,c.iban,
    a.currency,coalesce(b.normal_balance,0)::numeric(14,2)
  from cash_bank_account c
  join account a on a.id=c.account_id
  left join report_account_balances(p_through) b on b.account_id=c.account_id
  where c.is_active=true;
$$;

create or replace function report_cash_flow(p_from date,p_to date)
returns table (
  activity_class text, source_type text, currency text,
  inflow numeric(14,2), outflow numeric(14,2), net_change numeric(14,2)
)
language sql stable
as $$
  with entries as (
    select je.id,je.entry_kind,je.source_type,je.source_id,je.currency,
      coalesce(sum(case when cb.account_id is not null then jl.debit-jl.credit else 0 end),0)::numeric(14,2) as cash_change,
      bool_or(cb.account_id is null and at.category='equity') as has_equity,
      bool_or(cb.account_id is null and at.category='asset') as has_other_asset,
      bool_or(cb.account_id is null and at.category in ('income','expense','liability')) as has_operating_counterpart
    from journal_entry je
    join journal_line jl on jl.journal_entry_id=je.id
    join account a on a.id=jl.account_id
    join account_type at on at.id=a.account_type_id
    left join cash_bank_account cb on cb.account_id=a.id
    where je.status in ('posted','reversed')
      and je.posting_date between p_from and p_to
      and je.entry_kind<>'opening_balance'
    group by je.id
  ), classified as (
    select e.*,
      case
        when e.cash_change=0 then 'internal_transfer'
        when e.source_type in (
          'billing_payment','parent_refund','expense','supplier_payment',
          'rent_payment','salary_advance','payroll_payment','salary_payment'
        ) or coalesce(e.source_type,'') like 'payroll%' then 'operating'
        when e.has_equity then 'financing'
        when e.has_other_asset and not e.has_operating_counterpart then 'investing'
        when e.has_operating_counterpart then 'operating'
        else 'other'
      end as activity_class
    from entries e
  )
  select c.activity_class,coalesce(c.source_type,'manual'),c.currency,
    coalesce(sum(greatest(c.cash_change,0)),0)::numeric(14,2),
    coalesce(sum(greatest(-c.cash_change,0)),0)::numeric(14,2),
    coalesce(sum(c.cash_change),0)::numeric(14,2)
  from classified c
  where c.cash_change<>0
  group by c.activity_class,coalesce(c.source_type,'manual'),c.currency
  order by c.currency,c.activity_class,coalesce(c.source_type,'manual');
$$;

create or replace function report_receivables(p_through date)
returns table (
  invoice_id uuid, invoice_number text, family_id uuid, family_number text, family_name text,
  student_id uuid, student_number text, student_name text, issued_on date, due_on date,
  currency text, total_amount numeric(12,2), paid_amount numeric(12,2),
  credit_amount numeric(12,2), balance_amount numeric(12,2)
)
language sql stable
as $$
  with paid as (
    select pa.invoice_id,sum(pa.amount)::numeric(12,2) as amount
    from payment_allocation pa
    join payment p on p.id=pa.payment_id
    where pa.allocated_on<=p_through and p.received_on<=p_through
      and (p.status='posted' or p.reversed_at::date>p_through)
    group by pa.invoice_id
  ), credited as (
    select ca.invoice_id,sum(ca.amount)::numeric(12,2) as amount
    from credit_note_allocation ca
    join credit_note c on c.id=ca.credit_note_id
    where ca.allocated_on<=p_through and c.issued_on<=p_through
      and (c.status='issued' or c.reversed_at::date>p_through)
    group by ca.invoice_id
  )
  select i.id,i.invoice_number,i.family_id,f.family_number,f.display_name,
    i.student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name),
    i.issued_on,i.due_on,i.currency,i.total_amount,
    coalesce(p.amount,0)::numeric(12,2),coalesce(c.amount,0)::numeric(12,2),
    greatest(i.total_amount-coalesce(p.amount,0)-coalesce(c.amount,0),0)::numeric(12,2)
  from invoice i
  join family f on f.id=i.family_id
  join student s on s.id=i.student_id
  left join paid p on p.invoice_id=i.id
  left join credited c on c.invoice_id=i.id
  where i.issued_on is not null and i.issued_on<=p_through
    and i.status not in ('draft','void');
$$;

create or replace function report_payables(p_through date)
returns table (
  supplier_invoice_id uuid, supplier_invoice_number text, supplier_id uuid,
  supplier_number text, supplier_name text, invoice_date date, due_on date,
  currency text, total_amount numeric(14,2), paid_amount numeric(14,2),
  credit_amount numeric(14,2), balance_amount numeric(14,2)
)
language sql stable
as $$
  with bills as (
    select * from supplier_invoice i
    where i.invoice_date<=p_through and (
      i.status in ('posted','partially_paid','paid')
      or (i.status='reversed' and i.reversed_at::date>p_through)
    )
  ), paid as (
    select p.supplier_invoice_id,sum(p.amount)::numeric(14,2) as amount
    from supplier_payment p
    where p.paid_on<=p_through and (p.status='posted' or p.reversed_at::date>p_through)
    group by p.supplier_invoice_id
  ), credited as (
    select c.supplier_invoice_id,sum(c.amount)::numeric(14,2) as amount
    from supplier_credit c
    where c.credited_on<=p_through and (c.status='posted' or c.reversed_at::date>p_through)
    group by c.supplier_invoice_id
  )
  select i.id,i.supplier_invoice_number,i.supplier_id,s.supplier_number,s.name,
    i.invoice_date,i.due_on,i.currency,i.amount,
    coalesce(p.amount,0)::numeric(14,2),coalesce(c.amount,0)::numeric(14,2),
    greatest(i.amount-coalesce(p.amount,0)-coalesce(c.amount,0),0)::numeric(14,2)
  from bills i
  join supplier s on s.id=i.supplier_id
  left join paid p on p.supplier_invoice_id=i.id
  left join credited c on c.supplier_invoice_id=i.id;
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
      coalesce(sum(pa.amount) filter (where pa.allocated_on<=p_through),0) as allocated
    from payment p
    left join payment_allocation pa on pa.payment_id=p.id
    where p.received_on<=p_through and (p.status='posted' or p.reversed_at::date>p_through)
    group by p.id
  ), credit_totals as (
    select c.id,c.family_id,c.currency,c.amount,
      coalesce(sum(ca.amount) filter (where ca.allocated_on<=p_through),0) as allocated
    from credit_note c
    left join credit_note_allocation ca on ca.credit_note_id=c.id
    where c.issued_on<=p_through and (c.status='issued' or c.reversed_at::date>p_through)
    group by c.id
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

create or replace view report_enrollment as
select se.id as enrollment_id,se.status as enrollment_status,se.enrolled_on,se.starts_on,
  se.withdrawal_on,se.withdrawal_reason,
  s.id as student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
  s.status as student_status,
  f.id as family_id,f.family_number,f.display_name as family_name,
  y.id as school_year_id,y.name as school_year_name,
  c.id as class_id,c.name as class_name,
  coalesce(json_agg(json_build_object(
    'id',t.id,'name',t.name,'sequence',t.sequence,'status',ste.status,
    'startsOn',ste.starts_on,'endsOn',ste.ends_on
  ) order by t.sequence) filter (where ste.id is not null),'[]') as terms
from student_enrollment se
join student s on s.id=se.student_id
join family f on f.id=s.family_id
join school_year y on y.id=se.school_year_id
join school_class c on c.id=se.class_id
left join student_term_enrollment ste on ste.enrollment_id=se.id
left join school_term t on t.id=ste.term_id
group by se.id,s.id,f.id,y.id,c.id;

create or replace view report_fee_discount as
select i.id as invoice_id,i.invoice_number,i.issued_on,i.due_on,i.currency,
  i.total_amount as invoice_total,i.discount_amount as invoice_discount,
  f.id as family_id,f.family_number,f.display_name as family_name,
  s.id as student_id,s.student_number,concat_ws(' ',s.first_name,s.last_name) as student_name,
  t.name as term_name,
  il.id as invoice_line_id,il.description as line_description,il.gross_amount,
  il.discount_amount,il.net_amount,ild.discount_label,ild.discount_kind,
  ild.discount_value,ild.applied_amount,ild.combination_mode
from invoice i
join family f on f.id=i.family_id
join student s on s.id=i.student_id
join school_term t on t.id=i.term_id
join invoice_line il on il.invoice_id=i.id
left join invoice_line_discount ild on ild.invoice_line_id=il.id
where i.status not in ('draft','void');

insert into permission(key,description) values
  ('management.view','View the management dashboard and management KPIs'),
  ('reports.view','View financial, school, payroll, and operational reports'),
  ('reports.export','Export authorized reports to CSV'),
  ('report_documents.view','View and print management report documents')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
