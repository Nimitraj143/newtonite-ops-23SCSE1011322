import { execSync } from "child_process";
import { Pool } from "pg";

const URL = "postgres://ops:ops@localhost:5432/ops_test";

export default async function setup() {
  const pool = new Pool({ connectionString: URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.end();
  execSync("npx tsx src/migrate.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: URL } });
}