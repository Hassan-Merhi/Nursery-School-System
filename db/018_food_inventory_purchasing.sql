-- Step 11 — Food Inventory & Purchasing
-- Simple, school-appropriate inventory: base units, purchase orders, stock receipts,
-- moving-average valuation, low-stock alerts, manual usage/waste adjustments,
-- supplier payables, accounting integration, and management summaries.

insert into document_sequence(document_type,prefix)
values
  ('food_purchase_order','FPO'),
  ('inventory_receipt','FRC'),
  ('inventory_adjustment','FADJ')
on conflict (document_type) do nothing;

create table inventory_unit (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  decimal_places smallint not null default 3 check (decimal_places between 0 and 6),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into inventory_unit(code,name,decimal_places) values
  ('UNIT','Unit',0),
  ('KG','Kilogram',3),
  ('G','Gram',0),
  ('L','Litre',3),
  ('ML','Millilitre',0),
  ('PACK','Pack',0),
  ('BOX','Box',0)
on conflict (code) do nothing;

create table ingredient (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit_id uuid not null references inventory_unit(id) on delete restrict,
  reorder_level numeric(14,3) not null default 0 check (reorder_level>=0),
  notes text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null
);
create index ingredient_name_idx on ingredient(lower(name),status);

create table food_purchase_order (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  supplier_id uuid not null references supplier(id) on delete restrict,
  ordered_on date not null,
  expected_on date,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft'
    check (status in ('draft','ordered','partially_received','received','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  ordered_at timestamptz,
  ordered_by uuid references app_user(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references app_user(id) on delete set null,
  cancellation_reason text,
  check (expected_on is null or expected_on>=ordered_on),
  check (
    (status='cancelled' and cancelled_at is not null and cancellation_reason is not null)
    or (status<>'cancelled' and cancelled_at is null)
  )
);
create index food_purchase_order_supplier_idx on food_purchase_order(supplier_id,ordered_on desc);
create index food_purchase_order_status_idx on food_purchase_order(status,expected_on);

create table food_purchase_order_line (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references food_purchase_order(id) on delete restrict,
  ingredient_id uuid not null references ingredient(id) on delete restrict,
  quantity_ordered numeric(14,3) not null check (quantity_ordered>0),
  unit_cost numeric(14,4) not null check (unit_cost>=0),
  line_amount numeric(14,2) generated always as (round(quantity_ordered*unit_cost,2)) stored,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (purchase_order_id,ingredient_id)
);
create index food_purchase_order_line_ingredient_idx on food_purchase_order_line(ingredient_id);

create or replace function protect_food_purchase_order_line()
returns trigger language plpgsql as $$
declare
  v_order_id uuid;
  v_status text;
begin
  v_order_id := case when tg_op='DELETE' then old.purchase_order_id else new.purchase_order_id end;
  select status into v_status from food_purchase_order where id=v_order_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'Only draft purchase orders can change their lines';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger food_purchase_order_line_draft_only
before insert or update or delete on food_purchase_order_line
for each row execute function protect_food_purchase_order_line();

create or replace function validate_food_purchase_order()
returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and old.status<>'draft' and (
    new.supplier_id is distinct from old.supplier_id
    or new.ordered_on is distinct from old.ordered_on
    or new.currency is distinct from old.currency
  ) then
    raise exception 'Ordered purchase order supplier, date and currency are immutable';
  end if;
  if new.status='ordered' and (tg_op='INSERT' or old.status is distinct from 'ordered') then
    if not exists (select 1 from food_purchase_order_line where purchase_order_id=new.id) then
      raise exception 'Purchase order requires at least one line before ordering';
    end if;
    new.ordered_at := coalesce(new.ordered_at,now());
  end if;
  return new;
end;
$$;

create trigger food_purchase_order_validate
before insert or update on food_purchase_order
for each row execute function validate_food_purchase_order();

create table inventory_receipt (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  supplier_id uuid not null references supplier(id) on delete restrict,
  purchase_order_id uuid references food_purchase_order(id) on delete restrict,
  supplier_reference text,
  received_on date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references app_user(id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references app_user(id) on delete set null,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  check (
    (status='draft' and posted_at is null and reversed_at is null)
    or (status='posted' and posted_at is not null and reversed_at is null)
    or (status='reversed' and posted_at is not null and reversed_at is not null and reversal_reason is not null)
  )
);
create index inventory_receipt_supplier_idx on inventory_receipt(supplier_id,received_on desc);
create index inventory_receipt_order_idx on inventory_receipt(purchase_order_id,status);

create or replace function validate_inventory_receipt_scope()
returns trigger language plpgsql as $$
declare
  v_supplier uuid;
  v_currency text;
  v_status text;
  v_ordered_on date;
begin
  if tg_op='UPDATE' and old.status<>'draft' and (
    new.supplier_id is distinct from old.supplier_id
    or new.purchase_order_id is distinct from old.purchase_order_id
    or new.received_on is distinct from old.received_on
    or new.currency is distinct from old.currency
    or new.supplier_reference is distinct from old.supplier_reference
  ) then
    raise exception 'Posted inventory receipt scope is immutable';
  end if;

  if new.purchase_order_id is not null and (tg_op='INSERT' or old.status='draft') then
    select supplier_id,currency,status,ordered_on into v_supplier,v_currency,v_status,v_ordered_on
    from food_purchase_order where id=new.purchase_order_id;
    if v_supplier is null then raise exception 'Purchase order not found'; end if;
    if v_status not in ('ordered','partially_received') then
      raise exception 'Inventory receipts require an ordered purchase order';
    end if;
    if new.supplier_id<>v_supplier then raise exception 'Receipt supplier must match the purchase order'; end if;
    if new.currency<>v_currency then raise exception 'Receipt currency must match the purchase order'; end if;
    if new.received_on<v_ordered_on then raise exception 'Receipt date cannot be before the purchase order date'; end if;
  end if;
  return new;
end;
$$;

create trigger inventory_receipt_scope_validate
before insert or update on inventory_receipt
for each row execute function validate_inventory_receipt_scope();

create table inventory_receipt_line (
  id uuid primary key default gen_random_uuid(),
  inventory_receipt_id uuid not null references inventory_receipt(id) on delete restrict,
  ingredient_id uuid not null references ingredient(id) on delete restrict,
  quantity_received numeric(14,3) not null check (quantity_received>0),
  unit_cost numeric(14,4) not null check (unit_cost>=0),
  line_amount numeric(14,2) generated always as (round(quantity_received*unit_cost,2)) stored,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  unique (inventory_receipt_id,ingredient_id)
);
create index inventory_receipt_line_ingredient_idx on inventory_receipt_line(ingredient_id);

create or replace function protect_inventory_receipt_line()
returns trigger language plpgsql as $$
declare
  v_receipt_id uuid;
  v_status text;
begin
  v_receipt_id := case when tg_op='DELETE' then old.inventory_receipt_id else new.inventory_receipt_id end;
  select status into v_status from inventory_receipt where id=v_receipt_id for update;
  if v_status is distinct from 'draft' then
    raise exception 'Only draft inventory receipts can change their lines';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger inventory_receipt_line_draft_only
before insert or update or delete on inventory_receipt_line
for each row execute function protect_inventory_receipt_line();

create table inventory_movement (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references ingredient(id) on delete restrict,
  occurred_on date not null,
  movement_kind text not null check (movement_kind in (
    'receipt','receipt_reversal','usage','waste','spoilage','correction_in','correction_out','adjustment_reversal'
  )),
  quantity_delta numeric(14,3) not null check (quantity_delta<>0),
  unit_cost numeric(14,4) not null check (unit_cost>=0),
  value_delta numeric(14,2) generated always as (round(quantity_delta*unit_cost,2)) stored,
  source_type text not null,
  source_id uuid not null,
  reference text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null
);
create index inventory_movement_ingredient_idx on inventory_movement(ingredient_id,occurred_on,created_at);
create index inventory_movement_source_idx on inventory_movement(source_type,source_id);

create or replace function prevent_inventory_movement_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Inventory movements are immutable; post a reversal instead';
end;
$$;

create trigger inventory_movement_immutable
before update or delete on inventory_movement
for each row execute function prevent_inventory_movement_mutation();

create table inventory_adjustment (
  id uuid primary key default gen_random_uuid(),
  adjustment_number text not null unique,
  ingredient_id uuid not null references ingredient(id) on delete restrict,
  adjustment_kind text not null check (adjustment_kind in ('usage','waste','spoilage','correction_in','correction_out')),
  quantity numeric(14,3) not null check (quantity>0),
  unit_cost_override numeric(14,4) check (unit_cost_override is null or unit_cost_override>=0),
  occurred_on date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null,
  notes text,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  unit_cost_snapshot numeric(14,4),
  total_value numeric(14,2),
  created_at timestamptz not null default now(),
  created_by uuid references app_user(id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references app_user(id) on delete set null,
  reversed_at timestamptz,
  reversed_by uuid references app_user(id) on delete set null,
  reversal_reason text,
  check (
    (status='draft' and posted_at is null and reversed_at is null)
    or (status='posted' and posted_at is not null and reversed_at is null and unit_cost_snapshot is not null and total_value is not null)
    or (status='reversed' and posted_at is not null and reversed_at is not null and reversal_reason is not null)
  )
);
create index inventory_adjustment_ingredient_idx on inventory_adjustment(ingredient_id,occurred_on desc);

create or replace function protect_posted_inventory_adjustment()
returns trigger language plpgsql as $$
begin
  if old.status<>'draft' and (
    new.ingredient_id is distinct from old.ingredient_id
    or new.adjustment_kind is distinct from old.adjustment_kind
    or new.quantity is distinct from old.quantity
    or new.unit_cost_override is distinct from old.unit_cost_override
    or new.occurred_on is distinct from old.occurred_on
    or new.currency is distinct from old.currency
    or new.reason is distinct from old.reason
    or new.notes is distinct from old.notes
    or new.unit_cost_snapshot is distinct from old.unit_cost_snapshot
    or new.total_value is distinct from old.total_value
    or new.posted_at is distinct from old.posted_at
    or new.posted_by is distinct from old.posted_by
  ) then
    raise exception 'Posted inventory adjustments are immutable; reverse them instead';
  end if;
  return new;
end;
$$;

create trigger inventory_adjustment_posted_immutable
before update on inventory_adjustment
for each row execute function protect_posted_inventory_adjustment();

create or replace view ingredient_inventory_balance as
select
  i.id as ingredient_id,
  i.code,
  i.name,
  i.unit_id,
  u.code as unit_code,
  u.name as unit_name,
  i.reorder_level,
  i.status,
  coalesce(sum(m.quantity_delta),0)::numeric(14,3) as quantity_on_hand,
  coalesce(sum(m.value_delta),0)::numeric(14,2) as inventory_value,
  case
    when coalesce(sum(m.quantity_delta),0)>0
      then round(coalesce(sum(m.value_delta),0)/sum(m.quantity_delta),4)
    else 0::numeric
  end::numeric(14,4) as average_unit_cost,
  (i.reorder_level>0 and coalesce(sum(m.quantity_delta),0)<=i.reorder_level) as low_stock
from ingredient i
join inventory_unit u on u.id=i.unit_id
left join inventory_movement m on m.ingredient_id=i.id
group by i.id,i.code,i.name,i.unit_id,u.code,u.name,i.reorder_level,i.status;

create or replace view low_stock_alert as
select * from ingredient_inventory_balance
where status='active' and reorder_level>0 and quantity_on_hand<=reorder_level;

create or replace view food_purchase_order_line_progress as
select
  l.id as purchase_order_line_id,
  l.purchase_order_id,
  l.ingredient_id,
  l.quantity_ordered,
  l.unit_cost,
  l.line_amount,
  coalesce(sum(case when r.status='posted' then rl.quantity_received else 0 end),0)::numeric(14,3) as quantity_received,
  greatest(l.quantity_ordered-coalesce(sum(case when r.status='posted' then rl.quantity_received else 0 end),0),0)::numeric(14,3) as quantity_outstanding
from food_purchase_order_line l
left join inventory_receipt r on r.purchase_order_id=l.purchase_order_id and r.status='posted'
left join inventory_receipt_line rl on rl.inventory_receipt_id=r.id and rl.ingredient_id=l.ingredient_id
group by l.id,l.purchase_order_id,l.ingredient_id,l.quantity_ordered,l.unit_cost,l.line_amount;

create or replace view food_purchase_order_summary as
select
  p.*,
  s.supplier_number,
  s.name as supplier_name,
  coalesce(x.line_count,0)::int as line_count,
  coalesce(x.order_total,0)::numeric(14,2) as order_total,
  coalesce(x.ordered_quantity,0)::numeric(14,3) as ordered_quantity,
  coalesce(y.received_quantity,0)::numeric(14,3) as received_quantity
from food_purchase_order p
join supplier s on s.id=p.supplier_id
left join (
  select purchase_order_id,count(*) as line_count,sum(line_amount) as order_total,sum(quantity_ordered) as ordered_quantity
  from food_purchase_order_line group by purchase_order_id
) x on x.purchase_order_id=p.id
left join (
  select l.purchase_order_id,sum(pr.quantity_received) as received_quantity
  from food_purchase_order_line l
  join food_purchase_order_line_progress pr on pr.purchase_order_line_id=l.id
  group by l.purchase_order_id
) y on y.purchase_order_id=p.id;

-- Link inventory receipts to the existing supplier payable workflow.
alter table supplier_invoice
  add column inventory_receipt_id uuid unique references inventory_receipt(id) on delete restrict;

create or replace view inventory_receipt_summary as
select
  r.*,
  s.supplier_number,
  s.name as supplier_name,
  p.order_number,
  coalesce(x.line_count,0)::int as line_count,
  coalesce(x.receipt_total,0)::numeric(14,2) as receipt_total,
  si.id as supplier_invoice_id,
  si.supplier_invoice_number,
  si.status as supplier_invoice_status
from inventory_receipt r
join supplier s on s.id=r.supplier_id
left join food_purchase_order p on p.id=r.purchase_order_id
left join (
  select inventory_receipt_id,count(*) as line_count,sum(line_amount) as receipt_total
  from inventory_receipt_line group by inventory_receipt_id
) x on x.inventory_receipt_id=r.id
left join supplier_invoice si on si.inventory_receipt_id=r.id;

create or replace function validate_supplier_invoice_account()
returns trigger language plpgsql as $$
declare
  v_currency text;
  v_category text;
  v_inventory_account uuid;
begin
  select a.currency,t.category into v_currency,v_category
  from account a join account_type t on t.id=a.account_type_id
  where a.id=new.expense_account_id and a.status='active' and a.allow_posting=true;

  if new.inventory_receipt_id is null then
    if v_category is distinct from 'expense' then
      raise exception 'Supplier invoice requires an active posting expense account';
    end if;
  else
    v_inventory_account := accounting_mapped_account('inventory_asset');
    if new.expense_account_id is distinct from v_inventory_account or v_category is distinct from 'asset' then
      raise exception 'Inventory-backed supplier invoice must use the mapped inventory asset account';
    end if;
  end if;

  if v_currency<>new.currency then
    raise exception 'Supplier invoice and posting account currencies must match';
  end if;
  return new;
end;
$$;

create or replace function protect_inventory_supplier_invoice_reversal()
returns trigger language plpgsql as $$
begin
  if old.inventory_receipt_id is not null
     and old.status is distinct from 'reversed'
     and new.status='reversed'
     and exists (select 1 from inventory_receipt where id=old.inventory_receipt_id and status='posted') then
    raise exception 'Reverse inventory-backed supplier invoices from the Inventory page';
  end if;
  return new;
end;
$$;

create trigger supplier_invoice_inventory_reversal_guard
before update of status on supplier_invoice
for each row execute function protect_inventory_supplier_invoice_reversal();

create or replace function prevent_inventory_supplier_credit()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from supplier_invoice
    where id=new.supplier_invoice_id and inventory_receipt_id is not null
  ) then
    raise exception 'Supplier credits for inventory receipts require a stock-return workflow and are not supported in Step 11';
  end if;
  return new;
end;
$$;

create trigger supplier_credit_inventory_guard
before insert or update of supplier_invoice_id on supplier_credit
for each row execute function prevent_inventory_supplier_credit();

insert into accounting_role_definition(role_key,name,description,required_category)
values
  ('inventory_asset','Food Inventory Asset','Asset account holding the moving value of ingredients on hand.','asset'),
  ('food_program_expense','Food Program Expense','Expense account charged when ingredients are used, wasted or spoiled.','expense')
on conflict (role_key) do update
set name=excluded.name,description=excluded.description,required_category=excluded.required_category;

create or replace function inventory_next_document_number(p_type text,p_user_id uuid default null)
returns text language plpgsql as $$
declare
  v_prefix text;
  v_number bigint;
begin
  update document_sequence
  set next_number=next_number+1,updated_at=now(),updated_by=p_user_id
  where document_type=p_type
  returning prefix,next_number-1 into v_prefix,v_number;
  if v_prefix is null then raise exception 'Document sequence % is not configured',p_type; end if;
  return v_prefix||'-'||lpad(v_number::text,6,'0');
end;
$$;

create or replace function refresh_food_purchase_order_status(p_order_id uuid)
returns void language plpgsql as $$
declare
  v_status text;
  v_total numeric;
  v_received numeric;
begin
  select status into v_status from food_purchase_order where id=p_order_id for update;
  if not found or v_status in ('draft','cancelled') then return; end if;

  select coalesce(sum(quantity_ordered),0),coalesce(sum(quantity_received),0)
  into v_total,v_received
  from food_purchase_order_line_progress
  where purchase_order_id=p_order_id;

  update food_purchase_order
  set status=case
      when v_total>0 and v_received>=v_total then 'received'
      when v_received>0 then 'partially_received'
      else 'ordered'
    end,
    updated_at=now()
  where id=p_order_id;
end;
$$;

create or replace function submit_food_purchase_order(p_order_id uuid,p_user_id uuid default null)
returns void language plpgsql as $$
declare
  v_status text;
begin
  select status into v_status from food_purchase_order where id=p_order_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if v_status<>'draft' then raise exception 'Only draft purchase orders can be ordered'; end if;
  if not exists (select 1 from food_purchase_order_line where purchase_order_id=p_order_id) then
    raise exception 'Purchase order requires at least one line';
  end if;
  update food_purchase_order
  set status='ordered',ordered_at=now(),ordered_by=p_user_id,updated_at=now(),updated_by=p_user_id
  where id=p_order_id;
end;
$$;

create or replace function cancel_food_purchase_order(p_order_id uuid,p_user_id uuid,p_reason text)
returns void language plpgsql as $$
declare
  v_status text;
begin
  if nullif(trim(p_reason),'') is null then raise exception 'Cancellation reason is required'; end if;
  select status into v_status from food_purchase_order where id=p_order_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if v_status in ('received','cancelled') then raise exception 'Received or cancelled purchase order cannot be cancelled'; end if;
  update food_purchase_order
  set status='cancelled',cancelled_at=now(),cancelled_by=p_user_id,cancellation_reason=p_reason,updated_at=now(),updated_by=p_user_id
  where id=p_order_id;
end;
$$;

create or replace function accounting_post_supplier_invoice(p_invoice_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v supplier_invoice%rowtype;
  v_existing uuid;
  v_entry uuid;
  v_ap uuid;
  v_description text;
begin
  select id into v_existing from journal_entry where source_type='supplier_invoice' and source_id=p_invoice_id;
  if v_existing is not null then return v_existing; end if;
  select * into v from supplier_invoice where id=p_invoice_id;
  if not found or v.status<>'approved' then raise exception 'Only approved supplier invoices can be posted'; end if;
  v_ap := accounting_mapped_account('accounts_payable');
  v_description := case when v.inventory_receipt_id is null then 'Supplier expense' else 'Food inventory receipt' end;

  insert into journal_entry(journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by)
  values (accounting_operations_journal(),'system',v.invoice_date,v.currency,'Supplier invoice '||v.supplier_invoice_number,
          coalesce(v.supplier_reference,v.supplier_invoice_number),'supplier_invoice',v.id,p_user_id)
  returning id into v_entry;

  insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
  values
    (v_entry,1,v.expense_account_id,v_description,v.amount,0,p_user_id),
    (v_entry,2,v_ap,'Accounts payable',0,v.amount,p_user_id);
  perform post_journal_entry(v_entry,p_user_id);
  update supplier_invoice set status='posted',posted_at=now(),updated_at=now(),updated_by=p_user_id where id=v.id;
  return v_entry;
end;
$$;

create or replace function post_inventory_receipt(p_receipt_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v_receipt inventory_receipt%rowtype;
  v_line inventory_receipt_line%rowtype;
  v_total numeric(14,2);
  v_inventory_account uuid;
  v_inventory_currency text;
  v_invoice_id uuid;
  v_invoice_number text;
  v_due_on date;
  v_ordered numeric;
  v_already_received numeric;
  v_this_received numeric;
begin
  select * into v_receipt from inventory_receipt where id=p_receipt_id for update;
  if not found then raise exception 'Inventory receipt not found'; end if;
  if v_receipt.status<>'draft' then raise exception 'Only draft inventory receipts can be posted'; end if;
  if not exists (select 1 from inventory_receipt_line where inventory_receipt_id=p_receipt_id) then
    raise exception 'Inventory receipt requires at least one line';
  end if;

  v_inventory_account := accounting_mapped_account('inventory_asset');
  perform accounting_mapped_account('accounts_payable');
  select currency into v_inventory_currency from account where id=v_inventory_account and status='active' and allow_posting=true;
  if v_inventory_currency is null or v_inventory_currency<>v_receipt.currency then
    raise exception 'Inventory receipt currency must match the mapped inventory asset account';
  end if;

  if not exists (
    select 1 from accounting_period
    where status='open' and v_receipt.received_on between starts_on and ends_on
  ) then
    raise exception 'Inventory receipt date is not inside an open accounting period';
  end if;

  if v_receipt.purchase_order_id is not null then
    for v_line in select * from inventory_receipt_line where inventory_receipt_id=p_receipt_id loop
      select quantity_ordered into v_ordered
      from food_purchase_order_line
      where purchase_order_id=v_receipt.purchase_order_id and ingredient_id=v_line.ingredient_id;
      if v_ordered is null then
        raise exception 'Receipt contains an ingredient that is not on the purchase order';
      end if;
      select coalesce(sum(rl.quantity_received),0) into v_already_received
      from inventory_receipt r
      join inventory_receipt_line rl on rl.inventory_receipt_id=r.id
      where r.purchase_order_id=v_receipt.purchase_order_id
        and r.status='posted'
        and rl.ingredient_id=v_line.ingredient_id;
      select coalesce(sum(quantity_received),0) into v_this_received
      from inventory_receipt_line
      where inventory_receipt_id=p_receipt_id and ingredient_id=v_line.ingredient_id;
      if v_already_received+v_this_received>v_ordered then
        raise exception 'Receipt quantity exceeds the outstanding purchase order quantity';
      end if;
    end loop;
  end if;

  select coalesce(sum(line_amount),0)::numeric(14,2) into v_total
  from inventory_receipt_line where inventory_receipt_id=p_receipt_id;
  if v_total<=0 then raise exception 'Inventory receipt total must be greater than zero'; end if;

  for v_line in select * from inventory_receipt_line where inventory_receipt_id=p_receipt_id loop
    insert into inventory_movement(
      ingredient_id,occurred_on,movement_kind,quantity_delta,unit_cost,source_type,source_id,reference,notes,created_by
    ) values (
      v_line.ingredient_id,v_receipt.received_on,'receipt',v_line.quantity_received,v_line.unit_cost,
      'inventory_receipt_line',v_line.id,v_receipt.receipt_number,v_receipt.notes,p_user_id
    );
  end loop;

  select v_receipt.received_on + s.payment_terms_days into v_due_on
  from supplier s where s.id=v_receipt.supplier_id;
  v_invoice_number := inventory_next_document_number('supplier_invoice',p_user_id);
  insert into supplier_invoice(
    supplier_invoice_number,supplier_id,supplier_reference,expense_account_id,amount,currency,
    invoice_date,due_on,notes,status,approved_at,approved_by,inventory_receipt_id,created_by,updated_by
  ) values (
    v_invoice_number,v_receipt.supplier_id,coalesce(v_receipt.supplier_reference,v_receipt.receipt_number),
    v_inventory_account,v_total,v_receipt.currency,v_receipt.received_on,v_due_on,
    coalesce(v_receipt.notes,'Food inventory receipt '||v_receipt.receipt_number),
    'approved',now(),p_user_id,v_receipt.id,p_user_id,p_user_id
  ) returning id into v_invoice_id;

  perform accounting_post_supplier_invoice(v_invoice_id,p_user_id);

  update inventory_receipt
  set status='posted',posted_at=now(),posted_by=p_user_id,updated_at=now(),updated_by=p_user_id
  where id=p_receipt_id;

  if v_receipt.purchase_order_id is not null then
    perform refresh_food_purchase_order_status(v_receipt.purchase_order_id);
  end if;

  return v_invoice_id;
end;
$$;

create or replace function inventory_current_average_cost(p_ingredient_id uuid)
returns numeric language sql stable as $$
  select average_unit_cost from ingredient_inventory_balance where ingredient_id=p_ingredient_id;
$$;

create or replace function post_inventory_adjustment(p_adjustment_id uuid,p_user_id uuid default null)
returns uuid language plpgsql as $$
declare
  v inventory_adjustment%rowtype;
  v_balance ingredient_inventory_balance%rowtype;
  v_qty_delta numeric(14,3);
  v_unit_cost numeric(14,4);
  v_total numeric(14,2);
  v_inventory uuid;
  v_expense uuid;
  v_inventory_currency text;
  v_expense_currency text;
  v_entry uuid;
  v_debit uuid;
  v_credit uuid;
begin
  select * into v from inventory_adjustment where id=p_adjustment_id for update;
  if not found then raise exception 'Inventory adjustment not found'; end if;
  if v.status<>'draft' then raise exception 'Only draft inventory adjustments can be posted'; end if;

  perform 1 from ingredient where id=v.ingredient_id for update;
  select * into v_balance from ingredient_inventory_balance where ingredient_id=v.ingredient_id;

  v_inventory := accounting_mapped_account('inventory_asset');
  v_expense := accounting_mapped_account('food_program_expense');
  select currency into v_inventory_currency from account where id=v_inventory and status='active' and allow_posting=true;
  select currency into v_expense_currency from account where id=v_expense and status='active' and allow_posting=true;
  if v_inventory_currency is null or v_expense_currency is null or v_inventory_currency<>v_expense_currency or v.currency<>v_inventory_currency then
    raise exception 'Inventory and food program expense mappings must use active accounts in the adjustment currency';
  end if;

  if not exists (
    select 1 from accounting_period where status='open' and v.occurred_on between starts_on and ends_on
  ) then
    raise exception 'Inventory adjustment date is not inside an open accounting period';
  end if;

  if v.adjustment_kind='correction_in' then
    v_qty_delta := v.quantity;
    v_unit_cost := coalesce(v.unit_cost_override,
      case when v_balance.quantity_on_hand>0 then v_balance.average_unit_cost else null end);
    if v_unit_cost is null then
      raise exception 'Unit cost is required when increasing stock from a zero balance';
    end if;
    v_debit := v_inventory;
    v_credit := v_expense;
  else
    if v_balance.quantity_on_hand<v.quantity then
      raise exception 'Inventory adjustment would make stock negative';
    end if;
    if v_balance.quantity_on_hand<=0 then raise exception 'No stock is available to remove'; end if;
    v_qty_delta := -v.quantity;
    v_unit_cost := v_balance.average_unit_cost;
    v_debit := v_expense;
    v_credit := v_inventory;
  end if;

  v_total := round(abs(v_qty_delta)*v_unit_cost,2);

  insert into inventory_movement(
    ingredient_id,occurred_on,movement_kind,quantity_delta,unit_cost,source_type,source_id,reference,notes,created_by
  ) values (
    v.ingredient_id,v.occurred_on,v.adjustment_kind,v_qty_delta,v_unit_cost,
    'inventory_adjustment',v.id,v.adjustment_number,coalesce(v.notes,v.reason),p_user_id
  );

  if v_total>0 then
    insert into journal_entry(
      journal_id,entry_kind,posting_date,currency,description,transaction_reference,source_type,source_id,created_by
    ) values (
      accounting_operations_journal(),'system',v.occurred_on,v.currency,
      'Food inventory '||replace(v.adjustment_kind,'_',' '),v.adjustment_number,
      'inventory_adjustment',v.id,p_user_id
    ) returning id into v_entry;

    insert into journal_line(journal_entry_id,line_number,account_id,description,debit,credit,created_by)
    values
      (v_entry,1,v_debit,v.reason,v_total,0,p_user_id),
      (v_entry,2,v_credit,v.reason,0,v_total,p_user_id);
    perform post_journal_entry(v_entry,p_user_id);
  end if;

  update inventory_adjustment
  set status='posted',unit_cost_snapshot=v_unit_cost,total_value=v_total,posted_at=now(),posted_by=p_user_id
  where id=v.id;
  return v_entry;
end;
$$;

create or replace function reverse_inventory_adjustment(
  p_adjustment_id uuid,p_reversal_date date,p_user_id uuid default null,p_reason text default 'Inventory adjustment reversal'
)
returns void language plpgsql as $$
declare
  v inventory_adjustment%rowtype;
  v_movement inventory_movement%rowtype;
  v_on_hand numeric;
  v_entry uuid;
begin
  select * into v from inventory_adjustment where id=p_adjustment_id for update;
  if not found or v.status<>'posted' then raise exception 'Only posted inventory adjustments can be reversed'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Reversal reason is required'; end if;
  if not exists (select 1 from accounting_period where status='open' and p_reversal_date between starts_on and ends_on) then
    raise exception 'Reversal date is not inside an open accounting period';
  end if;

  perform 1 from ingredient where id=v.ingredient_id for update;
  select * into v_movement from inventory_movement
  where source_type='inventory_adjustment' and source_id=v.id and movement_kind=v.adjustment_kind
  order by created_at desc limit 1;
  if not found then raise exception 'Original inventory movement not found'; end if;

  if v_movement.quantity_delta>0 then
    select quantity_on_hand into v_on_hand from ingredient_inventory_balance where ingredient_id=v.ingredient_id;
    if v_on_hand<v_movement.quantity_delta then
      raise exception 'Adjustment cannot be reversed because part of the added stock has already been consumed';
    end if;
    if exists (
      select 1 from inventory_movement m
      where m.ingredient_id=v.ingredient_id and m.created_at>v_movement.created_at
    ) then
      raise exception 'Stock-in correction cannot be reversed after later movements for the ingredient';
    end if;
  end if;

  insert into inventory_movement(
    ingredient_id,occurred_on,movement_kind,quantity_delta,unit_cost,source_type,source_id,reference,notes,created_by
  ) values (
    v.ingredient_id,p_reversal_date,'adjustment_reversal',-v_movement.quantity_delta,v_movement.unit_cost,
    'inventory_adjustment_reversal',v.id,v.adjustment_number,p_reason,p_user_id
  );

  select id into v_entry from journal_entry
  where source_type='inventory_adjustment' and source_id=v.id and status='posted';
  if v_entry is not null then
    perform reverse_journal_entry(v_entry,p_reversal_date,p_user_id,p_reason);
  end if;

  update inventory_adjustment
  set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason
  where id=v.id;
end;
$$;

create or replace function reverse_inventory_receipt(
  p_receipt_id uuid,p_reversal_date date,p_user_id uuid default null,p_reason text default 'Inventory receipt reversal'
)
returns void language plpgsql as $$
declare
  v_receipt inventory_receipt%rowtype;
  v_line inventory_receipt_line%rowtype;
  v_on_hand numeric;
  v_invoice supplier_invoice%rowtype;
  v_balance numeric;
begin
  select * into v_receipt from inventory_receipt where id=p_receipt_id for update;
  if not found or v_receipt.status<>'posted' then raise exception 'Only posted inventory receipts can be reversed'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Reversal reason is required'; end if;
  if not exists (select 1 from accounting_period where status='open' and p_reversal_date between starts_on and ends_on) then
    raise exception 'Reversal date is not inside an open accounting period';
  end if;

  select * into v_invoice from supplier_invoice where inventory_receipt_id=v_receipt.id for update;
  if not found or v_invoice.status not in ('posted','partially_paid','paid') then
    raise exception 'Posted inventory supplier invoice not found';
  end if;
  select balance_amount into v_balance from supplier_invoice_balance where id=v_invoice.id;
  if v_balance is distinct from v_invoice.amount then
    raise exception 'Reverse supplier payments before reversing an inventory receipt';
  end if;

  for v_line in select * from inventory_receipt_line where inventory_receipt_id=v_receipt.id loop
    perform 1 from ingredient where id=v_line.ingredient_id for update;
    select quantity_on_hand into v_on_hand from ingredient_inventory_balance where ingredient_id=v_line.ingredient_id;
    if v_on_hand<v_line.quantity_received then
      raise exception 'Receipt cannot be reversed because some received stock has already been consumed';
    end if;
    if exists (
      select 1
      from inventory_movement later
      join inventory_movement original
        on original.source_type='inventory_receipt_line'
       and original.source_id=v_line.id
       and original.movement_kind='receipt'
      where later.ingredient_id=v_line.ingredient_id
        and later.created_at>original.created_at
    ) then
      raise exception 'Receipt cannot be reversed after later movements for the ingredient';
    end if;
  end loop;

  for v_line in select * from inventory_receipt_line where inventory_receipt_id=v_receipt.id loop
    insert into inventory_movement(
      ingredient_id,occurred_on,movement_kind,quantity_delta,unit_cost,source_type,source_id,reference,notes,created_by
    ) values (
      v_line.ingredient_id,p_reversal_date,'receipt_reversal',-v_line.quantity_received,v_line.unit_cost,
      'inventory_receipt_reversal',v_line.id,v_receipt.receipt_number,p_reason,p_user_id
    );
  end loop;

  perform reverse_operational_source('supplier_invoice',v_invoice.id,p_reversal_date,p_user_id,p_reason);

  update inventory_receipt
  set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason,updated_at=now(),updated_by=p_user_id
  where id=v_receipt.id;

  update supplier_invoice
  set status='reversed',reversed_at=now(),reversed_by=p_user_id,reversal_reason=p_reason,updated_at=now(),updated_by=p_user_id
  where id=v_invoice.id;

  if v_receipt.purchase_order_id is not null then
    perform refresh_food_purchase_order_status(v_receipt.purchase_order_id);
  end if;
end;
$$;

create or replace view inventory_movement_report as
select
  m.*,
  i.code as ingredient_code,
  i.name as ingredient_name,
  u.code as unit_code
from inventory_movement m
join ingredient i on i.id=m.ingredient_id
join inventory_unit u on u.id=i.unit_id;

create or replace view food_purchase_report as
select
  r.id as inventory_receipt_id,
  r.receipt_number,
  r.received_on,
  r.currency,
  r.status,
  s.id as supplier_id,
  s.supplier_number,
  s.name as supplier_name,
  rl.ingredient_id,
  i.code as ingredient_code,
  i.name as ingredient_name,
  u.code as unit_code,
  rl.quantity_received,
  rl.unit_cost,
  rl.line_amount
from inventory_receipt r
join supplier s on s.id=r.supplier_id
join inventory_receipt_line rl on rl.inventory_receipt_id=r.id
join ingredient i on i.id=rl.ingredient_id
join inventory_unit u on u.id=i.unit_id
where r.status='posted';

create or replace view food_inventory_cost_report as
select
  a.id,
  a.adjustment_number,
  a.occurred_on,
  a.adjustment_kind,
  a.currency,
  a.quantity,
  a.unit_cost_snapshot,
  a.total_value,
  a.reason,
  i.id as ingredient_id,
  i.code as ingredient_code,
  i.name as ingredient_name,
  u.code as unit_code
from inventory_adjustment a
join ingredient i on i.id=a.ingredient_id
join inventory_unit u on u.id=i.unit_id
where a.status='posted';

create or replace view food_program_month_summary as
with months as (
  select date_trunc('month',received_on)::date as month_start,currency
  from inventory_receipt where status='posted'
  union
  select date_trunc('month',occurred_on)::date,currency
  from inventory_adjustment where status='posted'
  union
  select date_trunc('month',issued_on)::date,currency
  from food_bill where status<>'void' and issued_on is not null
), purchases as (
  select date_trunc('month',r.received_on)::date as month_start,r.currency,
    sum(rl.line_amount)::numeric(14,2) as purchased_amount
  from inventory_receipt r
  join inventory_receipt_line rl on rl.inventory_receipt_id=r.id
  where r.status='posted'
  group by 1,2
), costs as (
  select date_trunc('month',occurred_on)::date as month_start,currency,
    sum(case when adjustment_kind='usage' then total_value else 0 end)::numeric(14,2) as usage_cost,
    sum(case when adjustment_kind='waste' then total_value else 0 end)::numeric(14,2) as waste_cost,
    sum(case when adjustment_kind='spoilage' then total_value else 0 end)::numeric(14,2) as spoilage_cost,
    sum(case when adjustment_kind='correction_out' then total_value when adjustment_kind='correction_in' then -total_value else 0 end)::numeric(14,2) as correction_cost
  from inventory_adjustment
  where status='posted'
  group by 1,2
), income as (
  select date_trunc('month',issued_on)::date as month_start,currency,
    sum(total_amount)::numeric(14,2) as food_income
  from food_bill
  where status<>'void' and issued_on is not null
  group by 1,2
)
select
  m.month_start,m.currency,
  coalesce(p.purchased_amount,0)::numeric(14,2) as purchased_amount,
  coalesce(c.usage_cost,0)::numeric(14,2) as usage_cost,
  coalesce(c.waste_cost,0)::numeric(14,2) as waste_cost,
  coalesce(c.spoilage_cost,0)::numeric(14,2) as spoilage_cost,
  coalesce(c.correction_cost,0)::numeric(14,2) as correction_cost,
  (coalesce(c.usage_cost,0)+coalesce(c.waste_cost,0)+coalesce(c.spoilage_cost,0)+coalesce(c.correction_cost,0))::numeric(14,2) as recognized_food_cost,
  coalesce(i.food_income,0)::numeric(14,2) as food_income,
  (coalesce(i.food_income,0)-coalesce(c.usage_cost,0)-coalesce(c.waste_cost,0)-coalesce(c.spoilage_cost,0)-coalesce(c.correction_cost,0))::numeric(14,2) as rough_food_margin
from months m
left join purchases p on p.month_start=m.month_start and p.currency=m.currency
left join costs c on c.month_start=m.month_start and c.currency=m.currency
left join income i on i.month_start=m.month_start and i.currency=m.currency;

insert into permission(key,description) values
  ('inventory.view','View ingredients, stock levels, purchases, valuation, alerts and food cost summaries'),
  ('inventory.manage','Create and maintain ingredient and unit setup'),
  ('inventory.purchase','Create and manage food purchase orders and draft stock receipts'),
  ('inventory.post','Post and reverse stock receipts with supplier payable integration'),
  ('inventory.adjust','Post and reverse kitchen usage, waste, spoilage and stock-count adjustments')
on conflict (key) do update set description=excluded.description;

insert into role_permission(role_id,permission_key)
select r.id,p.key
from role r cross join permission p
where lower(r.name)='administrator'
on conflict do nothing;

create or replace function protect_inventory_asset_mapping_change()
returns trigger language plpgsql as $$
begin
  if old.role_key='inventory_asset'
     and new.account_id is distinct from old.account_id
     and exists (
       select 1 from ingredient_inventory_balance
       where inventory_value<>0 or quantity_on_hand<>0
     ) then
    raise exception 'Inventory Asset mapping cannot change while inventory is on hand';
  end if;
  return new;
end;
$$;

create trigger accounting_mapping_inventory_asset_guard
before update of account_id on accounting_mapping
for each row
execute function protect_inventory_asset_mapping_change();
