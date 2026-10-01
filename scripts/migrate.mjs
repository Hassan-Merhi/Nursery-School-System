import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query(`
    create table if not exists schema_migration (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const dir = path.resolve("db");
  const migrations = (await readdir(dir))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();

  for (const filename of migrations) {
    const already = await client.query(
      "select 1 from schema_migration where filename = $1",
      [filename],
    );
    if (already.rowCount) continue;

    const sql = await readFile(path.join(dir, filename), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migration(filename) values ($1)",
        [filename],
      );
      await client.query("commit");
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
