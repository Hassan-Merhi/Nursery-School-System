-- Step 14 — Release 2 hardening and reconciliation
-- Close cross-module race conditions and add a production gate for food and inventory controls.

-- Serialize receipts for the same purchase order before checking outstanding quantities.
-- Without this lock, two concurrent receipts could both observe the same outstanding quantity
-- and over-receive the purchase order.
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
    perform 1 from food_purchase_order where id=v_receipt.purchase_order_id for update;
    if not found then raise exception 'Purchase order not found'; end if;

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

-- Bind Step 11's real low-stock ledger to the Step 12 notification contract.
create or replace view inventory_low_stock_notification_source as
select
  b.ingredient_id as source_id,
  b.name as item_name,
  b.quantity_on_hand as current_quantity,
  b.reorder_level,
  b.unit_name
from ingredient_inventory_balance b
where b.status='active' and b.reorder_level>0;

create or replace function release2_reconciliation_gate(p_through date)
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
with food_map as (
  select
    a.id as matched_account,
    coalesce(a.currency,'UNMAPPED') as currency,
    coalesce(b.normal_balance,0)::numeric(14,2) as amount
  from (values (1)) anchor(n)
  left join accounting_mapping m on m.role_key='food_income'
  left join account a on a.id=m.account_id
  left join report_account_balances(p_through) b on b.account_id=a.id
), food_ops as (
  select b.currency,sum(b.total_amount)::numeric(14,2) as amount
  from food_bill b
  where b.issued_on is not null
    and b.issued_on<=p_through
    and (
      b.status<>'void'
      or report_effective_reversal_date('food_bill',b.id,b.voided_at)>p_through
    )
  group by b.currency
), inventory_map as (
  select
    a.id as matched_account,
    coalesce(a.currency,'UNMAPPED') as currency,
    coalesce(b.normal_balance,0)::numeric(14,2) as amount
  from (values (1)) anchor(n)
  left join accounting_mapping m on m.role_key='inventory_asset'
  left join account a on a.id=m.account_id
  left join report_account_balances(p_through) b on b.account_id=a.id
), inventory_ops as (
  select coalesce(sum(m.value_delta) filter (where m.occurred_on<=p_through),0)::numeric(14,2) as amount
  from inventory_movement m
), food_cost_map as (
  select
    a.id as matched_account,
    coalesce(a.currency,'UNMAPPED') as currency,
    coalesce(b.normal_balance,0)::numeric(14,2) as amount
  from (values (1)) anchor(n)
  left join accounting_mapping m on m.role_key='food_program_expense'
  left join account a on a.id=m.account_id
  left join report_account_balances(p_through) b on b.account_id=a.id
), food_cost_ops as (
  select coalesce(
    -sum(m.value_delta) filter (
      where m.occurred_on<=p_through
        and m.movement_kind not in ('receipt','receipt_reversal')
    ),0
  )::numeric(14,2) as amount
  from inventory_movement m
)
select * from release_reconciliation_gate(p_through)

union all

select
  'Food income = Food Income ledger',
  m.currency,
  coalesce(o.amount,0)::numeric(14,2),
  m.amount,
  (coalesce(o.amount,0)-m.amount)::numeric(14,2),
  (m.matched_account is not null and abs(coalesce(o.amount,0)-m.amount)<0.005),
  case when m.matched_account is null
    then 'Food Income mapping is missing'
    else 'Issued food bills compared with the mapped Food Income control account'
  end
from food_map m
left join food_ops o on o.currency=m.currency

union all

select
  'Inventory valuation = Inventory Asset ledger',
  m.currency,
  o.amount,
  m.amount,
  (o.amount-m.amount)::numeric(14,2),
  (m.matched_account is not null and abs(o.amount-m.amount)<0.005),
  case when m.matched_account is null
    then 'Inventory Asset mapping is missing'
    else 'Inventory movement valuation compared with the mapped Inventory Asset control account'
  end
from inventory_map m
cross join inventory_ops o

union all

select
  'Food cost = Food Program Expense ledger',
  m.currency,
  o.amount,
  m.amount,
  (o.amount-m.amount)::numeric(14,2),
  (m.matched_account is not null and abs(o.amount-m.amount)<0.005),
  case when m.matched_account is null
    then 'Food Program Expense mapping is missing'
    else 'Usage, waste, spoilage and stock corrections compared with the mapped food expense account'
  end
from food_cost_map m
cross join food_cost_ops o;
$$;
