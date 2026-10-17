import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)`);
  const dir = join(__dirname, "../migrations");
  for (const f of readdirSync(dir).sort()) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
    if (done.rowCount) continue;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log("applied", f);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await pool.end();
}
main();