# Step 10 — Food Packages & Student Food Billing

Step 10 is the first Release 2 operational module. It sits on top of the Release 1 student, billing, payment and accounting foundation instead of creating a second financial system.

## Included

- Food items with active/inactive status.
- Dated food-item price history with overlap prevention.
- Daily, weekly, monthly and term packages.
- Package composition from one or more food items.
- Student package selections tied to an enrolled school term.
- Price snapshots on selections so later price changes do not rewrite history.
- Food bills with draft, issued, partially paid, paid and void states.
- Normal Montikids receipts for food payments.
- Allocation of existing family payments/prepayments and transferable family credits to food bills.
- Food Income accounting.
- Family ledger, student ledger, Accounts Receivable and family-credit reporting integration.
- Closed-term protection, audit events and fine-grained permissions.

## Financial design

Food bills are intentionally separate from tuition invoices. Tuition has a Release 1 rule allowing only one live term invoice per student and term. Reusing that table for daily, weekly or monthly food billing would weaken that rule.

The financial postings are still shared.

When a food bill is issued:

    Dr Accounts Receivable
    Cr Food Income

When a parent pays:

    Dr Cash / Bank
    Cr Customer Deposits

When that payment is allocated to the food bill:

    Dr Customer Deposits
    Cr Accounts Receivable

Existing family credits use the same Customer Deposits control account before being allocated to a food bill.

The shared allocation validators count both tuition and food allocations. A payment or credit therefore cannot be spent once on tuition and again on food.

## Package and billing integrity

Activated package pricing and package contents are immutable. Archive an old package and create a replacement when the offering or price changes.

Student selections snapshot the package price and currency. The student must be enrolled in the selected term, the selection dates must remain inside the term/package dates, and duplicate overlapping selections for the same package are rejected.

Issued food-bill lines are immutable. A food bill with no allocations can be voided, which creates an accounting reversal. If money or credit has already been allocated, reverse the source payment/credit first so ledger history remains explicit.

Closing a school term blocks new food packages, selections, and draft food billing activity for that term.

## Setup

Before issuing the first food bill:

1. Ensure the Release 1 Accounts Receivable and Customer Deposits mappings are configured.
2. Ensure the Billing journal is active.
3. Create or choose an Income account for Food Income.
4. Open the /food workspace and save the Food Income mapping.
5. Create food items and price periods.
6. Build and activate packages.
7. Add student selections and start billing.

## Permissions

- food.view
- food.manage
- food.billing
- food.payments

Administrators receive all four permissions automatically. Other roles can be granted only the access they need.

## Verification

Run:

    npm run db:migrate
    npm run verify:food
    npm run typecheck
    npm run build

The food verification tests all four package frequencies, price history, price snapshots, duplicate and overlap protections, immutable issued bills, shared payment and credit allocations, accounting postings, food income reporting, family and student ledgers, closed terms, trial-balance equality, and compatibility with the Release 1 Accounts Receivable and Customer Deposits reconciliation checks.
