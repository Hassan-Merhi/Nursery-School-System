# Step 12 — Notifications & Automation

Step 12 turns reliable operational data into actionable reminders without maintaining duplicate financial balances.

## Notification sources

The notification refresh engine reads directly from the authoritative workflow tables and views:

- Student fee invoices and `invoice_balance`
- Supplier invoices and `supplier_invoice_balance`
- Rent schedules and `rent_schedule_balance`
- Payroll runs
- School terms
- Rental-agreement end dates
- Employee document-expiry records
- Food inventory through the Step 11 integration view described below

A notification does not become a second copy of a balance. If a fee is paid, a supplier invoice is settled, rent is paid, or an expiry record is renewed, the next refresh resolves the corresponding notification.

## Rules

Administrators can enable/disable rules and configure lead days and severity for:

- Fee due notices
- Outstanding/overdue fee alerts
- Rent due
- Supplier payment due
- Payroll reminders
- Term-start reminders
- Low food inventory
- Rental contract expiry
- Employee document expiry

The default lead times are intentionally conservative and can be changed from `/notifications`.

## Notification lifecycle

Notifications are deduplicated by rule, source record, and occurrence. Their lifecycle is:

- `open`
- `snoozed`
- `acknowledged`
- `dismissed`
- `resolved`

Open and snoozed alerts that no longer match their source condition are automatically resolved on the next refresh. The refresh is protected by a PostgreSQL advisory lock and uses a unique run identifier, so a condition cleared later on the same day resolves immediately on the next run.

## Running automation

For a host-level scheduler or cron job:

~~~bash
npm run notifications:run
~~~

For an external scheduler, use:

~~~text
POST /api/automation/notifications
Authorization: Bearer <AUTOMATION_SECRET>
~~~

Set a long random `AUTOMATION_SECRET` in production. The endpoint refuses requests when the secret is missing or incorrect.

A daily run is sufficient for the current day-based rules. You can run it more often if staff want faster same-day resolution after payments or renewals.

## Food inventory integration

Step 11 is intentionally not duplicated inside Step 12. When the inventory module is present, expose this view:

~~~sql
create or replace view inventory_low_stock_notification_source as
select
  <ingredient-or-item-id>::uuid as source_id,
  <item-name>::text as item_name,
  <current-quantity>::numeric as current_quantity,
  <reorder-level>::numeric as reorder_level,
  <unit-name>::text as unit_name
from ...;
~~~

The Step 12 engine detects the view dynamically. Items where `current_quantity <= reorder_level` generate low-food-inventory notifications. If Step 11 is not installed yet, the other notification rules continue to work normally.

## Employee document expiry

The notification workspace includes a small expiry registry for documents such as permits, certifications, medical/first-aid certificates, or other time-limited employee records. A renewed record should be marked `renewed` and a new active record entered with the new expiry date, preserving expiry history.

## Verification

Run:

~~~bash
npm run db:migrate
npm run verify:notifications
npm run typecheck
npm run build
~~~

The Step 12 verification checks seeded permissions/rules, term reminders, employee-document expiry, low-stock integration compatibility, idempotent refreshes, same-day automatic resolution, and Administrator access.
