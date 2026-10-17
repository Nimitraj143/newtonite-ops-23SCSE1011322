import { PoolClient } from "pg";
import { pool } from "./db";

const MAX_ATTEMPTS = 5;

interface Job {
  id: number;
  type: string;
  payload: any;
  dedupe_key: string;
  attempts: number;
}

// The actual work. It must be safe to run twice (idempotent).
async function handle(c: PoolClient, job: Job) {
  if (job.payload.simulate_failure) throw new Error("simulated failure"); // for the demo
  switch (job.type) {
    case "notify_assignee": {
      const { item_id, user_id, title } = job.payload;
      // dedupe_key is UNIQUE: a second run does nothing
      await c.query(
        `INSERT INTO notifications (user_id, item_id, message, dedupe_key) VALUES ($1, $2, $3, $4)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [user_id, item_id, `You were assigned: ${title}`, job.dedupe_key]
      );
      return;
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

async function recordFailure(job: Job, e: unknown) {
  const attempts = job.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending"; // give up after MAX_ATTEMPTS
  const delaySeconds = Math.min(60, 2 ** attempts); // exponential backoff: 2s, 4s, 8s, 16s...
  await pool.query(
    `UPDATE outbox_jobs
     SET attempts = $2, status = $3, last_error = $4, next_run_at = now() + make_interval(secs => $5::int)
     WHERE id = $1`,
    [job.id, attempts, status, String(e instanceof Error ? e.message : e), delaySeconds]
  );
}

// Takes ONE due job, runs it, marks it done. Returns false when there is nothing to do.
export async function processNextJob(): Promise<boolean> {
  const c = await pool.connect();
  let job: Job | undefined;
  try {
    await c.query("BEGIN");
    // FOR UPDATE SKIP LOCKED: two workers never pick the same job
    const r = await c.query(
      `SELECT id, type, payload, dedupe_key, attempts FROM outbox_jobs
       WHERE status = 'pending' AND next_run_at <= now()
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!r.rowCount) {
      await c.query("COMMIT");
      return false;
    }
    job = r.rows[0] as Job;
    await handle(c, job);
    await c.query(`UPDATE outbox_jobs SET status = 'done', attempts = attempts + 1, last_error = NULL WHERE id = $1`, [job.id]);
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK"); // a crash here leaves the job pending, so it is retried
    if (!job) throw e; // database problem, not a job problem
    await recordFailure(job, e);
    console.error(`job ${job.id} failed (attempt ${job.attempts + 1}):`, e instanceof Error ? e.message : e);
    return true;
  } finally {
    c.release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("worker started");
  for (;;) {
    try {
      const worked = await processNextJob();
      if (!worked) await sleep(1000);
    } catch (e) {
      console.error("worker error:", e);
      await sleep(3000);
    }
  }
}

if (require.main === module) main();