# Step 13 — Advanced Dashboard & Analysis

Date: 2026-10-01  
Status: Approved design specification  
Target branch: `step-13-advanced-analytics`

## 1. Purpose

Step 13 adds a read-only advanced analytics layer for Montikids Montessori Preschool & Nursery.

The goal is to turn the trusted operational and accounting history from Steps 1–12 into useful management analysis without creating a second source of financial truth. Analytics must reuse the same posted ledgers, historical date rules, reversals, permissions, and currency separation already established by the accounting and reporting system.

The finished module must answer, for any supported period:

- How are terms performing against one another?
- What is changing month by month?
- Which expense accounts are increasing or decreasing?
- Is active enrollment growing or shrinking?
- What percentage of fees due are being collected?
- Is the food program generating a positive or negative contribution after trusted food cost data is available?
- How is payroll changing over time?
- What impact is rent having on expenses and income?
- How is cash moving in and out?
- How does the selected year compare with the equivalent period in the prior year?

## 2. Architectural position

Step 13 sits above the existing operational modules.

It does not own billing, accounting, enrollment, payroll, rentals, food billing, purchasing, inventory, or notifications. It reads those modules through stable reporting functions and source-ledger queries.

The dependency chain is:

1. Enrollment provides historical student population.
2. Billing provides fee amounts and allocations.
3. Accounting provides posted financial activity and balances.
4. Rentals provide rent recognition and liabilities.
5. Payroll provides locked/paid employee cost.
6. Food billing provides food revenue.
7. Food inventory/purchasing provides food cost, waste, and inventory movement.
8. Step 13 aggregates these sources into period comparisons and trends.

Analytics must never maintain editable copies of balances or totals.

## 3. Integration strategy

Step 13 is developed on its own branch from `main`.

The expected migration number is `db/020_advanced_analytics.sql`, assuming Step 11 and Step 12 land as migrations 018 and 019. If integration order changes, the migration is renumbered before merge without changing its behavior.

The UI is a dedicated route:

`/analytics`

The existing `/reports` page remains the detailed statutory/management reporting workspace from Step 8. Step 13 is not implemented by expanding that already-large page with all analytics logic.

Both the administration dashboard and the reports workspace should link to `/analytics` for authorized users.

## 4. Permissions

Add:

- `analytics.view` — view advanced dashboard and analysis.

The built-in Administrator role receives this permission automatically.

Sensitive source data still respects existing permissions. In particular:

- `analytics.view` permits only aggregate payroll analytics such as monthly payroll expense, net pay, and employee count.
- Step 13 never returns employee names, employee numbers, salary agreements, payslips, or employee-level payroll rows.
- Detailed payroll data remains governed by the existing `payroll.view` permission in the payroll and reporting workspaces.
- Analytics is read-only and introduces no edit permission.

Server-side authorization is mandatory. Hiding a card in React is not sufficient protection.

## 5. Time and period rules

The analytics page uses the school timezone from `school_profile.timezone`.

Supported selectors:

- School year
- Term
- Custom date range
- Monthly granularity within the selected range

The default view should use the current school year when one exists. If no current school year exists, use the most recent year.

Historical analytics must remain stable when later records are created, deactivated, reversed, or edited in ways that should not affect the historical period. Step 13 inherits the Step 8 historical reporting rules.

Balance metrics use an as-of date.

Activity metrics use an inclusive from/to date range.

All month boundaries are calendar-month boundaries in the school timezone.

## 6. Currency rules

No analytics query may add unlike currencies.

Every monetary series and comparison remains grouped by currency.

The UI may render separate USD, LBP, EUR, or other currency series, but it must not display a combined grand total unless a future exchange-rate subsystem explicitly supports conversion.

Percentage metrics are calculated only within comparable currency populations.

## 7. Core metric definitions

### 7.1 Active students

For a given date, active students are derived from actual enrollment/term-enrollment windows, not the student's current status alone.

The existing historical active-student reporting behavior from Step 8 is the source of truth.

### 7.2 Student growth

Monthly student growth contains:

- Opening active students
- New active enrollments during the month
- Withdrawals/exits during the month
- Closing active students
- Net change
- Net growth percentage

Net growth percentage:

`(closing active - opening active) / opening active * 100`

If opening active students is zero, percentage is null rather than infinity.

### 7.3 Expected fees

Expected fees are issued tuition invoice amounts whose due dates fall within the selected period, excluding draft and void invoices.

This must match the Step 8 management definition.

### 7.4 Collected fees

Collected fees are parent payments received in the selected period and allocated to tuition invoices by the selected end date.

Unallocated parent money remains a prepayment/customer deposit and is not counted as collected tuition.

### 7.5 Fee collection rate

For each currency and selected period:

`collected fees / expected fees * 100`

If expected fees are zero, the collection rate is null and shown as “No fees due” rather than 0% or 100%.

The numerator and denominator must use the same Step 8 definitions.

### 7.6 Income and expenses

Income and expenses are derived from posted accounting journal lines in the selected period.

Draft journals are excluded.

Reversals affect the period in which their reversing entry posts.

Custom chart-of-accounts structure is preserved. Expense analysis groups by actual user-created expense accounts, not hard-coded categories.

### 7.7 Payroll trend

Payroll trend uses locked or paid payroll runs.

For each month and currency, include:

- Base salary
- Allowances
- Bonuses
- Deductions
- Payroll expense / employee cost
- Advance repayments
- Net pay
- Employee count

Historical payroll values come from stored payroll-run snapshots, never from today's salary agreements.

### 7.8 Rent impact

Rent analysis uses recognized rent expense from posted accounting rather than raw rental payments.

For each month and currency, include:

- Recognized rent expense
- Total operating expenses
- Total income
- Rent as a percentage of total expenses
- Rent as a percentage of total income

If the denominator is zero, the percentage is null.

Prepaid rent payments do not become full rent expense in the month paid. The existing rental recognition schedule remains authoritative.

### 7.9 Cash movement

Cash movement uses posted journal movements affecting configured cash/bank accounts.

For each month and currency, include:

- External inflow
- External outflow
- Net external movement
- Closing cash balance
- Closing bank balance
- Consolidated closing cash + bank

Transfers between the school's own cash/bank accounts cancel at consolidated level and are not counted as external inflow/outflow.

### 7.10 Food profitability

Food revenue comes from issued, non-void food billing/accounting.

Food cost must come from Step 11 purchasing/inventory cost records once that schema is integrated.

Food profitability must not estimate cost from menu prices, package selling prices, or arbitrary percentages.

For each month and currency, when trusted cost data exists, include:

- Food revenue
- Food purchasing/consumption cost as defined by Step 11
- Waste/spoilage cost
- Food contribution = revenue - trusted food cost
- Contribution margin percentage = contribution / revenue * 100

If Step 11 cost data is not installed, Step 13 must show food revenue and an explicit “Cost data unavailable” state. It must not fabricate profitability.

The final query names and joins for food cost are bound to the actual Step 11 migration during integration rather than guessed in this specification.

## 8. Term comparison

The term comparison view compares the three fixed school terms:

- Term 1 — September through December
- Term 2 — January through March
- Term 3 — April through June

For each term, per currency where applicable, show:

- Active students at term end
- Expected tuition
- Collected tuition
- Outstanding receivables at term end
- Fee collection rate
- Income
- Expenses
- Payroll expense
- Recognized rent expense
- Food revenue
- Food cost when available
- Food contribution when available
- Net cash movement

The comparison must use each term's actual configured dates, not hard-coded month strings, even though Montikids uses the fixed three-term structure.

## 9. Monthly trends

The monthly trend dataset supplies one row per calendar month and currency.

It includes:

- Income
- Expenses
- Expected tuition
- Collected tuition
- Collection rate
- Payroll expense
- Recognized rent expense
- Food revenue
- Food cost when available
- Net cash movement
- Closing cash
- Closing bank
- Active student count

Missing months must still appear with zero activity where a continuous range is expected, so charts do not skip time.

## 10. Expense trends

Expense trends provide:

- Monthly total expenses
- Monthly amount by posting expense account
- Period total per expense account
- Percentage of total expenses per account
- Change from previous comparable period

Only posted accounting entries are included.

The display uses the account code and account name created by the school.

No “marketing”, “cleaning”, “software”, or other category is hard-coded merely because those examples exist in recurring expenses.

## 11. Year-over-year comparison

Year-over-year compares the selected period with the same relative dates one year earlier.

For school-year mode, compare one school year with the previous school year.

For term mode, compare the selected term sequence with the same term sequence in the previous school year when available.

For custom-range mode, compare against the same date span shifted back one calendar year.

Per comparable currency, show:

- Current value
- Prior value
- Absolute change
- Percentage change

Percentage change is null when the prior value is zero.

The module must not invent prior-year values when the earlier period has no data.

## 12. Database interface

The migration should expose small, independently testable SQL functions rather than one giant query.

Expected interface shape:

- `analytics_monthly_financials(p_from date, p_to date)`
- `analytics_monthly_students(p_from date, p_to date)`
- `analytics_term_comparison(p_school_year_id uuid)`
- `analytics_expense_trend(p_from date, p_to date)`
- `analytics_payroll_trend(p_from date, p_to date)`
- `analytics_rent_trend(p_from date, p_to date)`
- `analytics_cash_trend(p_from date, p_to date)`
- `analytics_fee_collection(p_from date, p_to date)`
- `analytics_food_trend(p_from date, p_to date)`
- `analytics_year_over_year(p_from date, p_to date)`

The exact decomposition may change during implementation if existing Step 8 functions make a smaller interface possible. The invariant is that SQL owns financial aggregation and React does not independently recalculate accounting logic.

Where possible, Step 13 should call existing Step 8 report functions rather than duplicate their formulas.

## 13. Application structure

Recommended files:

- `db/020_advanced_analytics.sql`
  - analytics permissions
  - analytics SQL functions/views
  - supporting indexes only when justified by query plans
- `src/lib/analytics.ts`
  - typed query helpers
  - period normalization
  - safe numeric parsing
  - analytics DTOs
- `src/app/analytics/page.tsx`
  - server-rendered analytics page
  - selector handling
  - permission checks
  - composition of analytics sections
- `src/app/analytics/components.tsx`
  - presentational charts/cards/tables if splitting improves maintainability
- `scripts/verify-analytics.mjs`
  - Step 13 milestone verification
- `docs/STEP13_ANALYTICS.md`
  - operator/developer documentation

Existing files expected to receive small changes:

- `src/app/dashboard/page.tsx`
  - link to analytics
- `src/app/reports/page.tsx`
  - link to analytics
- `src/app/globals.css`
  - responsive chart/layout styles
- `package.json`
  - `verify:analytics`
- `.github/workflows/ci.yml`
  - run Step 13 verification
- `README.md`
  - Step 13 summary

## 14. UI design

The page should be management-focused and quickly readable.

Top area:

- School year selector
- Optional term selector
- From / to date controls
- Current-vs-prior comparison indicator

Primary KPI cards:

- Active students
- Student growth
- Fee collection rate
- Income
- Expenses
- Net cash movement
- Payroll expense
- Rent impact

Sections:

1. Term comparison
2. Monthly financial trends
3. Expense trends
4. Student growth
5. Fee collections
6. Food profitability
7. Payroll trends
8. Rent impact
9. Cash movement
10. Year-over-year comparison

Charts should be server-rendered HTML/CSS/SVG or similarly lightweight components. No large charting dependency is required for Step 13.

Every chart must have an accompanying numeric table or accessible labels so the data is still usable without interpreting graphics alone.

Empty datasets show a clear empty state rather than broken axes or NaN values.

## 15. Error handling

Invalid dates redirect or fall back to a safe analytics default, matching existing report-page behavior.

Database failures are not converted into zero-valued metrics because doing so would hide accounting/data problems.

Unsupported/missing optional modules, specifically food inventory during branch integration, produce an explicit availability state.

No percentage output may render NaN or Infinity.

## 16. Performance

Step 13 should remain fast on ordinary school-scale data.

Implementation should:

- aggregate in SQL rather than fetching raw journal lines into React,
- reuse existing report functions and indexed date fields,
- avoid N+1 queries,
- query independent analytics blocks in parallel where safe,
- avoid materialized duplicate balances in this release.

New indexes are added only for demonstrated access paths used by Step 13.

## 17. Verification strategy

Step 13 requires its own deterministic milestone dataset.

`scripts/verify-analytics.mjs` creates or uses an isolated verification database following the same safety pattern as existing verification scripts.

The dataset must cover at least:

- Two school years
- All three terms
- Multiple months in each year
- Multiple active students
- New enrollments
- Withdrawals
- Tuition invoices
- Partial collections
- Full collections
- Unallocated prepayments
- Posted expenses across multiple custom expense accounts
- Payroll runs with salary changes and adjustments
- Prepaid/recognized rent
- Cash receipts and bank payments
- Internal cash-to-bank transfer
- Food billing
- Food cost/waste once Step 11 is integrated
- Reversals
- At least two currencies without cross-currency aggregation

The verification asserts predetermined manual totals for:

- Term metrics
- Monthly trends
- Expense-account trends
- Student growth
- Fee collection rate
- Payroll trend
- Rent impact
- Cash movement
- Year-over-year change
- Food profitability when trusted cost data is present

It also verifies:

- zero-denominator percentage handling,
- historical reports do not change after later-period activity,
- internal transfers do not inflate consolidated cash movement,
- draft accounting activity does not enter analytics,
- reversed entries affect the correct period,
- users without `analytics.view` cannot access the page,
- payroll-sensitive output follows payroll permissions,
- currencies remain separate.

## 18. CI and regression requirements

CI must run:

- existing foundation verification
- students verification
- billing verification
- accounting verification
- operations verification
- rentals verification
- payroll verification
- reports/release verification
- food verification
- Step 11 verification once merged
- Step 12 verification once merged
- `verify:analytics`
- TypeScript typecheck
- production build

Step 13 is not complete merely because the analytics-specific script passes. Existing suites must remain green.

## 19. Acceptance criteria

Step 13 is complete when an authorized Montikids manager can:

1. Open `/analytics`.
2. Select a school year, term, or date range.
3. Compare all three school terms.
4. Inspect monthly income and expense trends.
5. See expense movement by custom account.
6. See student growth and withdrawal effects over time.
7. See fee collection rate with correct zero-fee handling.
8. See payroll trend without salary-history corruption.
9. See recognized rent impact rather than raw prepayment distortion.
10. See external cash movement without internal-transfer inflation.
11. Compare the selected period with the corresponding prior year.
12. See food revenue and, when Step 11 cost data exists, trustworthy food profitability.
13. View every currency separately.
14. Get figures that reconcile with the existing Step 8 accounting/reporting sources.
15. Pass the complete CI regression suite.

## 20. Non-goals

Step 13 does not add:

- forecasting
- budgets
- machine-learning predictions
- exchange-rate conversion
- KPI target editing
- custom dashboard builder
- restaurant-style recipe costing
- real-time websocket dashboards
- duplicated analytics ledger tables
- notification rules

Those can be considered later only if the core historical analytics remains trustworthy.

## 21. Integration constraint with Step 11 and Step 12

Step 12 notifications do not materially define Step 13 calculations and can be merged independently.

Step 11 food inventory is a real dependency for the cost side of food profitability.

Until the actual Step 11 schema is merged or otherwise available on the Step 13 integration branch:

- Step 13 must not guess Step 11 table or column names.
- Food revenue analytics may be implemented from Step 10.
- Food cost/profitability remains explicitly unavailable.
- Once Step 11 lands, Step 13 binds its food-cost analytics to the real Step 11 cost and waste records and extends verification accordingly.

This constraint prevents an apparently complete dashboard from presenting invented food-profit numbers.
