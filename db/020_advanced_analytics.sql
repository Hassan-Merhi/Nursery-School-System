-- Step 13 — Advanced Dashboard & Analysis
-- Read-only analytics derived from the trusted operational and accounting sources.
-- Monetary results are always separated by currency.

create or replace function analytics_month_ranges(p_from date,p_to date)
returns table(month_start date,period_start date,period_end date)
language sql stable
as $$
  select
    d::date as month_start,
    greatest(d::date,p_from) as period_start,
    least((d+interval '1 month - 1 day')::date,p_to) as period_end
  from generate_series(
    date_trunc('month',p_from)::date,
    date_trunc('month',p_to)::date,
    interval '1 month'
  ) d
  where p_to>=p_from;
$$;

create or replace function analytics_fee_collection(p_from date,p_to date)
returns table(
  currency text,
  expected_fees numeric(14,2),
  collected_fees numeric(14,2),
  collection_rate numeric(9,2)
)
language sql stable
as $$
  with expected as (
    select i.currency,sum(i.total_amount)::numeric(14,2) amount
    from invoice i
    where i.due_on between p_from and p_to
      and i.status not in ('draft','void')
    group by i.currency
  ), collected as (
    select p.currency,sum(pa.amount)::numeric(14,2) amount
    from payment p
    join payment_allocation pa on pa.payment_id=p.id
    where p.received_on between p_from and p_to
      and pa.allocated_on<=p_to
      and (
        p.status='posted'
        or report_effective_reversal_date('billing_payment',p.id,p.reversed_at)>p_to
      )
    group by p.currency
  ), currencies as (
    select currency from expected
    union
    select currency from collected
  )
  select c.currency,
    coalesce(e.amount,0)::numeric(14,2),
    coalesce(x.amount,0)::numeric(14,2),
    case when coalesce(e.amount,0)=0 then null
      else round(coalesce(x.amount,0)*100.0/e.amount,2)::numeric(9,2)
    end
  from currencies c
  left join expected e using(currency)
  left join collected x using(currency)
  order by c.currency;
$$;

create or replace function analytics_monthly_students(p_from date,p_to date)
returns table(
  month_start date,
  period_start date,
  period_end date,
  opening_active integer,
  new_enrollments integer,
  withdrawals integer,
  closing_active integer,
  net_change integer,
  net_growth_rate numeric(9,2)
)
language sql stable
as $$
  select m.month_start,m.period_start,m.period_end,
    report_active_student_count(m.period_start-1)::integer as opening_active,
    (
      select count(distinct se.student_id)::integer
      from student_enrollment se
      where se.status<>'cancelled'
        and se.starts_on between m.period_start and m.period_end
    ) as new_enrollments,
    (
      select count(distinct se.student_id)::integer
      from student_enrollment se
      where se.withdrawal_on between m.period_start and m.period_end
    ) as withdrawals,
    report_active_student_count(m.period_end)::integer as closing_active,
    (report_active_student_count(m.period_end)-report_active_student_count(m.period_start-1))::integer as net_change,
    case when report_active_student_count(m.period_start-1)=0 then null
      else round(
        (report_active_student_count(m.period_end)-report_active_student_count(m.period_start-1))*100.0
        /report_active_student_count(m.period_start-1),2
      )::numeric(9,2)
    end as net_growth_rate
  from analytics_month_ranges(p_from,p_to) m
  order by m.month_start;
$$;

create or replace function analytics_monthly_financials(p_from date,p_to date)
returns table(
  month_start date,
  period_start date,
  period_end date,
  currency text,
  income numeric(14,2),
  expenses numeric(14,2),
  expected_fees numeric(14,2),
  collected_fees numeric(14,2),
  collection_rate numeric(9,2),
  active_students integer
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), currencies as (
    select distinct currency from (
      select je.currency
      from journal_entry je
      where je.status in ('posted','reversed') and je.posting_date between p_from and p_to
      union all
      select i.currency from invoice i where i.due_on between p_from and p_to and i.status not in ('draft','void')
      union all
      select p.currency from payment p where p.received_on between p_from and p_to
      union all
      select a.currency
      from cash_bank_account c join account a on a.id=c.account_id
    ) x
  )
  select m.month_start,m.period_start,m.period_end,c.currency,
    coalesce(pl.income,0)::numeric(14,2),
    coalesce(pl.expenses,0)::numeric(14,2),
    coalesce(f.expected_fees,0)::numeric(14,2),
    coalesce(f.collected_fees,0)::numeric(14,2),
    f.collection_rate,
    report_active_student_count(m.period_end)::integer
  from months m
  cross join currencies c
  left join lateral (
    select
      coalesce(sum(r.amount) filter(where r.category='income' and r.currency=c.currency),0)::numeric(14,2) income,
      coalesce(sum(r.amount) filter(where r.category='expense' and r.currency=c.currency),0)::numeric(14,2) expenses
    from report_profit_loss(m.period_start,m.period_end) r
  ) pl on true
  left join lateral (
    select * from analytics_fee_collection(m.period_start,m.period_end) x where x.currency=c.currency
  ) f on true
  order by m.month_start,c.currency;
$$;

create or replace function analytics_expense_trend(p_from date,p_to date)
returns table(
  month_start date,
  period_start date,
  period_end date,
  currency text,
  account_id uuid,
  account_code text,
  account_name text,
  monthly_amount numeric(14,2),
  period_amount numeric(14,2),
  period_expense_total numeric(14,2),
  share_percent numeric(9,2),
  prior_period_amount numeric(14,2),
  change_amount numeric(14,2),
  change_percent numeric(9,2)
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), accounts as (
    select distinct a.id,a.code,a.name,a.currency
    from account a
    join account_type t on t.id=a.account_type_id and t.category='expense'
    join journal_line jl on jl.account_id=a.id
    join journal_entry je on je.id=jl.journal_entry_id
    where je.status in ('posted','reversed')
      and (
        je.posting_date between p_from and p_to
        or je.posting_date between (p_from-interval '1 year')::date and (p_to-interval '1 year')::date
      )
  ), current_monthly as (
    select m.month_start,m.period_start,m.period_end,a.id account_id,a.code,a.name,a.currency,
      coalesce(sum(jl.debit-jl.credit),0)::numeric(14,2) monthly_amount
    from months m cross join accounts a
    left join journal_entry je
      on je.status in ('posted','reversed')
     and je.posting_date between m.period_start and m.period_end
     and je.currency=a.currency
    left join journal_line jl on jl.journal_entry_id=je.id and jl.account_id=a.id
    group by m.month_start,m.period_start,m.period_end,a.id,a.code,a.name,a.currency
  ), enriched as (
    select x.*,
      sum(x.monthly_amount) over(partition by x.account_id)::numeric(14,2) period_amount,
      sum(x.monthly_amount) over()::numeric(14,2) period_expense_total
    from current_monthly x
  ), prior as (
    select a.id account_id,
      coalesce(sum(jl.debit-jl.credit),0)::numeric(14,2) amount
    from accounts a
    left join journal_entry je
      on je.status in ('posted','reversed')
     and je.posting_date between (p_from-interval '1 year')::date and (p_to-interval '1 year')::date
     and je.currency=a.currency
    left join journal_line jl on jl.journal_entry_id=je.id and jl.account_id=a.id
    group by a.id
  )
  select e.month_start,e.period_start,e.period_end,e.currency,e.account_id,e.code,e.name,
    e.monthly_amount,e.period_amount,e.period_expense_total,
    case when e.period_expense_total=0 then null
      else round(e.period_amount*100.0/e.period_expense_total,2)::numeric(9,2)
    end,
    p.amount,
    (e.period_amount-p.amount)::numeric(14,2),
    case when p.amount=0 then null
      else round((e.period_amount-p.amount)*100.0/p.amount,2)::numeric(9,2)
    end
  from enriched e join prior p on p.account_id=e.account_id
  order by e.currency,e.period_amount desc,e.account_code,e.month_start;
$$;

create or replace function analytics_payroll_trend(p_from date,p_to date)
returns table(
  month_start date,
  currency text,
  base_salary numeric(14,2),
  allowances numeric(14,2),
  bonuses numeric(14,2),
  deductions numeric(14,2),
  payroll_expense numeric(14,2),
  advance_repayments numeric(14,2),
  net_pay numeric(14,2),
  employee_count integer
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), currencies as (
    select distinct r.currency
    from payroll_run r
    where r.status in ('locked','paid') and r.period_end between p_from and p_to
  )
  select m.month_start,c.currency,
    coalesce(sum(i.base_salary),0)::numeric(14,2),
    coalesce(sum(i.allowance_total),0)::numeric(14,2),
    coalesce(sum(i.bonus_total),0)::numeric(14,2),
    coalesce(sum(i.deduction_total),0)::numeric(14,2),
    coalesce(sum(i.payroll_expense),0)::numeric(14,2),
    coalesce(sum(i.advance_repayment_total),0)::numeric(14,2),
    coalesce(sum(i.net_pay),0)::numeric(14,2),
    count(distinct i.employee_id)::integer
  from months m cross join currencies c
  left join payroll_run r
    on r.currency=c.currency
   and r.status in ('locked','paid')
   and r.period_end between m.period_start and m.period_end
  left join payroll_run_item i on i.payroll_run_id=r.id
  group by m.month_start,c.currency
  order by m.month_start,c.currency;
$$;

create or replace function analytics_rent_trend(p_from date,p_to date)
returns table(
  month_start date,
  currency text,
  recognized_rent_expense numeric(14,2),
  total_expenses numeric(14,2),
  total_income numeric(14,2),
  rent_percent_expenses numeric(9,2),
  rent_percent_income numeric(9,2)
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), currencies as (
    select distinct currency from account
  ), rent_account as (
    select account_id from accounting_mapping where role_key='rent_expense'
  )
  select m.month_start,c.currency,
    coalesce(r.rent_amount,0)::numeric(14,2),
    coalesce(pl.expenses,0)::numeric(14,2),
    coalesce(pl.income,0)::numeric(14,2),
    case when coalesce(pl.expenses,0)=0 then null
      else round(coalesce(r.rent_amount,0)*100.0/pl.expenses,2)::numeric(9,2)
    end,
    case when coalesce(pl.income,0)=0 then null
      else round(coalesce(r.rent_amount,0)*100.0/pl.income,2)::numeric(9,2)
    end
  from months m cross join currencies c
  left join lateral (
    select coalesce(sum(jl.debit-jl.credit),0)::numeric(14,2) rent_amount
    from journal_entry je
    join journal_line jl on jl.journal_entry_id=je.id
    join rent_account ra on ra.account_id=jl.account_id
    where je.status in ('posted','reversed')
      and je.currency=c.currency
      and je.posting_date between m.period_start and m.period_end
  ) r on true
  left join lateral (
    select
      coalesce(sum(x.amount) filter(where x.category='expense' and x.currency=c.currency),0)::numeric(14,2) expenses,
      coalesce(sum(x.amount) filter(where x.category='income' and x.currency=c.currency),0)::numeric(14,2) income
    from report_profit_loss(m.period_start,m.period_end) x
  ) pl on true
  order by m.month_start,c.currency;
$$;

create or replace function analytics_cash_trend(p_from date,p_to date)
returns table(
  month_start date,
  currency text,
  external_inflow numeric(14,2),
  external_outflow numeric(14,2),
  net_external_movement numeric(14,2),
  closing_cash numeric(14,2),
  closing_bank numeric(14,2),
  closing_total numeric(14,2)
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), currencies as (
    select distinct a.currency
    from cash_bank_account c join account a on a.id=c.account_id
  )
  select m.month_start,c.currency,
    coalesce(f.inflow,0)::numeric(14,2),
    coalesce(f.outflow,0)::numeric(14,2),
    coalesce(f.net_change,0)::numeric(14,2),
    coalesce(b.cash_balance,0)::numeric(14,2),
    coalesce(b.bank_balance,0)::numeric(14,2),
    (coalesce(b.cash_balance,0)+coalesce(b.bank_balance,0))::numeric(14,2)
  from months m cross join currencies c
  left join lateral (
    select
      coalesce(sum(x.inflow) filter(where x.currency=c.currency),0)::numeric(14,2) inflow,
      coalesce(sum(x.outflow) filter(where x.currency=c.currency),0)::numeric(14,2) outflow,
      coalesce(sum(x.net_change) filter(where x.currency=c.currency),0)::numeric(14,2) net_change
    from report_cash_flow(m.period_start,m.period_end) x
  ) f on true
  left join lateral (
    select
      coalesce(sum(x.balance) filter(where x.currency=c.currency and x.account_kind='cash'),0)::numeric(14,2) cash_balance,
      coalesce(sum(x.balance) filter(where x.currency=c.currency and x.account_kind='bank'),0)::numeric(14,2) bank_balance
    from report_cash_bank_balances(m.period_end) x
  ) b on true
  order by m.month_start,c.currency;
$$;

create or replace function analytics_food_trend(p_from date,p_to date)
returns table(
  month_start date,
  currency text,
  purchased_amount numeric(14,2),
  food_revenue numeric(14,2),
  usage_cost numeric(14,2),
  waste_cost numeric(14,2),
  spoilage_cost numeric(14,2),
  correction_cost numeric(14,2),
  other_cost numeric(14,2),
  food_cost numeric(14,2),
  contribution numeric(14,2),
  contribution_margin numeric(9,2),
  cost_available boolean
)
language sql stable
as $$
  with months as (
    select * from analytics_month_ranges(p_from,p_to)
  ), currencies as (
    select distinct currency from (
      select b.currency from food_bill b where b.issued_on between p_from and p_to
      union all
      select a.currency from inventory_adjustment a where a.occurred_on between p_from and p_to
      union all
      select r.currency from inventory_receipt r where r.received_on between p_from and p_to
      union all
      select a.currency from account a
      join accounting_mapping m on m.account_id=a.id
      where m.role_key in ('food_income','food_program_expense')
    ) x
  ), food_income_account as (
    select account_id from accounting_mapping where role_key='food_income'
  ), food_cost_account as (
    select account_id from accounting_mapping where role_key='food_program_expense'
  ), revenue as (
    select date_trunc('month',je.posting_date)::date month_start,je.currency,
      sum(jl.credit-jl.debit)::numeric(14,2) amount
    from journal_entry je
    join journal_line jl on jl.journal_entry_id=je.id
    join food_income_account a on a.account_id=jl.account_id
    where je.status in ('posted','reversed') and je.posting_date between p_from and p_to
    group by 1,2
  ), cost as (
    select date_trunc('month',je.posting_date)::date month_start,je.currency,
      sum(jl.debit-jl.credit)::numeric(14,2) food_cost,
      sum(case when adj.adjustment_kind='usage' then jl.debit-jl.credit else 0 end)::numeric(14,2) usage_cost,
      sum(case when adj.adjustment_kind='waste' then jl.debit-jl.credit else 0 end)::numeric(14,2) waste_cost,
      sum(case when adj.adjustment_kind='spoilage' then jl.debit-jl.credit else 0 end)::numeric(14,2) spoilage_cost,
      sum(case when adj.adjustment_kind in ('correction_in','correction_out') then jl.debit-jl.credit else 0 end)::numeric(14,2) correction_cost
    from journal_entry je
    join journal_line jl on jl.journal_entry_id=je.id
    join food_cost_account a on a.account_id=jl.account_id
    left join journal_entry original on original.id=je.reversal_of_entry_id
    left join inventory_adjustment adj on adj.id=case
      when je.source_type='inventory_adjustment' then je.source_id
      when je.entry_kind='reversal' and original.source_type='inventory_adjustment' then original.source_id
      else null
    end
    where je.status in ('posted','reversed') and je.posting_date between p_from and p_to
    group by 1,2
  ), purchases as (
    select date_trunc('month',m.occurred_on)::date month_start,r.currency,
      sum(m.value_delta)::numeric(14,2) amount
    from inventory_movement m
    join inventory_receipt_line rl on rl.id=m.source_id
    join inventory_receipt r on r.id=rl.inventory_receipt_id
    where m.source_type in ('inventory_receipt_line','inventory_receipt_reversal')
      and m.occurred_on between p_from and p_to
    group by 1,2
  )
  select m.month_start,c.currency,
    coalesce(p.amount,0)::numeric(14,2),
    coalesce(r.amount,0)::numeric(14,2),
    coalesce(k.usage_cost,0)::numeric(14,2),
    coalesce(k.waste_cost,0)::numeric(14,2),
    coalesce(k.spoilage_cost,0)::numeric(14,2),
    coalesce(k.correction_cost,0)::numeric(14,2),
    (coalesce(k.food_cost,0)-coalesce(k.usage_cost,0)-coalesce(k.waste_cost,0)
      -coalesce(k.spoilage_cost,0)-coalesce(k.correction_cost,0))::numeric(14,2),
    coalesce(k.food_cost,0)::numeric(14,2),
    (coalesce(r.amount,0)-coalesce(k.food_cost,0))::numeric(14,2),
    case when coalesce(r.amount,0)=0 then null
      else round((coalesce(r.amount,0)-coalesce(k.food_cost,0))*100.0/r.amount,2)::numeric(9,2)
    end,
    true
  from months m cross join currencies c
  left join purchases p on p.month_start=m.month_start and p.currency=c.currency
  left join revenue r on r.month_start=m.month_start and r.currency=c.currency
  left join cost k on k.month_start=m.month_start and k.currency=c.currency
  order by m.month_start,c.currency;
$$;

create or replace function analytics_period_summary(p_from date,p_to date)
returns table(
  currency text,
  income numeric(14,2),
  expenses numeric(14,2),
  expected_fees numeric(14,2),
  collected_fees numeric(14,2),
  collection_rate numeric(9,2),
  payroll_expense numeric(14,2),
  rent_expense numeric(14,2),
  food_revenue numeric(14,2),
  food_cost numeric(14,2),
  food_contribution numeric(14,2),
  net_cash_movement numeric(14,2)
)
language sql stable
as $$
  with currencies as (
    select distinct currency from (
      select je.currency from journal_entry je
       where je.status in ('posted','reversed') and je.posting_date between p_from and p_to
      union all select i.currency from invoice i where i.due_on between p_from and p_to and i.status not in ('draft','void')
      union all select p.currency from payment p where p.received_on between p_from and p_to
      union all select r.currency from payroll_run r where r.status in ('locked','paid') and r.period_end between p_from and p_to
    ) x
  ), pl as (
    select currency,
      coalesce(sum(amount) filter(where category='income'),0)::numeric(14,2) income,
      coalesce(sum(amount) filter(where category='expense'),0)::numeric(14,2) expenses
    from report_profit_loss(p_from,p_to)
    group by currency
  ), payroll as (
    select currency,coalesce(sum(payroll_expense),0)::numeric(14,2) amount
    from analytics_payroll_trend(p_from,p_to) group by currency
  ), rent as (
    select currency,coalesce(sum(recognized_rent_expense),0)::numeric(14,2) amount
    from analytics_rent_trend(p_from,p_to) group by currency
  ), food as (
    select currency,
      coalesce(sum(food_revenue),0)::numeric(14,2) revenue,
      coalesce(sum(food_cost),0)::numeric(14,2) cost,
      coalesce(sum(contribution),0)::numeric(14,2) contribution
    from analytics_food_trend(p_from,p_to) group by currency
  ), cash as (
    select currency,coalesce(sum(net_external_movement),0)::numeric(14,2) amount
    from analytics_cash_trend(p_from,p_to) group by currency
  )
  select c.currency,
    coalesce(pl.income,0)::numeric(14,2),
    coalesce(pl.expenses,0)::numeric(14,2),
    coalesce(f.expected_fees,0)::numeric(14,2),
    coalesce(f.collected_fees,0)::numeric(14,2),
    f.collection_rate,
    coalesce(py.amount,0)::numeric(14,2),
    coalesce(rt.amount,0)::numeric(14,2),
    coalesce(fd.revenue,0)::numeric(14,2),
    coalesce(fd.cost,0)::numeric(14,2),
    coalesce(fd.contribution,0)::numeric(14,2),
    coalesce(cf.amount,0)::numeric(14,2)
  from currencies c
  left join pl using(currency)
  left join analytics_fee_collection(p_from,p_to) f using(currency)
  left join payroll py using(currency)
  left join rent rt using(currency)
  left join food fd using(currency)
  left join cash cf using(currency)
  order by c.currency;
$$;

create or replace function analytics_term_comparison(p_school_year_id uuid)
returns table(
  term_id uuid,
  term_sequence smallint,
  term_name text,
  starts_on date,
  ends_on date,
  currency text,
  active_students integer,
  expected_fees numeric(14,2),
  collected_fees numeric(14,2),
  outstanding_receivables numeric(14,2),
  collection_rate numeric(9,2),
  income numeric(14,2),
  expenses numeric(14,2),
  payroll_expense numeric(14,2),
  rent_expense numeric(14,2),
  food_revenue numeric(14,2),
  food_cost numeric(14,2),
  food_contribution numeric(14,2),
  net_cash_movement numeric(14,2)
)
language sql stable
as $$
  with terms as (
    select * from school_term where school_year_id=p_school_year_id
  ), currencies as (
    select distinct currency from account
  )
  select t.id,t.sequence,t.name,t.starts_on,t.ends_on,c.currency,
    report_active_student_count(t.ends_on)::integer,
    coalesce(s.expected_fees,0)::numeric(14,2),
    coalesce(s.collected_fees,0)::numeric(14,2),
    coalesce((
      select sum(r.balance_amount)
      from report_receivables(t.ends_on) r
      join invoice i on i.id=r.invoice_id and i.term_id=t.id
      where r.currency=c.currency
    ),0)::numeric(14,2),
    s.collection_rate,
    coalesce(s.income,0)::numeric(14,2),
    coalesce(s.expenses,0)::numeric(14,2),
    coalesce(s.payroll_expense,0)::numeric(14,2),
    coalesce(s.rent_expense,0)::numeric(14,2),
    coalesce(s.food_revenue,0)::numeric(14,2),
    coalesce(s.food_cost,0)::numeric(14,2),
    coalesce(s.food_contribution,0)::numeric(14,2),
    coalesce(s.net_cash_movement,0)::numeric(14,2)
  from terms t cross join currencies c
  left join lateral (
    select * from analytics_period_summary(t.starts_on,t.ends_on) x where x.currency=c.currency
  ) s on true
  order by t.sequence,c.currency;
$$;

create or replace function analytics_year_over_year(p_from date,p_to date)
returns table(
  metric_key text,
  metric_label text,
  unit text,
  currency text,
  current_value numeric(18,4),
  prior_value numeric(18,4),
  change_value numeric(18,4),
  change_percent numeric(9,2),
  current_from date,
  current_to date,
  prior_from date,
  prior_to date
)
language sql stable
as $$
  with matched_term as (
    select t.*,y.starts_on year_start
    from school_term t join school_year y on y.id=t.school_year_id
    where t.starts_on=p_from and t.ends_on=p_to
    order by y.starts_on desc limit 1
  ), matched_year as (
    select y.* from school_year y where y.starts_on=p_from and y.ends_on=p_to limit 1
  ), ranges as (
    select p_from current_from,p_to current_to,
      coalesce(
        (
          select pt.starts_on
          from matched_term ct
          join school_year py on py.starts_on<ct.year_start
          join school_term pt on pt.school_year_id=py.id and pt.sequence=ct.sequence
          order by py.starts_on desc limit 1
        ),
        (
          select py.starts_on
          from matched_year cy join school_year py on py.starts_on<cy.starts_on
          order by py.starts_on desc limit 1
        ),
        (p_from-interval '1 year')::date
      ) prior_from,
      coalesce(
        (
          select pt.ends_on
          from matched_term ct
          join school_year py on py.starts_on<ct.year_start
          join school_term pt on pt.school_year_id=py.id and pt.sequence=ct.sequence
          order by py.starts_on desc limit 1
        ),
        (
          select py.ends_on
          from matched_year cy join school_year py on py.starts_on<cy.starts_on
          order by py.starts_on desc limit 1
        ),
        (p_to-interval '1 year')::date
      ) prior_to
  ), current_summary as (
    select s.* from ranges r cross join lateral analytics_period_summary(r.current_from,r.current_to) s
  ), prior_summary as (
    select s.* from ranges r cross join lateral analytics_period_summary(r.prior_from,r.prior_to) s
  ), currencies as (
    select currency from current_summary union select currency from prior_summary
  ), financial as (
    select v.metric_key,v.metric_label,v.unit,c.currency,v.current_value,v.prior_value
    from currencies c
    left join current_summary cs using(currency)
    left join prior_summary ps using(currency)
    cross join lateral (values
      ('income','Income','money',cs.income::numeric,ps.income::numeric),
      ('expenses','Expenses','money',cs.expenses::numeric,ps.expenses::numeric),
      ('expected_fees','Expected fees','money',cs.expected_fees::numeric,ps.expected_fees::numeric),
      ('collected_fees','Collected fees','money',cs.collected_fees::numeric,ps.collected_fees::numeric),
      ('collection_rate','Fee collection rate','percent',cs.collection_rate::numeric,ps.collection_rate::numeric),
      ('payroll_expense','Payroll expense','money',cs.payroll_expense::numeric,ps.payroll_expense::numeric),
      ('rent_expense','Rent expense','money',cs.rent_expense::numeric,ps.rent_expense::numeric),
      ('food_revenue','Food revenue','money',cs.food_revenue::numeric,ps.food_revenue::numeric),
      ('food_cost','Food cost','money',cs.food_cost::numeric,ps.food_cost::numeric),
      ('food_contribution','Food contribution','money',cs.food_contribution::numeric,ps.food_contribution::numeric),
      ('net_cash_movement','Net cash movement','money',cs.net_cash_movement::numeric,ps.net_cash_movement::numeric)
    ) v(metric_key,metric_label,unit,current_value,prior_value)
  ), all_metrics as (
    select * from financial
    union all
    select 'active_students','Active students','count',null::text,
      report_active_student_count(r.current_to)::numeric,
      report_active_student_count(r.prior_to)::numeric
    from ranges r
  )
  select a.metric_key,a.metric_label,a.unit,a.currency,
    a.current_value::numeric(18,4),a.prior_value::numeric(18,4),
    case when a.current_value is null or a.prior_value is null then null
      else (a.current_value-a.prior_value)::numeric(18,4)
    end,
    case when a.current_value is null or a.prior_value is null or a.prior_value=0 then null
      else round((a.current_value-a.prior_value)*100.0/a.prior_value,2)::numeric(9,2)
    end,
    r.current_from,r.current_to,r.prior_from,r.prior_to
  from all_metrics a cross join ranges r
  order by case when a.currency is null then 0 else 1 end,a.currency,a.metric_key;
$$;

insert into permission(key,description)
values ('analytics.view','View advanced dashboard analytics and aggregate trend comparisons')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,'analytics.view'
from role r
where lower(r.name)='administrator'
on conflict do nothing;
