# Montikids Montessori Preschool & Nursery

Management system for Montikids Montessori Preschool & Nursery.

## Step 1 — Foundation & Security

Implemented:

- School profile and timezone
- School years with automatic fixed terms: September–December, January–March, April–June
- Multiple users
- Roles and fine-grained permissions
- Database-backed login sessions and logout
- Password policy, login throttling/temporary lockout, and session revocation
- Append-only audit log for privileged changes and authentication events
- Core regional settings: currency, number locale, timezone
- Document numbering prefixes and counters
- Local file/document storage abstraction with database metadata
- PostgreSQL backup script and documented restore strategy

## Stack

- Next.js 16 / React 19 / TypeScript
- PostgreSQL
- `pg` with explicit SQL migrations
- `bcryptjs` for password hashing

## Local setup

1. Copy environment variables with `cp .env.example .env`.
2. Start PostgreSQL with `docker compose up -d`.
3. Run `npm install` and `npm run db:migrate`.
4. Create the bootstrap administrator:

```bash
npm run db:seed-admin -- --email=admin@example.com --name="School Administrator" --password="<secure-password>"
```

5. Run `npm run dev` and open `http://localhost:3000`.

## Security rules

- Passwords require at least 12 characters, uppercase, lowercase, and a number.
- bcrypt's 72-byte input limit is enforced instead of silently truncating passwords.
- Five consecutive failed attempts trigger a 15-minute lockout.
- Session tokens are random and only SHA-256 token hashes are stored in PostgreSQL.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- UI visibility is not treated as authorization. Every protected server action re-checks its permission.
- Disabling a user revokes active sessions.
- Changing a password revokes all other sessions.
- The built-in Administrator role is migration-controlled and cannot be weakened in the UI.
- Sensitive mutations are written to `audit_log`.

## Backups

See [docs/BACKUPS.md](docs/BACKUPS.md). Production requires an off-site encrypted copy and periodic restore drills.


## Step 2 — Families, Students & Enrollment

Implemented:

- Families with generated family numbers
- Parents/guardians linked to families, including primary guardian, custody, and pickup flags
- Students with generated student numbers and lifecycle statuses
- Sibling relationships derived from shared family membership
- Family-level or student-specific emergency contacts
- Classes scoped to school years with optional capacity limits
- School-year enrollment plus explicit term enrollment
- Mid-term enrollment using the student's actual start date
- Withdrawal that closes enrollment without deleting the student or prior enrollment data
- Student document upload/download using the existing protected storage layer
- Append-only student history for creation, enrollment, withdrawal, status changes, and documents
- Fine-grained Step 2 permissions, automatically granted to the built-in Administrator role
- CI verification of the Milestone 2 family → parent → two siblings → Term 1 flow

The Step 2 workspace is available at `/students` to authorized users.


## Step 3 — Fees, Discounts & Billing

Implemented:

- Standard nursery fee schedules by school year term
- One active fee schedule per term, while retaining prior schedule history
- Built-in sibling discount at 10%
- Built-in teacher-child discount at 50%
- Percentage, fixed-amount, and custom discounts
- Explicit discount request, approval, rejection, revocation, and append-only history
- Configurable combined-discount behavior with a hard total-discount cap
- Term invoice generation from enrolled students and the active term fee schedule
- Immutable invoice discount snapshots so later rule changes never rewrite historical invoices
- Additional charges before invoice issue
- Invoice states: draft, issued, partially paid, paid, and void
- Partial payments and invoice allocations
- Prepayments and overpayments retained as unapplied family funds
- Credit notes, credit allocation, and reversals
- Family and student ledgers
- Fine-grained billing, discount, approval, and payment permissions
- CI verification for Milestone 3

### Combined-discount rule

The rule is explicit in `billing_configuration.discount_combination_mode`:

- `best_single` (default): only the largest monetary discount applies. Teacher-child 50% + sibling 10% = 50% total.
- `additive`: percentage discounts are each calculated from the original nursery fee and added. 50% + 10% = 60% total.
- `sequential`: discounts apply by priority to the remaining balance. 50% then 10% = 55% effective total.

The total discount is also capped by `max_discount_percent` (default 100%). Discounts apply to the standard nursery-fee line only; additional charges are not discounted automatically.

### Billing integrity rules

Issued invoice lines and their discount snapshots are immutable. Corrections after issue use credit notes rather than editing history. Payment and credit allocations are immutable; an incorrect posted payment or credit note is reversed and re-entered. Unallocated payment value remains visible as a prepayment, overpayment, or unapplied family payment.

The Step 3 workspace is available at `/billing` to authorized users.


## Step 4 — Accounting Core

Implemented:

- Five accounting categories: assets, liabilities, equity/net position, income, and expenses
- Custom account types inside those categories
- Fully user-defined chart of accounts with custom codes and names
- Parent accounts and subaccounts with category-consistency and cycle protection
- Posting/non-posting header accounts
- User-defined journals plus an explicit automatic billing journal
- Accounting periods with overlap prevention, locking, and audited reopening
- Draft and posted journal entries
- Manual journal entries with transaction references and explicit posting dates
- Opening-balance workflow
- Receipt, expense, and transfer workflows
- Double-entry posting engine that requires total debit to equal total credit exactly
- Immutable posted journal lines
- Reversing journal entries instead of destructive edits
- General ledger with running normal-balance totals
- Trial balance
- Account balances and financial-position reporting
- Assets, liabilities, equity, income, expenses, current surplus, and net position
- Configurable Step 3 billing-to-accounting mappings
- Automatic accounting for invoice issue, payments, payment allocations, credit notes, credit allocations, and their reversals
- Fine-grained accounting permissions
- CI verification for Milestone 4

### User-defined accounting

Montikids does not force account names such as "Bank" or "Tuition Income." Users create their own accounts and hierarchy. The accounting engine only requires structural categories so debit/credit behavior and reporting remain correct.

Automatic billing uses four explicit account-role mappings:

- Accounts Receivable — asset
- Billing Income — income
- Customer Deposits — liability
- Payment Asset — asset

An explicit billing journal must also be selected. This avoids hidden choices when multiple journals or bank/cash accounts exist.

### Billing accounting flow

When an invoice is issued:

- Debit Accounts Receivable
- Credit Billing Income

When a payment is received:

- Debit Payment Asset
- Credit Customer Deposits

When payment funds are allocated to an invoice:

- Debit Customer Deposits
- Credit Accounts Receivable

This design means prepayments and overpayments remain correctly represented as liabilities until they are applied.

When a credit note is issued:

- Debit Billing Income
- Credit Customer Deposits

When that credit is allocated:

- Debit Customer Deposits
- Credit Accounts Receivable

Payment and credit-note reversals create reversing journal entries; they do not rewrite posted accounting history.

### Milestone 4 reconciliation

CI builds a tiny company using custom accounts and posts:

- 10,000.00 opening bank balance
- 1,000.00 receipt
- 200.00 expense
- 500.00 transfer between bank accounts

Expected result:

- Operating Bank: 10,300.00
- Reserve Bank: 500.00
- Total assets: 10,800.00
- Opening equity: 10,000.00
- Income: 1,000.00
- Expenses: 200.00
- Current surplus: 800.00
- Net position: 10,800.00
- Trial balance debit balances: 11,000.00
- Trial balance credit balances: 11,000.00
- Accounting equation difference: 0.00

The Step 4 workspace is available at `/accounting` to authorized users.

## Step 6 — Rentals

Implemented:

- Landlord profiles with contact, tax, address, notes, and active/inactive status
- Rental agreements with start/end dates, recurring amount, currency, frequency, due day, refundable deposit, reference, and notes
- Deterministic rent schedules generated when a draft agreement is activated
- Immutable activated financial terms so historical rental accounting cannot be rewritten
- Rent and deposit payments from configured cash/bank accounts
- Automatic allocation of rent payments to the oldest outstanding schedule periods
- Correct separation of prepaid rent, recognized rent expense, and rent payable
- Refundable rent deposits held as assets rather than rent expense
- Month-end rent recognition for one period or all ended periods through a selected date
- Payment reversals, including safe reclassification when already-consumed prepaid rent is reversed
- Rent-recognition reversals with accounting safeguards
- Rental attachments using the protected document-storage layer
- Append-only rent history for agreements, activation, payments, recognition, reversals, deposits, and attachments
- Fine-grained rental and rental-document permissions
- A dedicated Rentals accounting journal and explicit account-role mappings
- CI verification for Milestone 6 and the rental accounting edge cases

### Rental accounting flow

Rental accounting uses four explicit user-configured account roles:

- Rent Expense — expense
- Prepaid Rent — asset
- Rent Payable — liability
- Rent Deposit — asset

For prepaid rent, a payment does **not** create the full rent expense immediately.

A 12,000 payment covering six monthly periods posts initially as:

- Debit Prepaid Rent 12,000
- Credit Cash/Bank 12,000

Each month-end recognition posts:

- Debit Rent Expense 2,000
- Credit Prepaid Rent 2,000

If a period is recognized before it is paid:

- Debit Rent Expense
- Credit Rent Payable

The later payment then posts:

- Debit Rent Payable
- Credit Cash/Bank

Refundable deposits post to Rent Deposit instead of Rent Expense.

### Milestone 6 verification

CI creates a six-month rental agreement at 2,000 per month, prepays 12,000, and simulates all six month-end periods. It verifies:

- Initial prepaid rent: 12,000.00
- Initial rent expense: 0.00
- Monthly recognition: 2,000.00
- Final prepaid rent after six periods: 0.00
- Final recognized rent expense: 12,000.00
- Rent payable for the fully prepaid agreement: 0.00
- Trial balance remains balanced

The verification also covers unpaid rent becoming Rent Payable, later payment clearing that payable, refundable deposits, payment reversals, recognition reversals, protected attachments, immutable activated terms, and append-only rental history.

The Step 6 workspace is available at `/rentals` to authorized users.

## Step 7 — Employees, Payroll & Salary Advances

Implemented:

- Employee records and job-title maintenance
- Append-only salary agreements with effective dates and derived salary history periods
- Monthly salary snapshots copied into each payroll run
- Allowances, bonuses, and deductions while payroll is still draft
- Salary advances paid from configured cash/bank accounts
- Immutable monthly advance repayment schedules
- Automatic application of all due advance installments when payroll is locked
- Payroll runs with draft, pending, approved, locked, and paid states
- Separate submit, approval, lock, and payment permissions
- Locked payroll snapshots that cannot be rewritten after posting
- Printable/viewable payslips generated from locked payroll data
- Salary Payable accounting and payroll expense posting
- Payroll payments from configured cash/bank accounts
- Payroll payment reversals that reopen the run only to the locked state
- Employee payroll ledger combining salary advances, payroll, repayments, payable, and paid salary
- Payroll summary reporting
- Fine-grained permissions for employees, payroll, approvals, locking, payments, and advances
- CI verification for the complete Milestone 7 scenario

### Salary history rule

Salary history is append-only. Existing salary agreements cannot be updated or deleted.

If an employee changes from 800 per month to 1,000 per month, the system stores two effective salary agreements. The earlier 800 agreement remains part of history, while the later 1,000 agreement becomes effective from its own start date. Payroll runs store the exact salary-agreement snapshot they used, so later raises never rewrite older payroll.

### Payroll accounting flow

Payroll uses three explicit user-configured account roles:

- Payroll Expense — expense
- Salary Payable — liability
- Salary Advances — asset

Issuing a salary advance posts:

- Debit Salary Advances
- Credit Cash/Bank

Locking payroll posts the salary cost and the employee liabilities. Allowances and bonuses increase gross payroll; ordinary payroll deductions reduce payroll expense; due salary-advance repayments reduce the Salary Advances asset; the remaining employee net pay becomes Salary Payable.

Paying the locked payroll posts:

- Debit Salary Payable
- Credit Cash/Bank

Posted payroll journals are never edited. Payment reversals create reversing journal entries and return the payroll run to the locked state so it can be paid again correctly.

### Milestone 7 verification

CI creates multiple employees and verifies a salary change from 800 to 1,000 without losing the original salary period. It then runs September and October payroll scenarios including:

- Normal salary
- Allowance
- Bonus
- Deduction
- Two separate salary advances
- Two advance repayments applied in the same payroll run
- Payroll submission and approval
- Payroll locking
- Salary Payable
- Bank payment
- Employee payroll ledger
- Payroll summary
- Balanced general ledger

The October milestone expects:

- Gross payroll: 3,000.00
- Deductions: 100.00
- Payroll expense: 2,900.00
- Salary-advance repayments: 250.00
- Net Salary Payable/payment: 2,650.00
- Salary Payable after payment: 0.00
- Remaining salary advances: 250.00

The Step 7 workspace is available at \`/payroll\` to authorized users. Locked payroll items expose payslips under \`/payroll/payslips/[id]\`.

## Step 8 — Net Position, Management & Reports

Implemented:

- Management dashboard for active students, fees due, collected tuition, outstanding receivables, cash, bank, expenses, rent due, payroll due, prepayments, and net position
- Date-range reporting with historical as-of balances so later transactions do not rewrite earlier reports
- Currency-aware reporting that never adds unrelated currencies into one total
- General Ledger with account running balances
- Trial Balance as of any selected date
- Profit & Loss for any selected period
- Balance Sheet / Net Position with an accounting-equation control
- Direct Cash Flow based on posted cash and bank journal movements
- Accounts Receivable and Accounts Payable as-of reports
- Expense and income reports
- Student, family, enrollment, fee, discount, outstanding-balance, and prepayment reports
- Salary history, payroll-run, employee-cost, and salary-advance reports from the Step 7 payroll ledger
- Printable invoices, payment receipts, family statements, payslips, expense vouchers, and supplier statements
- Permission-controlled CSV exports with spreadsheet-formula protection
- Dedicated management/report permissions automatically granted to the built-in Administrator role
- CI reconciliation for the October 2026 Milestone 8 sample period

### Reporting integrity rules

Financial reports read posted and reversed journal entries; draft journals never enter management totals. Balance reports are computed **as of** the selected end date, while Profit & Loss and cash flow use the selected date range. Student receivables, supplier payables, parent credits, rent payable, and salary payable are derived from the source ledgers and posted accounting rather than maintained as duplicate management balances.

All financial totals remain separated by currency. The management layer does not invent a converted grand total unless an explicit exchange-rate system is added later.

Historical snapshots are protected from later administrative changes: active-student counts use the actual term-enrollment window rather than today's student/enrollment status, deactivated cash or bank accounts remain visible in prior-period balances, and reversed source records use the accounting reversal posting date when deciding which period the reversal affects.

“Expected fees” means issued invoice amounts due inside the selected period. “Collected fees” means parent payments received inside the selected period and allocated to invoices by the report end date. Unallocated parent money stays visible separately as prepayments, so it is not double-counted as tuition collected.

### Milestone 8 — October 2026 reconciliation

CI builds an independent October 2026 sample period and checks the management reports against known manual totals. On the complete Step 7 + Step 8 stack it verifies:

- Active students: 2
- Expected fees due: USD 2,000.00
- Collected fees allocated to invoices: USD 1,400.00
- Student receivables: USD 600.00
- Parent prepayment: USD 100.00
- Bank: USD 1,100.00
- Cash: USD 100.00
- Rent due: USD 500.00
- Payroll due: USD 700.00
- Total expenses: USD 1,500.00
- Income: USD 2,000.00
- Assets: USD 1,800.00
- Liabilities: USD 1,300.00
- Current surplus / net position: USD 500.00
- Trial balance debits: USD 3,300.00
- Trial balance credits: USD 3,300.00
- Accounting equation difference: USD 0.00
- Net cash movement: USD 1,200.00

The Step 8 workspace is available at `/reports` to authorized users.



## Release 1 hardening

Release 1 now has an adversarial pre-launch gate. Run the normal verification chain plus the dedicated hardening checks before using Montikids with real operational data:

```bash
npm run verify:release
npm run verify:backup-restore
npm run release:gate -- --through=YYYY-MM-DD
```

The release gate must report zero difference for student receivables, family credits, supplier payables, cash, bank, payroll accounting, net position, and the trial balance. Closed school terms reject new academic and billing activity at the database layer while preserving settlement, reversal, and historical reporting.

See `docs/RELEASE1_HARDENING.md` for the complete launch procedure and operator UAT checklist.


## Release 2 — Step 10: Food packages & student food billing

Step 10 adds an operational food module without weakening the Release 1 tuition invoice rules. Food bills are separate documents, but they share the same family/student financial ecosystem.

Included:

- Food item catalog with dated, non-overlapping price history.
- Daily, weekly, monthly, and term food packages.
- Immutable activated package pricing and package contents.
- Term-aware student food selections with package-price snapshots.
- Draft/issue/void food bills with immutable issued lines.
- Normal school payment receipts for food collections.
- Allocation of existing parent payments/prepayments and transferable family credits to food bills.
- Combined allocation controls so the same parent funds cannot be spent twice across tuition and food.
- Food Income accounting mapping with automatic Accounts Receivable posting.
- Food activity in family/student ledgers, receivables reporting, family-credit reporting, and the Release 1 reconciliation gate.
- Closed-term protection, audit logging, fine-grained permissions, and CI verification.

Run the Step 10 verification after migrations:

~~~bash
npm run db:migrate
npm run verify:food
~~~

The food workspace is available at \`/food\` to authorized users. Before issuing the first food bill, configure the \`food_income\` accounting mapping. The existing billing journal and Accounts Receivable / Customer Deposits mappings remain the control accounts for student financial activity.


## Step 12 — Notifications & Automation

Implemented:

- Fee due notices and separate overdue/outstanding fee alerts sourced from live invoice balances
- Rent-due alerts sourced from rental schedules and outstanding rent
- Supplier-payment reminders sourced from posted supplier invoice balances
- Payroll reminders based on payroll pay dates and payment status
- Term-start reminders based on the school-year calendar
- Low-food-inventory integration without duplicating inventory balances
- Rental-contract expiry reminders
- Employee-document expiry tracking and reminders
- Configurable lead times, severity, and enable/disable controls
- Deduplicated notification lifecycle with open, snoozed, acknowledged, dismissed, and automatically resolved states
- Same-day source-condition resolution on the next automation run
- Permission-controlled Notification Center at `/notifications`
- Manual refresh, protected HTTP automation endpoint, and command-line scheduler runner
- CI verification for notification generation, idempotency, resolution, permissions, and inventory integration compatibility

Notifications are derived from the existing operational records rather than storing a second financial truth. The automation runner can be scheduled with `npm run notifications:run`, or an external scheduler can POST to `/api/automation/notifications` using the configured `AUTOMATION_SECRET`.

Step 11 inventory remains the owner of stock quantities. Step 12 consumes the optional `inventory_low_stock_notification_source` view when it exists, so low-stock alerts activate without coupling the notification engine to an unfinished or duplicate inventory model.

See [docs/STEP12_NOTIFICATIONS.md](docs/STEP12_NOTIFICATIONS.md) for deployment, scheduling, lifecycle, and inventory-integration details.
