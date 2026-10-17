import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../src/db";

export interface Fixture {
  teams: { payments: number; platform: number };
  users: { maya: number; dev: number; raj: number; vik: number; sana: number };
}

// Wipes the TEST database and creates: 2 teams, 5 users
//   Payments: maya (member), dev (member), raj (lead), vik (viewer)    Platform: sana (member)
export async function resetAndSeed(): Promise<Fixture> {
  if (!process.env.DATABASE_URL?.includes("ops_test")) {
    throw new Error("Refusing to wipe a database that is not ops_test");
  }
  await pool.query(
    "TRUNCATE notifications, outbox_jobs, idempotency_keys, activity_events, work_items, memberships, teams, users RESTART IDENTITY CASCADE"
  );
  const hash = await bcrypt.hash("pw", 4);
  const team = async (name: string) =>
    (await pool.query("INSERT INTO teams(name) VALUES ($1) RETURNING id", [name])).rows[0].id as number;
  const user = async (name: string) =>
    (await pool.query("INSERT INTO users(email, name, password_hash) VALUES ($1, $2, $3) RETURNING id", [`${name}@test.com`, name, hash])).rows[0].id as number;
  const member = (u: number, t: number, role: string) =>
    pool.query("INSERT INTO memberships(user_id, team_id, role) VALUES ($1, $2, $3)", [u, t, role]);

  const payments = await team("Payments");
  const platform = await team("Platform");
  const maya = await user("maya");
  const dev = await user("dev");
  const raj = await user("raj");
  const vik = await user("vik");
  const sana = await user("sana");
  await member(maya, payments, "member");
  await member(dev, payments, "member");
  await member(raj, payments, "lead");
  await member(vik, payments, "viewer");
  await member(sana, platform, "member");
  return { teams: { payments, platform }, users: { maya, dev, raj, vik, sana } };
}

export const auth = (userId: number) => ({
  Authorization: `Bearer ${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET!)}`,
});

export async function insertItem(
  f: Fixture,
  o: { creator?: number; assignee?: number | null; status?: string; priority?: string; team?: number } = {}
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by)
     VALUES ('Test item', '', 'task', $1, $2, $3, $4, $5) RETURNING id`,
    [o.priority ?? "medium", o.status ?? "open", o.team ?? f.teams.payments, o.assignee ?? null, o.creator ?? f.users.maya]
  );
  return r.rows[0].id as number;
}

export async function count(sql: string, params: any[] = []): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM (${sql}) t`, params);
  return r.rows[0].n;
}