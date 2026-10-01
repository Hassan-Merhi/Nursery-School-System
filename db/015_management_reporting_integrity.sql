-- Step 8 reporting integrity hardening.
-- Keep historical management reports stable after later status changes and reversals.

create or replace function report_effective_reversal_date(
  p_source_type text,
  p_source_id uuid,
  p_fallback timestamptz default null
)
returns date
language sql stable
as $$
  select coalesce(
    (
      select reversal.posting_date
      from journal_entry original
      join journal_entry reversal on reversal.id=original.reversed_by_entry_id
      where original.source_type=p_source_type
        and original.source_id=p_source_id
        and original.entry_kind<>'reversal'
      order by original.posting_date,original.id
      limit 1
    ),
    p_fallback::date
  );
$$;

create or replace function report_active_student_count(p_through date)
returns integer
language sql stable
as $$
  select count(distinct se.student_id)::integer
  from student_enrollment se
  join student_term_enrollment ste on ste.enrollment_id=se.id
  where se.status<>'cancelled'
    and ste.status<>'cancelled'
    and ste.starts_on<=p_through
    and ste.ends_on>=p_through
    and (se.withdrawal_on is null or se.withdrawal_on>p_through);
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
  left join report_account_balances(p_through) b on b.account_id=c.account_id;
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
      and (
        p.status='posted'
        or report_effective_reversal_date('billing_payment',p.id,p.reversed_at)>p_through
      )
    group by pa.invoice_id
  ), credited as (
    select ca.invoice_id,sum(ca.amount)::numeric(12,2) as amount
    from credit_note_allocation ca
    join credit_note c on c.id=ca.credit_note_id
    where ca.allocated_on<=p_through and c.issued_on<=p_through
      and (
        c.status='issued'
        or report_effective_reversal_date('billing_credit_note',c.id,c.reversed_at)>p_through
      )
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
      or (
        i.status='reversed'
        and report_effective_reversal_date('supplier_invoice',i.id,i.reversed_at)>p_through
      )
    )
  ), paid as (
    select p.supplier_invoice_id,sum(p.amount)::numeric(14,2) as amount
    from supplier_payment p
    where p.paid_on<=p_through and (
      p.status='posted'
      or report_effective_reversal_date('supplier_payment',p.id,p.reversed_at)>p_through
    )
    group by p.supplier_invoice_id
  ), credited as (
    select c.supplier_invoice_id,sum(c.amount)::numeric(14,2) as amount
    from supplier_credit c
    where c.credited_on<=p_through and (
      c.status='posted'
      or report_effective_reversal_date('supplier_credit',c.id,c.reversed_at)>p_through
    )
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
    where p.received_on<=p_through and (
      p.status='posted'
      or report_effective_reversal_date('billing_payment',p.id,p.reversed_at)>p_through
    )
    group by p.id
  ), credit_totals as (
    select c.id,c.family_id,c.currency,c.amount,
      coalesce(sum(ca.amount) filter (where ca.allocated_on<=p_through),0) as allocated
    from credit_note c
    left join credit_note_allocation ca on ca.credit_note_id=c.id
    where c.issued_on<=p_through and (
      c.status='issued'
      or report_effective_reversal_date('billing_credit_note',c.id,c.reversed_at)>p_through
    )
    group by c.id
  ), refunds as (
    select r.family_id,r.currency,sum(r.amount)::numeric(14,2) as amount
    from parent_refund r
    where r.refunded_on<=p_through and (
      r.status='posted'
      or report_effective_reversal_date('parent_refund',r.id,r.reversed_at)>p_through
    )
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
