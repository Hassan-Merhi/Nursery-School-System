
create view salary_advance_balance as
select
  a.id,a.advance_number,a.employee_id,a.advance_date,a.amount,a.currency,a.status,a.first_repayment_on,a.installments_count,
  coalesce((select sum(x.amount) from salary_advance_repayment_allocation x join salary_advance_repayment_schedule s on s.id=x.repayment_schedule_id where s.salary_advance_id=a.id),0)::numeric(14,2) as repaid_amount,
  case when a.status='reversed' then 0::numeric else
    (a.amount-coalesce((select sum(x.amount) from salary_advance_repayment_allocation x join salary_advance_repayment_schedule s on s.id=x.repayment_schedule_id where s.salary_advance_id=a.id),0))::numeric(14,2)
  end as outstanding_amount
from salary_advance a;

create view payroll_run_summary as
select r.id,r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status,r.journal_entry_id,
  count(i.id)::int as employee_count,
  coalesce(sum(i.base_salary),0)::numeric(14,2) as base_salary,
  coalesce(sum(i.allowance_total),0)::numeric(14,2) as allowances,
  coalesce(sum(i.bonus_total),0)::numeric(14,2) as bonuses,
  coalesce(sum(i.deduction_total),0)::numeric(14,2) as deductions,
  coalesce(sum(i.advance_repayment_total),0)::numeric(14,2) as advance_repayments,
  coalesce(sum(i.payroll_expense),0)::numeric(14,2) as payroll_expense,
  coalesce(sum(i.net_pay),0)::numeric(14,2) as net_pay
from payroll_run r left join payroll_run_item i on i.payroll_run_id=r.id
group by r.id;

create view employee_payroll_ledger as
select
  ('advance:'||a.id::text) as ledger_key,a.employee_id,a.advance_date as event_date,'salary_advance'::text as event_type,
  a.advance_number as reference,'Salary advance issued'::text as description,
  0::numeric(14,2) as gross_earnings,0::numeric(14,2) as deductions,
  case when a.status='reversed' then 0::numeric else a.amount end as advance_increase,
  0::numeric(14,2) as advance_repayment,0::numeric(14,2) as salary_payable,0::numeric(14,2) as salary_paid,a.currency
from salary_advance a
union all
select
  ('payroll:'||i.id::text),i.employee_id,r.pay_date,'payroll_locked',r.run_number,'Payroll locked',
  i.gross_pay,i.deduction_total,0::numeric(14,2),i.advance_repayment_total,i.net_pay,0::numeric(14,2),r.currency
from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id where r.status in ('locked','paid')
union all
select
  ('payment:'||i.id::text),i.employee_id,p.paid_on,'payroll_paid',p.payment_number,'Payroll paid',
  0::numeric(14,2),0::numeric(14,2),0::numeric(14,2),0::numeric(14,2),0::numeric(14,2),i.net_pay,p.currency
from payroll_run_item i join payroll_run r on r.id=i.payroll_run_id
join payroll_payment p on p.payroll_run_id=r.id and p.status='posted';

insert into permission(key,description) values
  ('employees.view','View employees, job titles and salary history'),
  ('employees.manage','Create and maintain employees, job titles and salary agreements'),
  ('payroll.view','View payroll runs, payslips, reports and employee payroll ledgers'),
  ('payroll.manage','Create payroll runs and draft allowances, bonuses and deductions'),
  ('payroll.approve','Submit and approve payroll runs'),
  ('payroll.lock','Lock approved payroll and post payroll expense, advance repayment and salary payable accounting'),
  ('payroll.pay','Pay locked payroll and reverse payroll payments'),
  ('salary_advances.manage','Issue and reverse salary advances and repayment schedules')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;
