# Step 11 — Food Inventory & Purchasing

Step 11 adds a deliberately simple food-stock layer on top of Step 10 food billing and the existing supplier/accounting engine.

## What is included

- Ingredient master with base units and reorder levels
- Purchase orders with draft, ordered, partially received, received and cancelled states
- Stock receipts, including partial receipts against a purchase order
- Existing supplier integration and supplier payables
- Moving-average inventory valuation
- Low-stock alerts
- Manual kitchen usage, waste, spoilage and stock-count corrections
- Immutable stock movements with explicit reversal workflows
- Inventory Asset and Food Program Expense accounting mappings
- Monthly food-program summary covering purchases, recognized stock cost, food-package income and rough margin
- Permission controls and audit events

## Accounting model

Food purchases are inventory first, not immediate expense.

When stock is received:

- Debit **Food Inventory Asset**
- Credit **Accounts Payable**

The receipt creates and posts a normal supplier invoice, so existing supplier payments, Accounts Payable reporting and supplier statements remain authoritative.

When ingredients are used, wasted or spoiled:

- Debit **Food Program Expense**
- Credit **Food Inventory Asset**

Stock corrections use the same two accounts in the appropriate direction. Moving-average cost is used for stock leaving inventory.

This avoids double-counting food cost while ingredients are still on hand.

## Safety controls

- Stock movements cannot be edited or deleted.
- Posted receipt/adjustment scope is immutable; corrections are reversals, not history rewrites.
- Stock-out operations cannot make quantity negative.
- A receipt cannot exceed the outstanding purchase-order quantity.
- An inventory-backed supplier invoice cannot be reversed from the normal supplier screen; the inventory receipt must be reversed so stock and accounting stay together.
- Supplier credits against inventory receipts are blocked until a future stock-return workflow exists.
- A receipt or stock-in correction cannot be reversed after later movements for that ingredient, because that would make moving-average valuation ambiguous.
- Receipt, adjustment and reversal dates must be inside an open accounting period.

## Setup

Before posting inventory transactions, configure:

1. **Inventory Asset** → an active posting Asset account in the inventory currency.
2. **Food Program Expense** → an active posting Expense account in the same currency.
3. The existing **Accounts Payable** mapping and **Operations journal** from Release 1.

The Inventory page exposes the Step 11 mappings to users with `accounting.mapping` permission.

## Monthly milestone answers

The Inventory page answers the Step 11 milestone directly:

- **How much food did Montikids buy this month?** Posted inventory receipt value.
- **What stock do we have?** Quantity on hand and moving-average inventory value by ingredient.
- **How much did food packages earn?** Step 10 issued food-bill income for the month.
- **Roughly what is the food program costing us?** Ingredient usage + waste + spoilage + net stock corrections.

A rough margin is also shown as food-package income less recognized inventory cost.

## Deliberate non-goals

Step 11 does **not** implement recipe/BOM costing, grams-per-student consumption, theoretical food usage, batch/lot expiry tracking, or supplier-return credits. Those can be layered onto this inventory ledger later without replacing it.

## Verification

Run:

```bash
npm run db:migrate
npm run verify:food
npm run verify:inventory
npm run typecheck
npm run build
```

`verify:inventory` checks permissions, purchase orders, partial receiving, over-receipt protection, supplier payable/accounting integration, moving-average valuation, usage/waste/spoilage, low-stock alerts, reversal safety, the monthly food-program summary, inventory/AP balances and trial-balance equality.