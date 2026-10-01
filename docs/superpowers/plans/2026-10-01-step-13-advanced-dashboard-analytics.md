# Step 13 Advanced Dashboard & Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `/analytics` workspace that compares terms and years and shows trustworthy monthly trends for enrollment, fees, accounting, payroll, rent, cash, expenses, and food revenue without creating duplicate financial truth.

**Architecture:** Add small PostgreSQL analytics functions over the existing Step 8 reporting/accounting sources, expose them through a typed server-side analytics helper, and render a dedicated Next.js server page with lightweight accessible chart/table components. Food-cost profitability remains explicitly unavailable until the real Step 11 purchasing/inventory cost schema exists; no guessed schema or cost model is permitted.

**Tech Stack:** PostgreSQL 17 SQL migrations, Node.js 22 verification scripts with `pg`, Next.js 16 App Router, React 19, TypeScript 6, existing CSS system.

**Spec:** `docs/superpowers/specs/2026-10-01-step-13-advanced-dashboard-analytics-design.md`

## Global Constraints

- Analytics is read-only and must never maintain editable copies of balances or totals.
- Reuse Step 8 posted-ledger and historical-date behavior rather than independently redefining accounting truth in React.
- Never add unlike currencies; monetary results remain grouped by currency.
- Percentages with a zero denominator return `null`, never `0`, `Infinity`, or `NaN`.
- `analytics.view` exposes aggregate payroll analytics only; Step 13 never returns employee names, employee numbers, salary agreements, payslips, or employee-level payroll rows.
- Rent impact uses recognized posted rent expense, not raw rent payments.
- Consolidated cash movement excludes internal school cash/bank transfers from external inflow/outflow.
- Food revenue may be shown from Step 10. Food cost/profitability must remain explicitly unavailable until trusted Step 11 cost data exists.
- No large charting dependency is added.
- Existing verification suites, TypeScript checking, and production build must remain green.

## Review Focus

- A selected range containing months with no transactions still returns continuous month rows with zero activity rather than skipping months; Task 1 tests this.
- An expected-fee denominator of zero produces a null collection rate and safe UI copy rather than 0%, 100%, NaN, or Infinity; Tasks 1 and 3 test this.
- Internal cash-to-bank transfers do not inflate consolidated inflow/outflow while still changing cash and bank closing balances correctly; Task 1 tests this.
- A later reversal changes only the reversal posting period and does not rewrite historical analytics before that posting date; Task 1 tests this.
- A user with `analytics.view` but without payroll-detail permission receives only aggregate payroll metrics and no employee-identifying data; Tasks 2 and 3 test the returned data shape and page content.

---

### Task 1: Analytics SQL contract and deterministic verification

**Files:**
- Create: `db/020_advanced_analytics.sql`
- Create: `scripts/verify-analytics.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `report_active_student_count(date)`, `report_profit_loss(date,date)`, `report_cash_bank_balances(date)`, `report_cash_flow(date,date)`, billing tables, payroll snapshots, accounting mappings, rental postings, and Step 10 food billing/accounting.
- Produces:
  - `analytics_monthly_financials(p_from date,p_to date)`
  - `analytics_monthly_students(p_from date,p_to date)`
  - `analytics_fee_collection(p_from date,p_to date)`
  - `analytics_expense_trend(p_from date,p_to date)`
  - `analytics_payroll_trend(p_from date,p_to date)`
  - `analytics_rent_trend(p_from date,p_to date)`
  - `analytics_cash_trend(p_from date,p_to date)`
  - `analytics_food_trend(p_from date,p_to date)`
  - `analytics_term_comparison(p_school_year_id uuid)`
  - `analytics_year_over_year(p_from date,p_to date)`
  - permission `analytics.view`

- [ ] **Step 1: Write the failing analytics verification script**

Create `scripts/verify-analytics.mjs` following the existing scratch-database verification pattern. The verification must build a two-school-year dataset and assert:

- continuous monthly rows including an empty month,
- active-student opening/closing counts and net growth,
- expected fees, collected fees, and null rate when expected fees are zero,
- income and expenses from posted entries only,
- expense totals by custom account,
- locked/paid aggregate payroll trend,
- recognized rent expense rather than prepaid cash amount,
- internal transfer exclusion from consolidated external cash flow,
- cash and bank closing balances,
- Step 10 food revenue with `cost_available=false` while Step 11 cost schema is absent,
- term comparison for Terms 1–3,
- same-relative-period prior-year values,
- historical stability before a later reversal posting date,
- separate rows for two currencies.

- [ ] **Step 2: Wire a temporary `verify:analytics` script and run it to verify RED**

Modify `package.json` to add `"verify:analytics": "node scripts/verify-analytics.mjs"`.

Run: `npm run verify:analytics`

Expected: FAIL because the analytics migration/functions do not exist.

- [ ] **Step 3: Implement `db/020_advanced_analytics.sql`**

Implement the permission plus focused SQL functions listed in the Interfaces block. Use `generate_series` for continuous months, existing Step 8 report functions for accounting truth where practical, stored payroll-run snapshots, configured accounting mappings for rent, and Step 10 food income postings/bills for food revenue.

`analytics_food_trend` must expose an explicit boolean `cost_available`. On the current base it returns food revenue and `false` with null cost/contribution fields because Step 11 has no trusted schema yet.

- [ ] **Step 4: Run analytics verification to GREEN**

Run: `npm run db:migrate && npm run verify:analytics`

Expected: PASS with all Step 13 deterministic assertions satisfied.

- [ ] **Step 5: Run the existing report/accounting verification suites**

Run: `npm run verify:accounting && npm run verify:reports && npm run verify:food`

Expected: all PASS.

- [ ] **Step 6: Commit Task 1**

Commit message: `Step 13: add analytics SQL and verification`

### Task 2: Typed server-side analytics data layer

**Files:**
- Create: `src/lib/analytics.ts`
- Create: `scripts/verify-analytics-contract.mjs` only if the existing TypeScript/runtime test setup cannot directly exercise the helper; otherwise keep contract assertions in `verify-analytics.mjs`.

**Interfaces:**
- Consumes: Task 1 SQL functions and `@/lib/db`.
- Produces:
  - `type AnalyticsPeriod`
  - `type AnalyticsBundle`
  - `resolveAnalyticsPeriod(searchParams): Promise<AnalyticsPeriod>`
  - `loadAnalytics(period: AnalyticsPeriod): Promise<AnalyticsBundle>`
  - DTOs containing only aggregate payroll fields.

- [ ] **Step 1: Add a failing contract assertion for period normalization and aggregate-only payroll shape**

Assert that invalid/custom date inputs do not produce reversed ranges, school-year/term selection resolves to configured dates, zero-rate fields remain null, and no analytics DTO contains employee-identifying keys such as `employee_name`, `employee_number`, `salary_agreement_id`, or `payslip`.

- [ ] **Step 2: Run the contract check to verify RED**

Run the narrow analytics contract command defined by the implementation.

Expected: FAIL because `src/lib/analytics.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/analytics.ts`**

Keep database aggregation in SQL. This file validates selector inputs, resolves school year/term/custom ranges, calls independent analytics queries in parallel, converts numeric text safely, and returns display-ready DTOs without recomputing ledger formulas.

- [ ] **Step 4: Run the contract check and `npm run typecheck`**

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Commit message: `Step 13: add typed analytics data layer`

### Task 3: Advanced analytics page and accessible visual components

**Files:**
- Create: `src/app/analytics/page.tsx`
- Create: `src/app/analytics/components.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `resolveAnalyticsPeriod()`, `loadAnalytics()`, existing `requireUser()`, and `analytics.view`.
- Produces: authenticated `/analytics` page with selectors, KPI cards, term comparison, monthly financial trends, expense trends, student growth, fee collection, food status/profitability, payroll trend, rent impact, cash movement, and year-over-year comparison.

- [ ] **Step 1: Add a failing page/build contract check**

Add assertions in the analytics verification/contract script that the page module exists, checks `analytics.view`, contains all ten required sections, renders “No fees due” for null collection rates, renders “Cost data unavailable” when `cost_available=false`, and contains no employee-identifying payroll columns.

- [ ] **Step 2: Run the page contract to verify RED**

Expected: FAIL because the analytics route/components do not exist.

- [ ] **Step 3: Implement lightweight analytics components**

Create reusable server-renderable components for metric cards, grouped money values, compact bar/line-style SVG or CSS visualizations, accessible labels, and companion numeric tables. Avoid client-side financial math and avoid adding a chart library.

- [ ] **Step 4: Implement `/analytics`**

Require `analytics.view` server-side. Render the school-year/term/custom range selectors and all ten sections from the Task 2 bundle. Separate currencies visually and show explicit empty/unavailable states.

- [ ] **Step 5: Add responsive/print-safe styles**

Extend `globals.css` only with focused analytics classes. Existing report/dashboard styles must not regress.

- [ ] **Step 6: Run page contract, typecheck, and production build**

Run: analytics contract command, `npm run typecheck`, `npm run build`

Expected: all PASS.

- [ ] **Step 7: Commit Task 3**

Commit message: `Step 13: build advanced analytics workspace`

### Task 4: Navigation, documentation, CI, and permission integration

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/app/reports/page.tsx`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `docs/STEP13_ANALYTICS.md`

**Interfaces:**
- Consumes: `analytics.view`, `/analytics`, and `verify:analytics`.
- Produces: authorized navigation entry points, CI coverage, and operator/developer documentation.

- [ ] **Step 1: Extend the analytics contract check to require navigation and CI wiring**

Assert that authorized dashboard/reports code links to `/analytics`, CI runs `npm run verify:analytics`, and package.json exposes the script.

- [ ] **Step 2: Run the contract to verify RED**

Expected: FAIL on missing navigation/CI documentation wiring.

- [ ] **Step 3: Add permission-aware links and CI step**

Show the analytics link only to users with `analytics.view`. Add `npm run verify:analytics` after the source-module verification steps and before typecheck/build.

- [ ] **Step 4: Document Step 13**

Document metric definitions, currency behavior, selectors, permission behavior, Step 11 food-cost dependency, and verification command in `docs/STEP13_ANALYTICS.md`; add a concise README Step 13 summary.

- [ ] **Step 5: Run the contract, typecheck, and build**

Expected: all PASS.

- [ ] **Step 6: Commit Task 4**

Commit message: `Step 13: integrate analytics navigation and CI`

### Task 5: Full regression verification and Step 11 integration gate

**Files:**
- Modify only files required by defects discovered during verification, with a failing regression assertion before each production fix.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: a release-ready Step 13 branch except for food-cost profitability if Step 11 still lacks a trusted cost schema.

- [ ] **Step 1: Re-check the live `step-11-food-inventory` branch**

If the branch now contains a real inventory/purchasing migration with trustworthy cost/waste records, integrate those exact interfaces into `analytics_food_trend` and extend `verify-analytics.mjs` with RED→GREEN food-cost/contribution assertions.

If it still lacks that schema, record a ruling that Step 13 ships food revenue plus explicit cost-unavailable state, as required by the approved spec. Do not guess table names.

- [ ] **Step 2: Run every repository verification command**

Run:

`node scripts/verify-foundation.mjs`  
`npm run verify:students`  
`npm run verify:billing`  
`npm run verify:accounting`  
`npm run verify:operations`  
`npm run verify:rentals`  
`npm run verify:payroll`  
`npm run verify:reports`  
`npm run verify:food`  
`npm run verify:analytics`

Also run Step 11/12 verification commands if their migrations have been merged into the branch by this point.

Expected: all available suites PASS.

- [ ] **Step 3: Run final compiler/build verification**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0.

- [ ] **Step 4: Perform whole-branch review**

Review the diff from the branch fork point to HEAD against the spec, this plan, and the five Review Focus conditions. Any Critical/Important finding requires a failing regression assertion before its fix and another full-suite run.

- [ ] **Step 5: Commit any verified review fixes**

Commit message: `Step 13: harden advanced analytics`

- [ ] **Step 6: Re-run final verification on the exact final tree**

Run the full suite from Step 2 plus typecheck/build again.

Expected: zero failures.

