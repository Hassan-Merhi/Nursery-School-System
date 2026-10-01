create or replace function lock_payroll_run(p_run_id uuid,p_user_id uuid default null)
returns uuid
language plpgsql
as $$
declare
  v payroll_run%rowtype; v_item payroll_run_item%rowtype; v_sched record;
  v_allow numeric(14,2); v_bonus numeric(14,2); v_deduct numeric(14,2); v_gross numeric(14,2); v_expense numeric(14,2);
  v_available numeric(14,2); v_repay numeric(14,2); v_take numeric(14,2); v_out numeric(14,2);
  v_total_gross numeric(14,2):=0; v_total_deduct numeric(14,2):=0; v_total_repay numeric(14,2):=0; v_total_net numeric(14,2):=0;
  v_entry uuid; v_line integer:=1; v_expense_account uuid; v_payable_account uuid; v_advance_account uuid;
begin
  select * into v from payroll_run where id=p_run_id for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if v.status<>'approved' then raise exception 'Payroll run must be approved before locking'; end if;
  if not exists(select 1 from accounting_period where status='open' and v.pay_date between starts_on and ends_on) then raise exception 'Payroll pay date is not inside an open accounting period'; end if;
  if exists(select 1 from journal_entry where source_type='payroll_run' and source_id=v.id) then raise exception 'Payroll run already has an accounting entry'; end if;

  v_expense_account := accounting_mapped_account('payroll_expense');
  v_payable_account := accounting_mapped_account('salary_payable');
  v_advance_account := accounting_mapped_account('salary_advance');

  for v_item in select * from payroll_run_item where payroll_run_id=v.id order by employee_id for update loop
    select
      coalesce(sum(amount) filter(where adjustment_type='allowance'),0)::numeric(14,2),
      coalesce(sum(amount) filter(where adjustment_type='bonus'),0)::numeric(14,2),
      coalesce(sum(amount) filter(where adjustment_type='deduction'),0)::numeric(14,2)
    into v_allow,v_bonus,v_deduct
    from payroll_adjustment where payroll_run_item_id=v_item.id;

    v_gross := v_item.base_salary+v_allow+v_bonus;
    if v_deduct>v_gross then raise exception 'Payroll deductions exceed gross pay for employee %',v_item.employee_id; end if;
    v_expense := v_gross-v_deduct;
    v_available := v_expense;
    v_repay := 0;

    for v_sched in
      select s.id,s.amount,
        coalesce((select sum(a.amount) from salary_advance_repayment_allocation a where a.repayment_schedule_id=s.id),0)::numeric(14,2) as already
      from salary_advance_repayment_schedule s
      join salary_advance a on a.id=s.salary_advance_id
      where a.employee_id=v_item.employee_id and a.status in ('posted','repaid') and s.due_on<=v.period_end
      order by s.due_on,s.installment_number,s.id
    loop
      v_out := v_sched.amount-v_sched.already;
      if v_out>0 and v_available>0 then
        v_take := least(v_out,v_available);
        insert into salary_advance_repayment_allocation(repayment_schedule_id,payroll_run_item_id,amount,created_by)
        values(v_sched.id,v_item.id,v_take,p_user_id);
        v_repay := v_repay+v_take;
        v_available := v_available-v_take;
      end if;
    end loop;

    update payroll_run_item set
      allowance_total=v_allow,bonus_total=v_bonus,deduction_total=v_deduct,
      advance_repayment_total=v_repay,gross_pay=v_gross,payroll_expense=v_expense,net_pay=v_expense-v_repay
    where id=v_item.id;

    update salary_advance a set status=case when not exists(
      select 1 from salary_advance_repayment_schedule s
      where s.salary_advance_id=a.id
        and s.amount>coalesce((select sum(x.amount) from salary_advance_repayment_allocation x where x.repayment_schedule_id=s.id),0)
    ) then 'repaid' else 'posted' end
    where a.employee_id=v_item.employee_id and a.status in ('posted','repaid');

    v_total_gross:=v_total_gross+v_gross;
    v_total_deduct:=v_total_deduct+v_deduct;
    v_total_repay:=v_total_repay+v_repay;
    v_total_net:=v_total_net+(v_expense-v_repay);
  end loop;

  if v_total_gross<=0 then raise exception 'Payroll run has no gross payroll'; end if;
  if v_total_net<0 then raise exception 'Payroll net pay cannot be negative'; end if;

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values(payroll_journal(),'system',v.pay_date,v.currency,'Payroll run '||v.run_number,v.run_number,'payroll_run',v.id,p_user_id)
  returning id into v_entry;

  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values(v_entry,v_line,v_expense_account,'Gross salary, allowances and bonuses',v_total_gross,0,p_user_id);
  v_line:=v_line+1;
  if v_total_deduct>0 then
    insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
    values(v_entry,v_line,v_expense_account,'Payroll deductions',0,v_total_deduct,p_user_id);
    v_line:=v_line+1;
  end if;
  if v_total_repay>0 then
    insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
    values(v_entry,v_line,v_advance_account,'Salary advance repayments',0,v_total_repay,p_user_id);
    v_line:=v_line+1;
  end if;
  if v_total_net>0 then
    insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
    values(v_entry,v_line,v_payable_account,'Salary payable',0,v_total_net,p_user_id);
  end if;

  perform post_journal_entry(v_entry,p_user_id);
  update payroll_run set status='locked',locked_at=now(),locked_by=p_user_id,journal_entry_id=v_entry where id=v.id;
  return v_entry;
end;
$$;

create or replace function accounting_post_payroll_payment(p_payment_id uuid,p_user_id uuid default null)
returns uuid
language plpgsql
as $$
declare v payroll_payment%rowtype; v_run payroll_run%rowtype; v_existing uuid; v_entry uuid; v_payable uuid; v_due numeric(14,2);
begin
  select id into v_existing from journal_entry where source_type='payroll_payment' and source_id=p_payment_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from payroll_payment where id=p_payment_id for update;
  if not found or v.status<>'posted' then raise exception 'Only posted payroll payments can be posted to accounting'; end if;
  select * into v_run from payroll_run where id=v.payroll_run_id for update;
  if v_run.status<>'locked' then raise exception 'Only locked payroll runs can be paid'; end if;
  select coalesce(sum(net_pay),0)::numeric(14,2) into v_due from payroll_run_item where payroll_run_id=v_run.id;
  if v.amount<>v_due then raise exception 'Payroll payment must equal the locked net payroll amount %',v_due; end if;
  if v.currency<>v_run.currency then raise exception 'Payroll payment currency must match payroll run'; end if;
  v_payable:=accounting_mapped_account('salary_payable');
  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values(payroll_journal(),'system',v.paid_on,v.currency,'Payroll payment '||v.payment_number,v.payment_number,'payroll_payment',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by) values
    (v_entry,1,v_payable,'Clear salary payable',v.amount,0,p_user_id),
    (v_entry,2,v.payment_account_id,'Payroll paid',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  update payroll_payment set journal_entry_id=v_entry where id=v.id;
  update payroll_run set status='paid' where id=v_run.id;
  return v_entry;
end;
$$;

create or replace function reverse_payroll_payment(p_payment_id uuid,p_posting_date date,p_user_id uuid default null,p_reason text default 'Payroll payment reversal')
returns uuid
language plpgsql
as $$
declare v payroll_payment%rowtype; v_rev uuid;
begin
  select * into v from payroll_payment where id=p_payment_id for update;
  if not found or v.status<>'posted' then raise exception 'Only posted payroll payments can be reversed'; end if;
  if v.journal_entry_id is null then raise exception 'Payroll payment has no accounting entry'; end if;
  v_rev:=reverse_journal_entry(v.journal_entry_id,p_posting_date,p_user_id,p_reason);
  update payroll_payment set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason where id=v.id;
  update payroll_run set status='locked' where id=v.payroll_run_id;
  return v_rev;
end;
$$;
