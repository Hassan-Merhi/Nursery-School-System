# UI / usability audit — October 2026

Goal: make the system feel modern and obvious to use for non-technical staff
(front desk, teachers, accountant) without changing any business logic.

## What was wrong

| # | Problem | Where | Impact |
|---|---------|-------|--------|
| 1 | **No shared navigation.** Each page hand-built its own row of link buttons, with different labels ("Foundation dashboard", "Administration", "Dashboard") and different destinations. | every page | Users got lost; some pages were only reachable from one other page. |
| 2 | **"Dashboard" was not a dashboard.** It was the admin screen ("Foundation & Security"): school profile, roles, permissions, audit log. | `/dashboard` | The first thing every user saw was configuration they can't use. |
| 3 | **Developer jargon in the UI.** "Step 4 asset accounts", "Release 2 · Step 10", "Milestone 3", "80 permissions active", "Append-only events", and raw keys like `billing.manage`. | most pages | Confusing; looked unfinished. |
| 4 | **CI test notes shown to users.** Panels like "Three-child manual balance test", "Tiny-company reconciliation", and "Release 1 controls stay authoritative" described automated tests. | billing, accounting, food, inventory, students | Noise at the bottom of real screens. |
| 5 | **No dark / light mode**, and colors were hardcoded hex values, so a theme couldn't be added cleanly. | `globals.css` | — |
| 6 | **Very long pages with no way to jump around.** Billing alone has 9 sections of forms. | billing, accounting, operations, students… | Lots of scrolling to find one form. |
| 7 | **Dated look:** Arial, heavy bold labels, wrapping pill buttons, tables without header styling. | global | — |
| 8 | Duplicate React `key` on the billing ledger once headings got anchors (found while testing). | billing | Console error. |

## What was changed (this branch)

1. **App shell with a sidebar** (`src/components/AppShell.tsx`, `nav.ts`).
   - Grouped menu: *Daily work*, *Money & staff*, *Insights*, *Admin*, with an icon for each item.
   - Items only appear if the user's role can open that area (same permission
     lists the old dashboard used).
   - Current page is highlighted. On phones the sidebar becomes a slide-out **Menu**.
   - The signed-in user and **Sign out** sit at the bottom of the sidebar.
2. **New Home page** (`/dashboard`): greeting, headline numbers (active
   children, families, overdue invoices, open alerts), big **"What do you want
   to do?"** buttons that jump straight to the right form, the top 5 alerts,
   and a grid of all sections.
3. **Settings page** (`/settings`): the old admin screen moved here, with plain
   headings, short explanations, and readable permission names (the
   description first, the technical key underneath).
4. **Dark / light / auto theme.** A toggle in the top bar remembers the choice;
   *Auto* follows the device. The page never flashes the wrong theme on load.
   Printing (receipts, payslips, reports) always uses light colors.
5. **New design system** in `globals.css`: color tokens, system font, softer
   cards, styled tables, clear focus rings, consistent buttons and inputs. All
   existing class names were kept, so every page picked up the new look.
6. **"Jump to" bar** on long pages, built automatically from the section
   headings (`PageSections.tsx`).
7. **Plain-English page titles and descriptions** on every module. Removed the
   jargon and the CI test-note panels.
8. Friendlier sign-in and "no access" pages.

No database, server action, or permission logic changed (except that
admin-screen actions now redirect to `/settings`). Checks that passed:
`tsc`, `next build`, `verify-foundation`, `verify:students`, `verify:analytics`.

## Recommended next steps (not done yet)

Ordered by how much they help everyday users:

1. **Global search** in the top bar (child, family, invoice or receipt number).
   This is the single biggest time-saver for front-desk staff.
2. **Split each module into "Daily" and "Setup" tabs.** Setup panels such as the
   discount policy, account mappings, "posting configuration", and inventory
   mappings are set once, but today they sit above the daily forms. Billing
   currently *opens* on the discount policy.
3. **"Add" forms as focused steps or dialogs** instead of always-open forms
   stacked down the page (e.g. *Add family → add parent → add child → enroll*).
4. **Human-readable statuses and values.** Some still show raw values
   (`partially_paid`, ids in the activity log, accounting terms like "Customer
   Deposits"). Add a shared `label()` helper and short help text.
5. **Confirm before destructive actions** (void invoice, withdraw student,
   close term, reverse payment).
6. **Empty states** with a next step ("No families yet — Add your first family").
7. **Read the school name from the school profile** instead of the hardcoded
   "Montikids" in the shell and Home.
8. **Code health:** several pages (food, payroll, inventory, operations) are
   written as very long single-line JSX. Splitting them into small components
   would make the steps above much easier.
