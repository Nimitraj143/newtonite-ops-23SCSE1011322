import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { processNextJob } from "../src/worker";
import { Fixture, auth, count, insertItem, resetAndSeed } from "./helpers";

const app = createApp();
let f: Fixture;
beforeEach(async () => {
  f = await resetAndSeed();
});
afterAll(async () => {
  await pool.end();
});

describe("outbox", () => {
  it("writes the job and the assignment in one transaction", async () => {
    const id = await insertItem(f);
    const r = await request(app).post(`/items/${id}/assign`).set(auth(f.users.raj)).send({ assignee_id: f.users.dev, version: 1 });
    expect(r.status).toBe(200);
    expect(await count("SELECT 1 FROM outbox_jobs WHERE dedupe_key = $1", [`notify_assignee:${id}:2`])).toBe(1);
    expect(await count("SELECT 1 FROM activity_events WHERE item_id = $1 AND kind = 'assigned'", [id])).toBe(1);
  });

  it("writes NO job when the assignment is rejected", async () => {
    const id = await insertItem(f);
    const r = await request(app).post(`/items/${id}/assign`).set(auth(f.users.raj)).send({ assignee_id: f.users.vik, version: 1 }); // viewer
    expect(r.status).toBe(422);
    expect(await count("SELECT 1 FROM outbox_jobs")).toBe(0);
  });

  it("produces one notification even if a job is processed twice", async () => {
    const id = await insertItem(f);
    await pool.query(`INSERT INTO outbox_jobs (type, payload, dedupe_key) VALUES ('notify_assignee', $1, 'job-1')`, [
      JSON.stringify({ item_id: id, user_id: f.users.dev, title: "Test item" }),
    ]);
    expect(await processNextJob()).toBe(true);
    await pool.query("UPDATE outbox_jobs SET status = 'pending'"); // simulate a crash after sending, before marking done
    expect(await processNextJob()).toBe(true);

    expect(await count("SELECT 1 FROM notifications")).toBe(1);
    expect((await pool.query("SELECT attempts, status FROM outbox_jobs")).rows[0]).toEqual({ attempts: 2, status: "done" });
  });

  it("retries a failing job and gives up after 5 attempts", async () => {
    await pool.query(`INSERT INTO outbox_jobs (type, payload, dedupe_key) VALUES ('notify_assignee', $1, 'fail-1')`, [
      JSON.stringify({ simulate_failure: true }),
    ]);
    for (let i = 0; i < 5; i++) {
      await pool.query("UPDATE outbox_jobs SET next_run_at = now()"); // skip the backoff wait
      await processNextJob();
    }
    const job = (await pool.query("SELECT status, attempts, last_error FROM outbox_jobs")).rows[0];
    expect(job).toEqual({ status: "failed", attempts: 5, last_error: "simulated failure" });
    expect(await processNextJob()).toBe(false); // nothing left to run
  });
});