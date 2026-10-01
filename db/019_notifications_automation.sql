-- Step 12 — Notifications & Automation
-- Notifications are derived from authoritative workflow data. They never maintain
-- duplicate balances or due amounts.

insert into permission(key, description) values
  ('notifications.view', 'View notifications and automation status'),
  ('notifications.manage', 'Acknowledge, dismiss, snooze, and configure notifications'),
  ('notifications.run', 'Run the notification refresh engine')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id, permission_key)
select r.id, p.key
from role r
join permission p on p.key in ('notifications.view','notifications.manage','notifications.run')
where lower(r.name)='administrator'
on conflict do nothing;

create table if not exists notification_rule (
  rule_key text primary key,
  label text not null,
  category text not null check (category in ('fees','rentals','suppliers','payroll','academic','inventory','contracts','employees')),
  enabled boolean not null default true,
  lead_days integer not null default 7 check (lead_days between 0 and 365),
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);

insert into notification_rule(rule_key,label,category,lead_days,severity,description) values
  ('fee_due','Fee due notice','fees',7,'warning','Open student fee invoices approaching their due date.'),
  ('fee_overdue','Outstanding fee alert','fees',0,'critical','Open student fee invoices past their due date.'),
  ('rent_due','Rent due','rentals',7,'warning','Outstanding rent schedule periods that are due or approaching due.'),
  ('supplier_payment_due','Supplier payment due','suppliers',7,'warning','Posted supplier invoices with an outstanding balance that are due or approaching due.'),
  ('payroll_reminder','Payroll reminder','payroll',3,'warning','Unpaid payroll runs whose pay date is approaching or has passed.'),
  ('term_start','Term-start reminder','academic',14,'info','Upcoming school-term start dates.'),
  ('low_food_inventory','Low food inventory','inventory',0,'warning','Food inventory items at or below their reorder threshold.'),
  ('contract_expiry','Contract expiry','contracts',30,'warning','Active rental contracts approaching their end date.'),
  ('employee_document_expiry','Employee document expiry','employees',30,'warning','Employee documents approaching or past their expiry date.')
on conflict (rule_key) do update
set label=excluded.label,
    category=excluded.category,
    description=excluded.description;

create table if not exists employee_document_expiry (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employee(id) on delete restrict,
  document_name text not null,
  document_number text,
  expires_on date not null,
  notes text,
  status text not null default 'active' check (status in ('active','renewed','cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  unique (employee_id, document_name, expires_on)
);
create index if not exists employee_document_expiry_due_idx
  on employee_document_expiry(status, expires_on);

create table if not exists system_notification (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null references notification_rule(rule_key) on delete restrict,
  source_type text not null,
  source_id uuid not null,
  occurrence_key text not null,
  due_on date,
  severity text not null check (severity in ('info','warning','critical')),
  title text not null,
  message text not null,
  family_id uuid references family(id) on delete restrict,
  employee_id uuid references employee(id) on delete restrict,
  recipient_email text,
  status text not null default 'open'
    check (status in ('open','snoozed','acknowledged','dismissed','resolved')),
  snoozed_until date,
  acknowledged_at timestamptz,
  acknowledged_by uuid references app_user(id) on delete set null,
  dismissed_at timestamptz,
  dismissed_by uuid references app_user(id) on delete set null,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  first_detected_on date not null default current_date,
  last_detected_on date not null default current_date,
  last_refresh_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_key, source_type, source_id, occurrence_key),
  check ((status='snoozed' and snoozed_until is not null) or status<>'snoozed')
);
create index if not exists system_notification_status_due_idx
  on system_notification(status, due_on, severity);
create index if not exists system_notification_rule_idx
  on system_notification(rule_key, last_detected_on desc);

create or replace function refresh_system_notifications(
  p_as_of date default current_date,
  p_user_id uuid default null
)
returns table(open_count integer, newly_detected integer, resolved_count integer)
language plpgsql
as $$
declare
  v_before integer;
  v_resolved integer := 0;
  v_run_id uuid := gen_random_uuid();
begin
  if p_as_of is null then
    raise exception 'Notification refresh date is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('refresh_system_notifications'));

  select count(*) into v_before from system_notification;

  update system_notification
  set status='open', snoozed_until=null, updated_at=now()
  where status='snoozed' and snoozed_until<=p_as_of;

  -- Fee invoices approaching due date.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    family_id,recipient_email,metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'invoice',i.id,i.due_on::text,i.due_on,r.severity,
    'Fee due: '||i.invoice_number,
    'Invoice '||i.invoice_number||' has '||b.balance_amount::text||' '||i.currency||
      ' outstanding and is due on '||i.due_on::text||'.',
    i.family_id,
    pg.email,
    jsonb_build_object('invoice_number',i.invoice_number,'balance',b.balance_amount,'currency',i.currency,'student_id',i.student_id),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join invoice_balance b on true
  join invoice i on i.id=b.id
  left join lateral (
    select g.email
    from family_guardian fg
    join guardian g on g.id=fg.guardian_id
    where fg.family_id=i.family_id and g.email is not null
    order by fg.is_primary desc, fg.created_at
    limit 1
  ) pg on true
  where r.rule_key='fee_due' and r.enabled
    and b.balance_amount>0
    and i.status in ('issued','partially_paid')
    and i.due_on between p_as_of and (p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      family_id=excluded.family_id,recipient_email=excluded.recipient_email,metadata=excluded.metadata,
      last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Outstanding fee invoices past due.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    family_id,recipient_email,metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'invoice',i.id,i.due_on::text,i.due_on,r.severity,
    'Outstanding fee: '||i.invoice_number,
    'Invoice '||i.invoice_number||' is overdue with '||b.balance_amount::text||' '||i.currency||' outstanding.',
    i.family_id,
    pg.email,
    jsonb_build_object('invoice_number',i.invoice_number,'balance',b.balance_amount,'currency',i.currency,'student_id',i.student_id),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join invoice_balance b on true
  join invoice i on i.id=b.id
  left join lateral (
    select g.email
    from family_guardian fg
    join guardian g on g.id=fg.guardian_id
    where fg.family_id=i.family_id and g.email is not null
    order by fg.is_primary desc, fg.created_at
    limit 1
  ) pg on true
  where r.rule_key='fee_overdue' and r.enabled
    and b.balance_amount>0
    and i.status in ('issued','partially_paid')
    and i.due_on<p_as_of
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      family_id=excluded.family_id,recipient_email=excluded.recipient_email,metadata=excluded.metadata,
      last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Rent schedule periods due soon or overdue.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'rent_schedule',b.id,b.due_on::text,b.due_on,r.severity,
    'Rent due: '||a.agreement_number,
    a.property_name||' has '||b.outstanding_amount::text||' '||b.currency||
      ' outstanding for the period due '||b.due_on::text||'.',
    jsonb_build_object('agreement_id',a.id,'agreement_number',a.agreement_number,'property_name',a.property_name,'balance',b.outstanding_amount,'currency',b.currency),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join rent_schedule_balance b on true
  join rental_agreement a on a.id=b.rental_agreement_id
  where r.rule_key='rent_due' and r.enabled
    and a.status='active'
    and b.outstanding_amount>0
    and b.due_on<=(p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Supplier invoices due soon or overdue.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'supplier_invoice',b.id,b.due_on::text,b.due_on,r.severity,
    'Supplier payment due: '||b.supplier_invoice_number,
    s.name||' is owed '||b.balance_amount::text||' '||b.currency||' due '||b.due_on::text||'.',
    jsonb_build_object('supplier_id',s.id,'supplier_name',s.name,'invoice_number',b.supplier_invoice_number,'balance',b.balance_amount,'currency',b.currency),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join supplier_invoice_balance b on true
  join supplier s on s.id=b.supplier_id
  where r.rule_key='supplier_payment_due' and r.enabled
    and b.balance_amount>0
    and b.status in ('posted','partially_paid')
    and b.due_on<=(p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Payroll runs due soon or overdue.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'payroll_run',p.id,p.pay_date::text,p.pay_date,r.severity,
    'Payroll reminder: '||p.run_number,
    'Payroll '||p.run_number||' is scheduled for '||p.pay_date::text||' and is currently '||p.status||'.',
    jsonb_build_object('run_number',p.run_number,'status',p.status,'currency',p.currency),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join payroll_run p on true
  where r.rule_key='payroll_reminder' and r.enabled
    and p.status<>'paid'
    and p.pay_date<=(p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Upcoming term starts.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'school_term',t.id,t.starts_on::text,t.starts_on,r.severity,
    'Term starts: '||t.name,
    y.name||' · '||t.name||' starts on '||t.starts_on::text||'.',
    jsonb_build_object('school_year_id',y.id,'school_year',y.name,'term',t.name),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join school_term t on true
  join school_year y on y.id=t.school_year_id
  where r.rule_key='term_start' and r.enabled
    and y.status in ('planned','current')
    and t.starts_on between p_as_of and (p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Active rental agreements approaching expiry.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'rental_agreement',a.id,a.end_on::text,a.end_on,r.severity,
    'Contract expiry: '||a.agreement_number,
    a.property_name||' rental agreement ends on '||a.end_on::text||'.',
    jsonb_build_object('agreement_number',a.agreement_number,'property_name',a.property_name,'landlord_id',a.landlord_id),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join rental_agreement a on true
  where r.rule_key='contract_expiry' and r.enabled
    and a.status='active'
    and a.end_on between p_as_of and (p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Employee document expiries.
  insert into system_notification(
    rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
    employee_id,metadata,first_detected_on,last_detected_on,last_refresh_run_id
  )
  select
    r.rule_key,'employee_document_expiry',d.id,d.expires_on::text,d.expires_on,r.severity,
    'Employee document expiry: '||d.document_name,
    e.first_name||' '||e.last_name||' · '||d.document_name||' expires on '||d.expires_on::text||'.',
    e.id,
    jsonb_build_object('employee_number',e.employee_number,'employee_name',e.first_name||' '||e.last_name,'document_name',d.document_name,'document_number',d.document_number),
    p_as_of,p_as_of,v_run_id
  from notification_rule r
  join employee_document_expiry d on true
  join employee e on e.id=d.employee_id
  where r.rule_key='employee_document_expiry' and r.enabled
    and d.status='active'
    and e.status<>'terminated'
    and d.expires_on<=(p_as_of+r.lead_days)
  on conflict (rule_key,source_type,source_id,occurrence_key) do update
  set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
      employee_id=excluded.employee_id,metadata=excluded.metadata,last_detected_on=p_as_of,last_refresh_run_id=v_run_id,updated_at=now(),
      status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
      resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end;

  -- Step 11 inventory integration contract:
  -- if a view named inventory_low_stock_notification_source exists, it must expose
  -- source_id uuid, item_name text, current_quantity numeric, reorder_level numeric, unit_name text.
  if to_regclass('public.inventory_low_stock_notification_source') is not null then
    execute $inventory$
      insert into system_notification(
        rule_key,source_type,source_id,occurrence_key,due_on,severity,title,message,
        metadata,first_detected_on,last_detected_on,last_refresh_run_id
      )
      select
        r.rule_key,'food_inventory',s.source_id,s.source_id::text,$1,r.severity,
        'Low food inventory: '||s.item_name,
        s.item_name||' is at '||s.current_quantity::text||' '||coalesce(s.unit_name,'')||
          '; reorder level is '||s.reorder_level::text||'.',
        jsonb_build_object('item_name',s.item_name,'current_quantity',s.current_quantity,'reorder_level',s.reorder_level,'unit_name',s.unit_name),
        $1,$1,$2
      from notification_rule r
      join inventory_low_stock_notification_source s on true
      where r.rule_key='low_food_inventory' and r.enabled
        and s.current_quantity<=s.reorder_level
      on conflict (rule_key,source_type,source_id,occurrence_key) do update
      set due_on=excluded.due_on,severity=excluded.severity,title=excluded.title,message=excluded.message,
          metadata=excluded.metadata,last_detected_on=$1,last_refresh_run_id=$2,updated_at=now(),
          status=case when system_notification.status='resolved' then 'open' else system_notification.status end,
          resolved_at=case when system_notification.status='resolved' then null else system_notification.resolved_at end
    $inventory$ using p_as_of,v_run_id;
  end if;

  update system_notification n
  set status='resolved', resolved_at=now(), updated_at=now(), snoozed_until=null
  from notification_rule r
  where r.rule_key=n.rule_key
    and n.status in ('open','snoozed','acknowledged')
    and (not r.enabled or n.last_refresh_run_id is distinct from v_run_id);
  get diagnostics v_resolved = row_count;

  return query
  select
    count(*) filter (where status in ('open','snoozed'))::integer,
    greatest(count(*)::integer-v_before,0),
    v_resolved
  from system_notification;
end;
$$;

comment on function refresh_system_notifications(date,uuid) is
  'Idempotently refreshes Step 12 notifications from authoritative source ledgers and schedules.';

create or replace view active_system_notification as
select
  n.*,
  r.label as rule_label,
  r.category,
  r.lead_days,
  r.enabled as rule_enabled
from system_notification n
join notification_rule r on r.rule_key=n.rule_key
where n.status in ('open','snoozed');

