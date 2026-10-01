
create or replace function generate_salary_advance_schedule(p_advance_id uuid,p_user_id uuid default null)
returns integer
language plpgsql
as $$
declare v salary_advance%rowtype; i integer; v_each numeric(14,2); v_amount numeric(14,2);
begin
  select * into v from salary_advance where id=p_advance_id for update;
  if not found then raise exception 'Salary advance not found'; end if;
  if exists(select 1 from salary_advance_repayment_schedule where salary_advance_id=v.id) then
    return (select count(*)::int from salary_advance_repayment_schedule where salary_advance_id=v.id);
  end if;
  v_each := round(v.amount / v.installments_count,2);
  for i in 1..v.installments_count loop
    v_amount := case when i=v.installments_count then v.amount - v_each*(v.installments_count-1) else v_each end;
    if v_amount<=0 then raise exception 'Advance installment amount must remain positive'; end if;
    insert into salary_advance_repayment_schedule(salary_advance_id,installment_number,due_on,amount,created_by)
    values(v.id,i,monthly_due_date(v.first_repayment_on,i-1),v_amount,p_user_id);
  end loop;
  return v.installments_count;
end;
$$;

create or replace function accounting_post_salary_advance(p_advance_id uuid,p_user_id uuid default null)
returns uuid
language plpgsql
as $$
declare v salary_advance%rowtype; v_existing uuid; v_entry uuid; v_asset uuid;
begin
  select id into v_existing from journal_entry where source_type='salary_advance' and source_id=p_advance_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from salary_advance where id=p_advance_id for update;
  if not found or v.status<>'posted' then raise exception 'Only posted salary advances can be posted to accounting'; end if;
  v_asset := accounting_mapped_account('salary_advance');
  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values(payroll_journal(),'system',v.advance_date,v.currency,'Salary advance '||v.advance_number,v.advance_number,'salary_advance',v.id,p_user_id)
  returning id into v_entry;
  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by) values
    (v_entry,1,v_asset,'Employee salary advance',v.amount,0,p_user_id),
    (v_entry,2,v.payment_account_id,'Salary advance paid',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  update salary_advance set journal_entry_id=v_entry where id=v.id;
  return v_entry;
end;
$$;

create or replace function reverse_salary_advance(p_advance_id uuid,p_posting_date date,p_user_id uuid default null,p_reason text default 'Salary advance reversal')
returns uuid
language plpgsql
as $$
declare v salary_advance%rowtype; v_rev uuid;
begin
  select * into v from salary_advance where id=p_advance_id for update;
  if not found or v.status not in ('posted','repaid') then raise exception 'Only active salary advances can be reversed'; end if;
  if exists(
    select 1 from salary_advance_repayment_allocation a
    join salary_advance_repayment_schedule s on s.id=a.repayment_schedule_id
    where s.salary_advance_id=v.id
  ) then raise exception 'Salary advances with payroll repayments cannot be reversed'; end if;
  if v.journal_entry_id is null then raise exception 'Salary advance has no accounting entry'; end if;
  v_rev := reverse_journal_entry(v.journal_entry_id,p_posting_date,p_user_id,p_reason);
  update salary_advance set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason where id=v.id;
  return v_rev;
end;
$$;

create or replace function populate_payroll_run(p_run_id uuid,p_user_id uuid default null)
returns integer
language plpgsql
as $$
declare v payroll_run%rowtype; v_missing integer; v_count integer;
begin
  select * into v from payroll_run where id=p_run_id for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if v.status<>'draft' then raise exception 'Only draft payroll runs can be populated'; end if;
  if exists(select 1 from payroll_run_item where payroll_run_id=v.id) then
    raise exception 'Payroll run is already populated';
  end if;

  select count(*)::int into v_missing
  from employee e
  where e.start_on<=v.period_end
    and (e.end_on is null or e.end_on>=v.period_start)
    and e.status<>'inactive'
    and not exists(
      select 1 from employee_salary_agreement s
      where s.employee_id=e.id and s.effective_from<=least(v.period_end,coalesce(e.end_on,v.period_end))
    );
  if v_missing>0 then raise exception '% payroll-eligible employee(s) do not have an effective salary agreement',v_missing; end if;

  insert into payroll_run_item(payroll_run_id,employee_id,salary_agreement_id,base_salary,created_by)
  select v.id,e.id,s.id,s.monthly_salary,p_user_id
  from employee e
  join lateral (
    select s1.* from employee_salary_agreement s1
    where s1.employee_id=e.id
      and s1.effective_from<=least(v.period_end,coalesce(e.end_on,v.period_end))
    order by s1.effective_from desc limit 1
  ) s on true
  where e.start_on<=v.period_end
    and (e.end_on is null or e.end_on>=v.period_start)
    and e.status<>'inactive'
    and s.currency=v.currency;

  get diagnostics v_count=row_count;
  if v_count=0 then raise exception 'No payroll-eligible employees found for this run and currency'; end if;
  return v_count;
end;
$$;
