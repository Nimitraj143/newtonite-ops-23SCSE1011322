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

const status = async (id: number) => (await pool.query("SELECT status FROM work_items WHERE id = $1", [id])).rows[0].status;

describe("workflow rules", () => {
  it("rejects an invalid jump (open -> closed)", async () => {
    const id = await insertItem(f, { assignee: f.users.maya });
    const r = await request(app).post(`/items/${id}/transition`).set(auth(f.users.maya)).send({ to: "closed", version: 1 });
    expect(r.status).toBe(422);
    expect(await status(id)).toBe("open");
  });

  it("lets only a Lead approve, not a Member", async () => {
    const id = await insertItem(f, { assignee: f.users.maya, status: "awaiting_approval" });
    const asMember = await request(app).post(`/items/${id}/transition`).set(auth(f.users.maya)).send({ to: "resolved", version: 1 });
    expect(asMember.status).toBe(403);
    expect(await status(id)).toBe("awaiting_approval");

    const asLead = await request(app).post(`/items/${id}/transition`).set(auth(f.users.raj)).send({ to: "resolved", version: 1 });
    expect(asLead.status).toBe(200);
    expect(await status(id)).toBe("resolved");
    expect(await count("SELECT 1 FROM activity_events WHERE item_id = $1 AND kind = 'status_changed'", [id])).toBe(1);
  });
});

describe("resource-level authorization", () => {
  it("hides an item from a user in another team on read AND write", async () => {
    const id = await insertItem(f);
    const sana = auth(f.users.sana);
    expect((await request(app).get(`/items/${id}`).set(sana)).status).toBe(404);
    expect((await request(app).patch(`/items/${id}`).set(sana).send({ version: 1, title: "hacked" })).status).toBe(404);
    expect((await request(app).post(`/items/${id}/claim`).set(sana)).status).toBe(404);
    expect((await request(app).post(`/items/${id}/transition`).set(sana).send({ to: "in_progress", version: 1 })).status).toBe(404);

    const list = await request(app).get("/items").set(sana);
    expect(list.body.items.map((i: any) => i.id)).not.toContain(id);
    const row = (await pool.query("SELECT title, version FROM work_items WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ title: "Test item", version: 1 });
  });

  it("stops a Viewer from creating or claiming", async () => {
    const id = await insertItem(f);
    const vik = auth(f.users.vik);
    const created = await request(app).post("/items").set(vik).send({ title: "x", type: "task", priority: "low", team_id: f.teams.payments });
    expect(created.status).toBe(403);
    expect((await request(app).post(`/items/${id}/claim`).set(vik)).status).toBe(403);
  });

  it("stops a Member from editing an item assigned to someone else", async () => {
    const id = await insertItem(f, { assignee: f.users.dev });
    const r = await request(app).patch(`/items/${id}`).set(auth(f.users.maya)).send({ version: 1, title: "mine now" });
    expect(r.status).toBe(403);
  });

  it("rejects requests without a token", async () => {
    expect((await request(app).get("/items")).status).toBe(401);
  });
});