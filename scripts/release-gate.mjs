import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const throughArg = process.argv.find((arg) => arg.startsWith("--through="));
const through = throughArg?.slice("--through=".length) ?? process.argv[2];
if (!through || !/^\d{4}-\d{2}-\d{2}$/.test(through)) {
  throw new Error("Usage: npm run release:gate -- --through=YYYY-MM-DD");
}

const expectedChecks = new Set([
  "Student balances = Accounts Receivable",
  "Family credits = Customer Deposits",
  "Supplier balances = Accounts Payable",
  "Cash screens = Cash ledger",
  "Bank screens = Bank ledger",
  "Payroll reports = Payroll accounting",
  "Net Position = Accounting ledger",
  "Trial Balance debits = Trial Balance credits",
]);

const pool = new Pool({ connectionString });
try {
  const result = await pool.query(
    "select check_name,currency,system_amount::text,ledger_amount::text,difference::text,passed,details from release_reconciliation_gate($1)",
    [through],
  );

  if (!result.rowCount) {
    throw new Error("Release gate produced no rows. Configure the chart of accounts and accounting mappings before launch.");
  }

  console.table(result.rows);

  const present = new Set(result.rows.map((row) => row.check_name));
  const missing = [...expectedChecks].filter((name) => !present.has(name));
  const failed = result.rows.filter((row) => row.passed !== true);

  if (missing.length) {
    throw new Error("Release gate is incomplete. Missing checks: " + missing.join(", "));
  }
  if (failed.length) {
    throw new Error(
      "Release gate failed: " +
        failed.map((row) => row.check_name + " [" + row.currency + "] difference " + row.difference).join("; "),
    );
  }

  console.log("Release 1 reconciliation gate passed through " + through + ".");
} finally {
  await pool.end();
}
