import crypto from "crypto";
import { Request } from "express";
import { PoolClient } from "pg";
import { withTx } from "./db";
import { HttpError } from "./errors";

export interface Outcome {
  status: number;
  body: any;
}

// Runs `run` once per Idempotency-Key. A repeat with the same key returns the stored response.
// The key row is written in the SAME transaction as the business change, so they succeed or fail together.
export async function idempotent(
  req: Request,
  userId: number,
  run: (c: PoolClient) => Promise<Outcome>
): Promise<Outcome & { replayed: boolean }> {
  const key = req.header("Idempotency-Key");
  if (!key) return withTx(async (c) => ({ ...(await run(c)), replayed: false }));
  if (key.length > 200) throw new HttpError(400, "Idempotency-Key is too long");

  const hash = crypto
    .createHash("sha256")
    .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`)
    .digest("hex");

  return withTx(async (c) => {
    // If another request with this key is still in progress, this INSERT waits for it to finish.
    const ins = await c.query(
      `INSERT INTO idempotency_keys (key, user_id, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
      [key, userId, hash]
    );
    if (!ins.rowCount) {
      const ex = await c.query(
        `SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key]
      );
      const row = ex.rows[0];
      if (row.request_hash !== hash) {
        throw new HttpError(422, "This Idempotency-Key was already used with a different request");
      }
      return { status: row.status_code, body: row.response_body, replayed: true };
    }
    const result = await run(c);
    await c.query(
      `UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE user_id = $1 AND key = $2`,
      [userId, key, result.status, JSON.stringify(result.body)]
    );
    return { ...result, replayed: false };
  });
}