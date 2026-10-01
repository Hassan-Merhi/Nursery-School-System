import Link from "next/link";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import {
  createAccountAction,
  createAccountingPeriodAction,
  createAccountTypeAction,
  createJournalAction,
  createManualJournalAction,
  createOpeningBalanceAction,
  postDraftJournalAction,
  recordAccountingReceiptAction,
  recordExpenseAction,
  recordTransferAction,
  reverseJournalAction,
  setAccountingPeriodStatusAction,
  updateAccountingMappingAction,
  updateAccountStatusAction,
} from "./actions";

type Row = Record<string, any>;

function moneyLabel(amount: unknown, currency = "USD") {
  const numeric = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(numeric) ? numeric : 0);
  } catch {
    return `${currency} ${(Number.isFinite(numeric) ? numeric : 0).toFixed(2)}`;
  }
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);
  const allowed = [
    "accounting.view",
    "accounting.manage",
    "accounting.post",
    "accounting.period_lock",
    "accounting.mapping",
  ].some(can);
  if (!allowed) redirect("/forbidden");

  const today =
    (
      await query<{ today: string }>(
        "select (now() at time zone 'Asia/Beirut')::date::text as today",
      )
    ).rows[0]?.today ?? "";

  const currencySetting =
    (
      await query<{ currency: string | null }>(
        "select value #>> '{}' as currency from app_setting where key='currency'",
      )
    ).rows[0]?.currency ?? "USD";

  const accountTypes = (
    await query<Row>(
      `select id,code,name,category,is_system,is_active
       from account_type
       order by
         case category
           when 'asset' then 1 when 'liability' then 2 when 'equity' then 3
           when 'income' then 4 else 5
         end,name`,
    )
  ).rows;

  const accounts = (
    await query<Row>(
      `select a.id,a.code,a.name,a.parent_account_id,a.currency,a.allow_posting,a.status,
         a.notes,t.id as account_type_id,t.name as account_type_name,t.category,
         p.code as parent_code,p.name as parent_name,
         coalesce(b.normal_balance,0)::numeric(14,2)::text as normal_balance
       from account a
       join account_type t on t.id=a.account_type_id
       left join account p on p.id=a.parent_account_id
       left join account_balance b on b.account_id=a.id
       order by t.category,a.code,a.name`,
    )
  ).rows;

  const periods = (
    await query<Row>(
      `select p.*,u.full_name as locked_by_name
       from accounting_period p
       left join app_user u on u.id=p.locked_by
       order by p.starts_on desc`,
    )
  ).rows;

  const journals = (
    await query<Row>(
      `select id,code,name,description,status
       from journal
       order by status,code`,
    )
  ).rows;

  const mappingRoles = (
    await query<Row>(
      `select d.role_key,d.name,d.description,d.required_category,
         m.account_id,a.code as account_code,a.name as account_name
       from accounting_role_definition d
       left join accounting_mapping m on m.role_key=d.role_key
       left join account a on a.id=m.account_id
       order by d.role_key`,
    )
  ).rows;

  const entries =
    can("accounting.view") || can("accounting.post")
      ? (
          await query<Row>(
            `select je.id,je.entry_number,je.entry_kind,je.posting_date,je.currency,
               je.description,je.transaction_reference,je.source_type,je.status,
               je.reversal_of_entry_id,je.reversed_by_entry_id,je.reversal_reason,
               je.created_at,je.posted_at,j.code as journal_code,j.name as journal_name,
               creator.full_name as created_by_name,poster.full_name as posted_by_name,
               coalesce(sum(jl.debit),0)::numeric(14,2)::text as total_debit,
               coalesce(sum(jl.credit),0)::numeric(14,2)::text as total_credit
             from journal_entry je
             join journal j on j.id=je.journal_id
             left join journal_line jl on jl.journal_entry_id=je.id
             left join app_user creator on creator.id=je.created_by
             left join app_user poster on poster.id=je.posted_by
             group by je.id,j.id,creator.full_name,poster.full_name
             order by je.posting_date desc,je.created_at desc
             limit 200`,
          )
        ).rows
      : [];

  const entryLines =
    entries.length
      ? (
          await query<Row>(
            `select jl.*,a.code as account_code,a.name as account_name
             from journal_line jl
             join account a on a.id=jl.account_id
             where jl.journal_entry_id=any($1::uuid[])
             order by jl.journal_entry_id,jl.line_number`,
            [entries.map((entry) => entry.id)],
          )
        ).rows
      : [];

  const ledger =
    can("accounting.view")
      ? (
          await query<Row>(
            `select gl.*,f.family_number,
               case when gl.student_id is not null
                 then concat_ws(' ',s.first_name,s.last_name)
                 else null
               end as student_name
             from general_ledger gl
             left join family f on f.id=gl.family_id
             left join student s on s.id=gl.student_id
             order by gl.posting_date desc,gl.entry_number desc,gl.line_number
             limit 500`,
          )
        ).rows
      : [];

  const trialBalance =
    can("accounting.view")
      ? (
          await query<Row>(
            `select *
             from trial_balance
             where total_debit<>0 or total_credit<>0
             order by account_code,account_name`,
          )
        ).rows
      : [];

  const position =
    can("accounting.view")
      ? (await query<Row>("select * from accounting_position")).rows[0]
      : null;

  const linesByEntry = new Map<string, Row[]>();
  for (const line of entryLines) {
    const list = linesByEntry.get(line.journal_entry_id) ?? [];
    list.push(line);
    linesByEntry.set(line.journal_entry_id, list);
  }

  const activePostingAccounts = accounts.filter(
    (account) => account.status === "active" && account.allow_posting,
  );
  const activeJournals = journals.filter((journal) => journal.status === "active");
  const expenseAccounts = activePostingAccounts.filter((account) => account.category === "expense");
  const assetAccounts = activePostingAccounts.filter((account) => account.category === "asset");

  const trialDebit = trialBalance.reduce((sum, row) => sum + Number(row.debit_balance), 0);
  const trialCredit = trialBalance.reduce((sum, row) => sum + Number(row.credit_balance), 0);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
          <h1>Accounting Core</h1>
          <p className="muted">
            Double-entry accounting with a custom chart of accounts, period controls, posting, reversals, and reconciled reporting.
          </p>
        </div>
        <div className="top-actions">
          <Link className="button-link secondary-link" href="/billing">Fees & billing</Link>
          <Link className="button-link secondary-link" href="/dashboard">Foundation dashboard</Link>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      {position ? (
        <section className="status-grid">
          <article className="panel">
            <p className="eyebrow">Assets</p>
            <h2>{moneyLabel(position.assets, currencySetting)}</h2>
            <p className="muted">Debit-normal asset balances.</p>
          </article>
          <article className="panel">
            <p className="eyebrow">Liabilities</p>
            <h2>{moneyLabel(position.liabilities, currencySetting)}</h2>
            <p className="muted">Credit-normal liability balances.</p>
          </article>
          <article className="panel">
            <p className="eyebrow">Net position</p>
            <h2>{moneyLabel(position.net_position, currencySetting)}</h2>
            <p className="muted">
              Assets − liabilities. Equation difference: {moneyLabel(position.equation_difference, currencySetting)}.
            </p>
          </article>
        </section>
      ) : null}

      {can("accounting.manage") || can("accounting.period_lock") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Posting control</p>
              <h2>Accounting periods</h2>
              <p className="muted">Every posting date must fall inside an open, non-overlapping period.</p>
            </div>
          </div>
          {can("accounting.manage") ? (
            <form action={createAccountingPeriodAction} className="form-grid create-box">
              <label>Period name<input name="name" placeholder="2026–2027" required /></label>
              <label>Starts on<input name="starts_on" type="date" required /></label>
              <label>Ends on<input name="ends_on" type="date" required /></label>
              <button type="submit">Create open period</button>
            </form>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Period</th><th>Dates</th><th>Status</th><th>Lock details</th><th /></tr></thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.id}>
                    <td>{period.name}</td>
                    <td>{period.starts_on} → {period.ends_on}</td>
                    <td><span className="badge">{period.status}</span></td>
                    <td>{period.locked_by_name ? `${period.locked_by_name} · ${period.lock_note ?? ""}` : "—"}</td>
                    <td>
                      {can("accounting.period_lock") ? (
                        <form action={setAccountingPeriodStatusAction} className="inline-form compact-form">
                          <input type="hidden" name="period_id" value={period.id} />
                          <input type="hidden" name="status" value={period.status === "open" ? "locked" : "open"} />
                          {period.status === "open" ? <label>Lock note<input name="note" required /></label> : null}
                          <button type="submit" className="secondary">
                            {period.status === "open" ? "Lock period" : "Reopen period"}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {can("accounting.view") || can("accounting.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Structure</p>
              <h2>Account types & custom chart of accounts</h2>
              <p className="muted">
                The five accounting categories are structural. Account names, codes, subaccounts, and custom account types are yours.
              </p>
            </div>
          </div>

          {can("accounting.manage") ? (
            <>
              <form action={createAccountTypeAction} className="form-grid create-box">
                <label>Type code<input name="code" placeholder="BANK" required /></label>
                <label>Type name<input name="name" placeholder="Bank accounts" required /></label>
                <label>
                  Category
                  <select name="category" defaultValue="asset">
                    <option value="asset">Asset</option>
                    <option value="liability">Liability</option>
                    <option value="equity">Equity / net position</option>
                    <option value="income">Income</option>
                    <option value="expense">Expense</option>
                  </select>
                </label>
                <button type="submit">Create account type</button>
              </form>

              <form action={createAccountAction} className="form-grid create-box">
                <label>Account code<input name="code" placeholder="1000" required /></label>
                <label>Account name<input name="name" placeholder="Your account name" required /></label>
                <label>
                  Account type
                  <select name="account_type_id" defaultValue="" required>
                    <option value="" disabled>Select type</option>
                    {accountTypes.filter((type) => type.is_active).map((type) => (
                      <option key={type.id} value={type.id}>{type.code} · {type.name} · {type.category}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Parent account
                  <select name="parent_account_id" defaultValue="">
                    <option value="">No parent</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
                    ))}
                  </select>
                </label>
                <label>Currency<input name="currency" maxLength={3} defaultValue={currencySetting} required /></label>
                <label className="check"><input type="checkbox" name="allow_posting" defaultChecked /> Allow direct posting</label>
                <label className="span-2">Notes<textarea name="notes" /></label>
                <button type="submit">Create account</button>
              </form>
            </>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Parent</th><th>Posting</th><th>Balance</th><th>Status</th><th /></tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td><code>{account.code}</code></td>
                    <td>{account.name}</td>
                    <td>{account.account_type_name} · {account.category}</td>
                    <td>{account.parent_code ? `${account.parent_code} · ${account.parent_name}` : "—"}</td>
                    <td>{account.allow_posting ? "Yes" : "Header only"}</td>
                    <td>{moneyLabel(account.normal_balance, account.currency)}</td>
                    <td><span className="badge">{account.status}</span></td>
                    <td>
                      {can("accounting.manage") ? (
                        <form action={updateAccountStatusAction}>
                          <input type="hidden" name="account_id" value={account.id} />
                          <input type="hidden" name="status" value={account.status === "active" ? "inactive" : "active"} />
                          <button type="submit" className="secondary">
                            {account.status === "active" ? "Deactivate" : "Reactivate"}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {can("accounting.manage") || can("accounting.mapping") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Journals & integration</p>
              <h2>Journals and billing account mappings</h2>
              <p className="muted">
                Billing uses your selected accounts; Montikids does not create or force account names.
              </p>
            </div>
          </div>
          {can("accounting.manage") ? (
            <form action={createJournalAction} className="form-grid create-box">
              <label>Journal code<input name="code" placeholder="GEN" required /></label>
              <label>Journal name<input name="name" placeholder="General Journal" required /></label>
              <label className="span-2">Description<input name="description" /></label>
              <button type="submit">Create journal</button>
            </form>
          ) : null}

          <div className="card-list">
            {journals.map((journal) => (
              <article className="subcard" key={journal.id}>
                <div className="row-between">
                  <div><strong>{journal.code} · {journal.name}</strong><div className="muted">{journal.description ?? "No description"}</div></div>
                  <span className="badge">{journal.status}</span>
                </div>
              </article>
            ))}
          </div>

          {can("accounting.mapping") ? (
            <div className="card-list">
              {mappingRoles.map((role) => (
                <article className="subcard" key={role.role_key}>
                  <div className="row-between">
                    <div>
                      <strong>{role.name}</strong>
                      <div className="muted">{role.description}</div>
                    </div>
                    <span className="badge">{role.required_category}</span>
                  </div>
                  <form action={updateAccountingMappingAction} className="inline-form compact-form">
                    <input type="hidden" name="role_key" value={role.role_key} />
                    <label>
                      Mapped account
                      <select name="account_id" defaultValue={role.account_id ?? ""} required>
                        <option value="" disabled>Select {role.required_category} account</option>
                        {activePostingAccounts
                          .filter((account) => account.category === role.required_category)
                          .map((account) => (
                            <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
                          ))}
                      </select>
                    </label>
                    <button type="submit">Save mapping</button>
                  </form>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {can("accounting.post") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Common entries</p>
              <h2>Opening balances, receipts, expenses & transfers</h2>
              <p className="muted">Every one of these creates a balanced, posted journal entry through the same posting engine.</p>
            </div>
          </div>

          <form action={createOpeningBalanceAction} className="form-grid create-box">
            <h3 className="span-2">Opening balance</h3>
            <label>
              Journal
              <select name="journal_id" defaultValue="" required>
                <option value="" disabled>Select journal</option>
                {activeJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.code} · {journal.name}</option>)}
              </select>
            </label>
            <label>Posting date<input name="posting_date" type="date" defaultValue={today} required /></label>
            <label>
              Balance account
              <select name="account_id" defaultValue="" required>
                <option value="" disabled>Select account</option>
                {activePostingAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>
              Offset account
              <select name="offset_account_id" defaultValue="" required>
                <option value="" disabled>Select offset</option>
                {activePostingAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>
              Balance side
              <select name="side" defaultValue="debit">
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </label>
            <label>Reference<input name="transaction_reference" /></label>
            <button type="submit">Post opening balance</button>
          </form>

          <form action={recordAccountingReceiptAction} className="form-grid create-box">
            <h3 className="span-2">Receipt</h3>
            <label>
              Journal
              <select name="journal_id" defaultValue="" required>
                <option value="" disabled>Select journal</option>
                {activeJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.code} · {journal.name}</option>)}
              </select>
            </label>
            <label>Posting date<input name="posting_date" type="date" defaultValue={today} required /></label>
            <label>
              Receive into
              <select name="receive_account_id" defaultValue="" required>
                <option value="" disabled>Select asset account</option>
                {assetAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>
              Credit account
              <select name="source_account_id" defaultValue="" required>
                <option value="" disabled>Select income / liability / equity account</option>
                {activePostingAccounts
                  .filter((account) => ["income", "liability", "equity"].includes(account.category))
                  .map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Reference<input name="transaction_reference" /></label>
            <label className="span-2">Description<input name="description" required /></label>
            <button type="submit">Post receipt</button>
          </form>

          <form action={recordExpenseAction} className="form-grid create-box">
            <h3 className="span-2">Expense</h3>
            <label>
              Journal
              <select name="journal_id" defaultValue="" required>
                <option value="" disabled>Select journal</option>
                {activeJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.code} · {journal.name}</option>)}
              </select>
            </label>
            <label>Posting date<input name="posting_date" type="date" defaultValue={today} required /></label>
            <label>
              Expense account
              <select name="expense_account_id" defaultValue="" required>
                <option value="" disabled>Select expense account</option>
                {expenseAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>
              Pay from
              <select name="payment_account_id" defaultValue="" required>
                <option value="" disabled>Select asset / liability account</option>
                {activePostingAccounts
                  .filter((account) => ["asset", "liability"].includes(account.category))
                  .map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Reference<input name="transaction_reference" /></label>
            <label className="span-2">Description<input name="description" required /></label>
            <button type="submit">Post expense</button>
          </form>

          <form action={recordTransferAction} className="form-grid create-box">
            <h3 className="span-2">Transfer between accounts</h3>
            <label>
              Journal
              <select name="journal_id" defaultValue="" required>
                <option value="" disabled>Select journal</option>
                {activeJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.code} · {journal.name}</option>)}
              </select>
            </label>
            <label>Posting date<input name="posting_date" type="date" defaultValue={today} required /></label>
            <label>
              From asset account
              <select name="from_account_id" defaultValue="" required>
                <option value="" disabled>Select source</option>
                {assetAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>
              To asset account
              <select name="to_account_id" defaultValue="" required>
                <option value="" disabled>Select destination</option>
                {assetAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
              </select>
            </label>
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Reference<input name="transaction_reference" /></label>
            <label className="span-2">Description<input name="description" defaultValue="Account transfer" required /></label>
            <button type="submit">Post transfer</button>
          </form>
        </section>
      ) : null}

      {can("accounting.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Manual journals</p>
              <h2>Create a journal entry</h2>
              <p className="muted">Drafts may be incomplete. Posting will fail unless total debit exactly equals total credit.</p>
            </div>
          </div>
          <form action={createManualJournalAction} className="create-box">
            <div className="form-grid">
              <label>
                Journal
                <select name="journal_id" defaultValue="" required>
                  <option value="" disabled>Select journal</option>
                  {activeJournals.map((journal) => <option key={journal.id} value={journal.id}>{journal.code} · {journal.name}</option>)}
                </select>
              </label>
              <label>Posting date<input name="posting_date" type="date" defaultValue={today} required /></label>
              <label>Description<input name="description" required /></label>
              <label>Transaction reference<input name="transaction_reference" /></label>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <select name="line_account_id" defaultValue="">
                          <option value="">Unused line</option>
                          {activePostingAccounts.map((account) => (
                            <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
                          ))}
                        </select>
                      </td>
                      <td><input name="line_description" /></td>
                      <td><input name="line_debit" type="number" min="0" step="0.01" /></td>
                      <td><input name="line_credit" type="number" min="0" step="0.01" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="top-actions">
              <button type="submit" name="action_mode" value="draft" className="secondary">Save draft</button>
              {can("accounting.post") ? <button type="submit" name="action_mode" value="post">Post balanced entry</button> : null}
            </div>
          </form>
        </section>
      ) : null}

      {can("accounting.view") || can("accounting.post") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Journal register</p>
              <h2>Journal entries</h2>
              <p className="muted">Posted entries are immutable. Reversals create equal and opposite entries.</p>
            </div>
          </div>
          <div className="card-list">
            {entries.map((entry) => (
              <article className="subcard" key={entry.id}>
                <div className="row-between">
                  <div>
                    <strong>{entry.entry_number ?? "Draft"} · {entry.description}</strong>
                    <div className="muted">
                      {entry.journal_code} · {entry.posting_date} · {entry.entry_kind}
                      {entry.transaction_reference ? ` · ref ${entry.transaction_reference}` : ""}
                    </div>
                  </div>
                  <span className="badge">{entry.status}</span>
                </div>
                <div className="record-grid">
                  <div><strong>Total debit</strong><p>{moneyLabel(entry.total_debit, entry.currency)}</p></div>
                  <div><strong>Total credit</strong><p>{moneyLabel(entry.total_credit, entry.currency)}</p></div>
                  <div><strong>Created by</strong><p>{entry.created_by_name ?? "System / unknown"}</p></div>
                  <div><strong>Posted by</strong><p>{entry.posted_by_name ?? "—"}</p></div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
                    <tbody>
                      {(linesByEntry.get(entry.id) ?? []).map((line) => (
                        <tr key={line.id}>
                          <td>{line.line_number}</td>
                          <td>{line.account_code} · {line.account_name}</td>
                          <td>{line.description ?? "—"}</td>
                          <td>{Number(line.debit) ? moneyLabel(line.debit, entry.currency) : "—"}</td>
                          <td>{Number(line.credit) ? moneyLabel(line.credit, entry.currency) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {can("accounting.post") && entry.status === "draft" ? (
                  <form action={postDraftJournalAction}>
                    <input type="hidden" name="journal_entry_id" value={entry.id} />
                    <button type="submit">Post draft</button>
                  </form>
                ) : null}
                {can("accounting.post") && entry.status === "posted" ? (
                  <form action={reverseJournalAction} className="inline-form compact-form">
                    <input type="hidden" name="journal_entry_id" value={entry.id} />
                    <label>Reversal date<input name="posting_date" type="date" defaultValue={today} required /></label>
                    <label>Reason<input name="reason" required /></label>
                    <button type="submit" className="secondary">Reverse entry</button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {can("accounting.view") ? (
        <>
          <section className="panel section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">General ledger</p>
                <h2>Posted ledger lines</h2>
                <p className="muted">Running balance follows each account's normal debit or credit direction.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Entry</th><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th><th>Running balance</th></tr></thead>
                <tbody>
                  {ledger.map((line) => (
                    <tr key={line.journal_line_id}>
                      <td>{line.posting_date}</td>
                      <td>{line.entry_number}<div className="muted compact-text">{line.transaction_reference ?? line.entry_kind}</div></td>
                      <td>{line.account_code} · {line.account_name}</td>
                      <td>
                        {line.line_description ?? line.entry_description}
                        {line.family_number ? <div className="muted compact-text">{line.family_number}{line.student_name ? ` · ${line.student_name}` : ""}</div> : null}
                      </td>
                      <td>{Number(line.debit) ? moneyLabel(line.debit, line.currency) : "—"}</td>
                      <td>{Number(line.credit) ? moneyLabel(line.credit, line.currency) : "—"}</td>
                      <td>{moneyLabel(line.running_balance, line.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Trial balance</p>
                <h2>Debit = Credit verification</h2>
                <p className="muted">
                  Debit balances {moneyLabel(trialDebit, currencySetting)} · Credit balances {moneyLabel(trialCredit, currencySetting)}
                </p>
              </div>
              <span className="badge">{Math.abs(trialDebit - trialCredit) < 0.005 ? "balanced" : "out of balance"}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th>Category</th><th>Total debit</th><th>Total credit</th><th>Debit balance</th><th>Credit balance</th></tr></thead>
                <tbody>
                  {trialBalance.map((row) => (
                    <tr key={row.account_id}>
                      <td>{row.account_code} · {row.account_name}</td>
                      <td>{row.category}</td>
                      <td>{moneyLabel(row.total_debit, currencySetting)}</td>
                      <td>{moneyLabel(row.total_credit, currencySetting)}</td>
                      <td>{Number(row.debit_balance) ? moneyLabel(row.debit_balance, currencySetting) : "—"}</td>
                      <td>{Number(row.credit_balance) ? moneyLabel(row.credit_balance, currencySetting) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {position ? (
            <section className="panel section-block">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Financial position</p>
                  <h2>Assets, liabilities, equity & current surplus</h2>
                </div>
              </div>
              <div className="record-grid">
                <div><strong>Assets</strong><p>{moneyLabel(position.assets, currencySetting)}</p></div>
                <div><strong>Liabilities</strong><p>{moneyLabel(position.liabilities, currencySetting)}</p></div>
                <div><strong>Equity</strong><p>{moneyLabel(position.equity, currencySetting)}</p></div>
                <div><strong>Income</strong><p>{moneyLabel(position.income, currencySetting)}</p></div>
                <div><strong>Expenses</strong><p>{moneyLabel(position.expenses, currencySetting)}</p></div>
                <div><strong>Current surplus</strong><p>{moneyLabel(position.current_surplus, currencySetting)}</p></div>
                <div><strong>Net position</strong><p>{moneyLabel(position.net_position, currencySetting)}</p></div>
                <div><strong>Equation difference</strong><p>{moneyLabel(position.equation_difference, currencySetting)}</p></div>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      <section className="panel section-block">
        <p className="eyebrow">Milestone 4</p>
        <h2>Tiny-company reconciliation</h2>
        <p className="muted">
          CI creates custom accounts, posts a 10,000.00 opening bank balance, receives 1,000.00,
          spends 200.00, and transfers 500.00 between bank accounts. Expected ending assets are
          10,800.00, current surplus is 800.00, net position is 10,800.00, and the trial balance
          must reconcile exactly.
        </p>
      </section>
    </main>
  );
}
