import "dotenv/config";
import { Pool, PoolClient, types } from "pg";

types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Runs fn inside one transaction: commit if it succeeds, roll back if it throws.
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}