import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { Fixture, auth, count, insertItem, resetAndSeed } from "./helpers";

const app = createApp();
let f: Fixture;
beforeEach(async () => {
  f = await resetAndSeed();
});
afterAll(async () => {
  await pool.end();
});

describe("simultaneous claims", () => {
  it("lets exactly one of three simultaneous claimers win", async () => {
    const id = await insertItem(f);
    const claimers = [f.users.maya, f.users.dev, f.users.raj];
    const results = await Promise.all(claimers.map((u) => request(app).post(`/items/${id}/claim`).set(auth(u))));

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const winner = claimers[results.findIndex((r) => r.status === 200)];
    const row = (await pool.query("SELECT assignee_id, version FROM work_items WHERE id = $1", [id])).rows[0];
    expect(row.assignee_id).toBe(winner);
    expect(row.version).toBe(2); // bumped once, not three times
    expect(await count("SELECT 1 FROM activity_events WHERE item_id = $1 AND kind = 'claimed'", [id])).toBe(1);
  });

  it("treats a repeated claim by the same user as a harmless success", async () => {
    const id = await insertItem(f);
    await request(app).post(`/items/${id}/claim`).set(auth(f.users.maya));
    const again = await request(app).post(`/items/${id}/claim`).set(auth(f.users.maya));
    expect(again.status).toBe(200);
    expect(await count("SELECT 1 FROM activity_events WHERE item_id = $1 AND kind = 'claimed'", [id])).toBe(1);
  });
});

describe("stale updates", () => {
  it("rejects an edit made on an old version and leaves the data unchanged", async () => {
    const id = await insertItem(f);
    const first = await request(app).patch(`/items/${id}`).set(auth(f.users.maya)).send({ version: 1, priority: "high" });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await request(app).patch(`/items/${id}`).set(auth(f.users.maya)).send({ version: 1, priority: "low" });
    expect(stale.status).toBe(409);
    expect(stale.body.details.item.version).toBe(2); // the client gets the latest state
    expect(stale.body.details.item.priority).toBe("high");

    const row = (await pool.query("SELECT priority, version FROM work_items WHERE id = $1", [id])).rows[0];
    expect(row.priority).toBe("high");
    expect(row.version).toBe(2);
  });
});

describe("idempotent create", () => {
  const body = () => ({ title: "Duplicate charge", type: "payment", priority: "high", team_id: f.teams.payments });

  it("creates one item when the same key is sent twice", async () => {
    const send = () => request(app).post("/items").set(auth(f.users.maya)).set("Idempotency-Key", "key-1").send(body());
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(await count("SELECT 1 FROM work_items")).toBe(1);
  });

  it("creates one item when the same key arrives at the same time", async () => {
    const send = () => request(app).post("/items").set(auth(f.users.maya)).set("Idempotency-Key", "key-2").send(body());
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.id).toBe(b.body.id);
    expect(await count("SELECT 1 FROM work_items")).toBe(1);
  });

  it("rejects the same key reused for a different request", async () => {
    await request(app).post("/items").set(auth(f.users.maya)).set("Idempotency-Key", "key-3").send(body());
    const other = await request(app)
      .post("/items")
      .set(auth(f.users.maya))
      .set("Idempotency-Key", "key-3")
      .send({ ...body(), title: "Something else" });
    expect(other.status).toBe(422);
    expect(await count("SELECT 1 FROM work_items")).toBe(1);
  });
});