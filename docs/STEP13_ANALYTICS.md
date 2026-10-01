# Step 13 — Advanced Dashboard & Analysis

Step 13 is the read-only management analytics layer for Montikids Montessori Preschool & Nursery.

## Access

Authorized users open /analytics. The server requires analytics.view; hiding UI links is not the security boundary. The Administrator role receives this permission during migration 020.

The analytics workspace supports school-year, term, and custom-date views. It uses the school timezone for the current date and each configured term's actual dates.

## Source-of-truth rules

Analytics does not keep editable balances. Financial totals are derived from posted journal entries and the existing Step 8 reporting functions. Reversals affect the month in which the reversing entry posts, so later reversals do not rewrite prior-period analytics.

Amounts are never added across unlike currencies. USD, LBP, EUR, and any other configured currencies appear as separate series.

A zero denominator produces a null percentage. The UI shows explicit states such as “No fees due” instead of 0%, 100%, NaN, or Infinity.

## Metrics

- Term comparison: active students, tuition due/collected/outstanding, collection rate, income, expenses, payroll, recognized rent, food revenue/cost/contribution, and external cash movement for each configured term.
- Monthly trends: continuous calendar-month rows for income, expenses, expected tuition, collected tuition, collection rate, and active students.
- Expense trends: posted expense activity grouped by the school's own chart-of-accounts codes and names, with period share and prior-year change.
- Student growth: opening/closing active population plus enrollments, withdrawals, net change, and growth percentage.
- Fee collection rate: allocated tuition collections divided by tuition invoices due in the period. Unallocated parent money remains a prepayment.
- Food profitability: Step 10 food revenue compared with Step 11 recognized food cost. Usage, waste, spoilage, corrections, and other food-program expense postings are visible separately. Inventory purchases are shown separately and do not become expense merely because cash was spent.
- Payroll trends: locked/paid payroll snapshots only. The analytics API returns aggregate base salary, allowances, bonuses, deductions, employee cost, advance repayments, net pay, and employee count. It never returns employee names, employee numbers, salary-agreement IDs, or payslips.
- Rent impact: recognized posted rent expense, not the cash amount of prepaid rent.
- Cash movement: external inflow/outflow and closing cash/bank balances. Internal transfers between school cash/bank accounts cancel at consolidated level.
- Year over year: current period versus the comparable prior period, with absolute and percentage change. A zero prior value produces a null percentage.

## Food-cost integration

Step 11 is part of the base branch, so Step 13 uses the real food_program_expense accounting mapping and inventory-adjustment sources. Cost recognition follows journal posting dates, including later reversal entries. Usage/waste/spoilage classification is joined to the originating inventory adjustment; uncategorized/manual postings to the mapped food expense account appear as other food cost.

## Verification

Run these commands after migrations:

    npm run db:migrate
    npm run verify:analytics
    npm run typecheck
    npm run build

verify:analytics checks the permission contract, all ten analytics interfaces, continuous empty months, student starts/withdrawals, fee zero-denominator behavior, aggregate-only payroll shape, rent recognition versus prepayment, internal-transfer exclusion, food contribution, currency separation, term comparison, year-over-year values, and historical stability after later reversals.

CI also runs every earlier foundation, billing, accounting, operations, rentals, payroll, reports, food, inventory, and notifications verification suite before typecheck and production build.
