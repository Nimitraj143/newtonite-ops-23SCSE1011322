import "dotenv/config";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query("SELECT count(*)::int AS n FROM users");
  await pool.end();
  if (r.rows[0].n === 0) {
    console.log("Empty database, seeding demo data...");
    await import("./seed");
  } else {
    console.log("Database already has data, skipping seed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});