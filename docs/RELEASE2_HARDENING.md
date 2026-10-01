# Step 14 — Release 2 Testing & Hardening

Release 2 uses the same launch standard as Release 1: module tests are necessary, but the release is not ready until the connected financial paths reconcile end to end, upgrade safely, survive backup/restore, and pass operator UAT.

## Automated hardening

Run:

```bash
npm run db:migrate
npm run verify:food
npm run verify:inventory
npm run verify:notifications
npm run verify:analytics
npm run verify:release2
npm run verify:backup-restore
```

`verify:release2` creates a temporary PostgreSQL database, upgrades a Release 1-era schema and records through every Release 2 migration, runs destructive edge cases and concurrent writes, verifies reports and accounting, then drops the scratch database.

It specifically proves these two chains.

### Food collection chain

```text
Food charge
  -> student/family ledger
  -> Accounts Receivable
  -> parent payment
  -> bank
  -> payment allocation
  -> accounting
  -> receivables / food income / analytics reports
```

The test issues food charges, settles them through the shared payment workflow, reverses and replaces a payment, and races two users trying to settle the same food bill. Only one concurrent allocation may succeed.

### Food purchasing chain

```text
Purchase order
  -> supplier
  -> inventory receipt
  -> supplier payable
  -> Inventory Asset
  -> usage / waste / spoilage / corrections
  -> Food Program Expense
  -> supplier payment
  -> bank
  -> accounting
  -> inventory / supplier / food-program reports
```

The test receives stock, verifies the automatically linked supplier invoice, consumes inventory, checks moving valuation, settles the supplier payable, and verifies supplier statements and reports. It also races two receipts against the same purchase order; the database serializes receipt posting so the order cannot be over-received.

## Release 2 reconciliation gate

Before production launch, run the gate against the real database at the intended cutoff date:

```bash
npm run release2:gate -- --through=YYYY-MM-DD
```

Every row must pass with a zero difference. Release 2 retains all Release 1 controls and adds the Release 2 control accounts:

- Student balances = Accounts Receivable
- Family credits = Customer Deposits
- Supplier balances = Accounts Payable
- Cash screens = Cash ledger
- Bank screens = Bank ledger
- Payroll reports = Payroll accounting
- Net Position = Accounting ledger
- Trial Balance debits = Trial Balance credits
- Food income = Food Income ledger
- Inventory valuation = Inventory Asset ledger
- Food cost = Food Program Expense ledger

Do not launch Release 2 while any row fails.

## Release 2 hardening added in Step 14

Step 14 closes two cross-module gaps uncovered by adversarial testing.

First, purchase-order receipts now lock the purchase order while checking outstanding quantity. This prevents two simultaneous users from each seeing the same remaining quantity and collectively over-receiving the order.

Second, the real Step 11 ingredient balance is now exposed through `inventory_low_stock_notification_source`, completing the Step 11 -> Step 12 low-stock notification contract. Notification tests therefore run against authoritative inventory, not a CI-only substitute.

## Migration and data-survival test

The scratch verifier first applies migrations through Release 1, creates representative family and supplier records, then applies all Release 2 migrations. It asserts that the existing records survive and that every migration is recorded.

Release 2 migrations must remain forward-only. Never edit an already-applied migration in place; add a new numbered migration.

## Permissions

The automated release test confirms the Administrator role receives all food, inventory, notification, and analytics permissions. It also creates a restricted user with only `food.view` and verifies that unrelated Release 2 permissions are not inherited.

Operator UAT should additionally confirm real staff roles can only see and perform the actions intended for them.

## Backup and restore

The shared backup/restore drill remains mandatory. It verifies the database dump, document archive, migration history, users, Release 1 and Release 2 reconciliation functions, and Release 2 food/inventory tables survive restoration.

Run:

```bash
npm run verify:backup-restore
```

## Operator UAT checklist

Use a non-production copy of realistic Montikids data and record the tester, date, result, and evidence for each item.

- Create each food package frequency and confirm its price is snapshotted on the student's selection.
- Issue a food bill and confirm the student/family ledger, Accounts Receivable, Food Income, and food report agree.
- Receive a cash and a bank food payment; allocate it and confirm the bill, bank/cash screen, ledger, receipt, and receivables report agree.
- Reverse a food payment and confirm the food receivable reopens without editing history.
- Try to double-allocate the same parent funds across tuition and food; the second allocation must fail.
- Create a food purchase order, partially receive it, finish receiving it, and confirm supplier payable and stock quantities.
- Record usage, waste, spoilage, and a stock-count correction; confirm stock value and Food Program Expense.
- Try to consume more inventory than is available; it must fail.
- Set an ingredient at or below its reorder threshold; confirm a low-stock notification is generated and later resolves after replenishment.
- Pay an inventory-backed supplier invoice; confirm supplier balance, bank, Accounts Payable, supplier statement, and due notification all update.
- Confirm the Advanced Analytics food trend agrees with the underlying food income and food-cost ledgers.
- Run the Release 2 reconciliation gate for the UAT cutoff and retain the zero-difference output as launch evidence.
- Restore a backup into a disposable database and verify food, inventory, accounting, reports, and documents are present.

## Launch sign-off

Release 2 is ready only when:

1. CI is green on the exact commit to be deployed.
2. `verify:release2` passes.
3. `verify:backup-restore` passes.
4. The production/staging `release2:gate` reports zero difference for every required relationship.
5. Operator UAT has no unresolved critical or high-severity defects.
6. A current backup has been taken before deployment.
