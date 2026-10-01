# Release 1 hardening and launch gate

Release 1 is not ready for real Montikids operations merely because the application builds. The release is ready only when the automated hardening suite passes, a restore drill succeeds, the production reconciliation gate passes for the chosen cut-off date, and the operator UAT checklist is signed off.

## Automated hardening

Run:

```bash
npm run db:migrate
npm run verify:release
npm run verify:backup-restore
npm run typecheck
npm run build
```

The existing CI `verify:reports` command also runs the Release 1 adversarial suite and backup/restore drill, so the current CI workflow enforces these checks without a separate workflow dependency.

`verify:release` creates an isolated scratch PostgreSQL database, migrates it from the pre-Step-9 schema through the current schema, runs destructive edge cases there, and drops it afterward. It deliberately tests:

- migration of existing school terms into the new open/closed term model;
- restricted-role permission isolation;
- duplicate receipt rejection and accounting-post idempotency;
- discounts above 100%;
- prepaid tuition and refund limits;
- closed-term enrollment, discount, and invoice protection;
- void/cancelled-invoice allocation rejection;
- incorrect-expense reversal returning the ledger to its prior balance;
- a salary advance larger than one month's salary without negative net pay;
- two database connections trying to settle the same invoice at the same time;
- every Release 1 financial reconciliation relationship.

## Closed terms

`school_term.status` is now either `open` or `closed`.

Closing a term prevents new term enrollments, new or reactivated discounts, fee changes/activation, new invoices, invoice issuance, and draft-invoice line changes for that term. Existing issued transactions remain available for settlement, refund, credit, reversal, and historical reporting so closing a term does not damage accounting history.

Closing the entire school year also makes its terms financially closed through the same database guard.

## Backup and restore

`npm run verify:backup-restore` runs the real `scripts/backup.sh` against the PostgreSQL 17 CI service, restores the dump into a separate database, verifies migration and user counts, verifies that the Release 1 reconciliation function survived the restore, and verifies the stored-document archive.

A production backup is still not valid until an off-site encrypted copy exists and a restore has been tested in the production-like environment.

## Production reconciliation gate

After all real transactions through a chosen cut-off date are entered and posted, run:

```bash
npm run release:gate -- --through=2026-10-31
```

Use the actual launch cut-off date instead of the example date.

The command fails the release if any required control is missing or different:

| Release gate | Required result |
| --- | --- |
| Student balances = Accounts Receivable | Difference 0.00 |
| Family credits = Customer Deposits | Difference 0.00 |
| Supplier balances = Accounts Payable | Difference 0.00 |
| Cash screens = Cash ledger | Difference 0.00 |
| Bank screens = Bank ledger | Difference 0.00 |
| Payroll reports = Payroll accounting | Difference 0.00 |
| Net Position = Accounting ledger | Difference 0.00 |
| Trial Balance debits = Trial Balance credits | Difference 0.00 |

Do not launch if the command exits non-zero. Fix the source transaction or configuration; do not plug the difference with an unexplained journal entry.

## Operator UAT

Before first real use, an administrator and a normal restricted user should complete this checklist in the exact build that will be launched:

- Sign in and out; confirm the restricted user cannot open or submit an action outside their role.
- Create a family with two children, enroll both, and confirm sibling relationships and history.
- Create/approve a valid discount; confirm a value over 100% is rejected.
- Generate and issue an invoice; print the invoice and family statement.
- Record cash and bank tuition payments, a prepayment, a refund, and a reversal; print the receipt.
- Create, approve, post, and reverse an expense.
- Create a supplier invoice and supplier payment; inspect the supplier statement.
- Record a cash-to-bank transfer and complete a bank reconciliation.
- Create a prepaid rental arrangement and confirm monthly recognition rather than immediate full expense.
- Run payroll with an allowance, bonus, deduction, salary advance, and repayment; print a payslip.
- Close a term and confirm new enrollment/billing changes are rejected while historical reports remain readable.
- Open dashboard and financial/school/payroll reports for the chosen cut-off date; compare them to the independently prepared control totals.
- Run the production reconciliation gate and retain its output with the launch records.
- Restore the launch backup into a separate environment and open at least one student, invoice, receipt, supplier, payroll run, and report.

Record tester names, date, release commit SHA, cut-off date, and any exceptions. Release 1 should not be marked launched until every item is complete and the automated gate is green.

## Data migration rule

Never edit an old migration after it has been used by real data. Future hardening changes must be new numbered migrations. The Step 9 verifier specifically exercises an upgrade from migrations 001-015 into 016 so existing Release 1 data is not treated as a fresh-install-only case.
