import pg from "pg";
import { release2Checks } from "./release2-test-support.mjs";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const throughArg = process.argv.find((arg) => arg.startsWith("--through="));
const through = throughArg?.slice("--through=".length) ?? process.argv[2];
if (!through || !/^\d{4}-\d{2}-\d{2}$/.test(through)) {
  throw new Error("Usage: npm run release2:gate -- --through=YYYY-MM-DD");
}

const expectedChecks = new Set(release2Checks);
const pool = new Pool({ connectionString });

try {
  const result = await pool.query(
    `select check_name,currency,system_amount::text,ledger_amount::text,
            difference::text,passed,details
       from release2_reconciliation_gate($1::date)
       order by check_name,currency`,
    [through],
  );

  if (!result.rowCount) {
    throw new Error(
      "Release 2 gate produced no rows. Configure the chart of accounts and accounting mappings before launch.",
    );
  }

  console.table(result.rows);

  const present = new Set(result.rows.map((row) => row.check_name));
  const missing = [...expectedChecks].filter((name) => !present.has(name));
  const unexpected = [...present].filter((name) => !expectedChecks.has(name));
  const failed = result.rows.filter(
    (row) => row.passed !== true || Math.abs(Number(row.difference)) >= 0.005,
  );

  if (missing.length) {
    throw new Error("Release 2 gate is incomplete. Missing checks: " + missing.join(", "));
  }
  if (unexpected.length) {
    throw new Error("Release 2 gate returned undocumented checks: " + unexpected.join(", "));
  }
  if (failed.length) {
    throw new Error(
      "Release 2 gate failed: " +
        failed
          .map(
            (row) =>
              row.check_name + " [" + row.currency + "] difference " + row.difference,
          )
          .join("; "),
    );
  }

  console.log("Release 2 reconciliation gate passed through " + through + ".");
} finally {
  await pool.end();
}
