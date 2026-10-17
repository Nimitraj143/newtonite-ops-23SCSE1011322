import { execSync } from "child_process";
import { Pool } from "pg";

const ADMIN_URL = "postgres://ops:ops@localhost:5432/ops";
const URL = "postgres://ops:ops@localhost:5432/ops_test";

export default async function setup() {
  // Create the test database if it does not exist yet (fresh machine).
  const admin = new Pool({ connectionString: ADMIN_URL });
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'ops_test'");
  if (exists.rowCount === 0) {
    await admin.query("CREATE DATABASE ops_test");
  }
  await admin.end();

  const pool = new Pool({ connectionString: URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.end();
  execSync("npx tsx src/migrate.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: URL } });
}