import "dotenv/config";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = "Password123!";
const TEAMS = ["Payments", "Platform", "Support", "Compliance"];

const USERS: { email: string; name: string; roles: Record<string, string> }[] = [
  { email: "admin@demo.com", name: "Ada Admin", roles: { Payments: "admin", Platform: "admin", Support: "admin", Compliance: "admin" } },
  { email: "maya@demo.com", name: "Maya Member", roles: { Payments: "member" } },
  { email: "raj@demo.com", name: "Raj Lead", roles: { Payments: "lead" } },
  { email: "vik@demo.com", name: "Vik Viewer", roles: { Payments: "viewer" } },
  { email: "sana@demo.com", name: "Sana Member", roles: { Platform: "member" } },
  { email: "leo@demo.com", name: "Leo Lead", roles: { Platform: "lead" } },
  { email: "ivy@demo.com", name: "Ivy Multi", roles: { Support: "member", Compliance: "viewer" } },
  { email: "omar@demo.com", name: "Omar Lead", roles: { Support: "lead" } },
  { email: "nina@demo.com", name: "Nina Member", roles: { Compliance: "member" } },
  { email: "carl@demo.com", name: "Carl Lead", roles: { Compliance: "lead" } },
  { email: "dev@demo.com", name: "Dev Multi", roles: { Payments: "member", Platform: "member" } },
];

const TYPES = ["incident", "customer_issue", "payment", "compliance", "task"];
const PRIORITIES = ["low", "low", "medium", "medium", "medium", "high", "high", "urgent"];
const STATUSES = ["open", "open", "open", "in_progress", "in_progress", "awaiting_approval", "resolved", "closed", "closed"];

const SUBJECTS: Record<string, string[]> = {
  incident: ["API timeout in checkout", "Database latency spike", "Login service down", "Queue backlog growing"],
  customer_issue: ["Customer cannot reset password", "Refund not received", "Wrong invoice amount", "Account locked"],
  payment: ["Duplicate charge on invoice", "Payout failed for vendor", "Chargeback investigation", "Currency mismatch"],
  compliance: ["KYC document review", "Data deletion request", "Audit evidence missing", "Policy exception approval"],
  task: ["Update runbook", "Rotate API keys", "Review access list", "Archive old tickets"],
};

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "TRUNCATE notifications, outbox_jobs, idempotency_keys, activity_events, work_items, memberships, teams, users RESTART IDENTITY CASCADE"
    );

    const teamId: Record<string, number> = {};
    for (const t of TEAMS) {
      const r = await c.query("INSERT INTO teams(name) VALUES ($1) RETURNING id", [t]);
      teamId[t] = r.rows[0].id;
    }

    // users who may create/claim work (not viewers), per team
    const writers: Record<number, number[]> = {};
    for (const t of TEAMS) writers[teamId[t]] = [];

    for (const u of USERS) {
      const r = await c.query(
        "INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id",
        [u.email, u.name, hash]
      );
      const uid = r.rows[0].id;
      for (const [team, role] of Object.entries(u.roles)) {
        await c.query("INSERT INTO memberships(user_id,team_id,role) VALUES ($1,$2,$3)", [uid, teamId[team], role]);
        if (role !== "viewer") writers[teamId[team]].push(uid);
      }
    }

    const TOTAL = 5000;
    const BATCH = 1000;
    const now = Date.now();
    const DAY = 86400000;

    for (let start = 0; start < TOTAL; start += BATCH) {
      const cols: any[][] = [[], [], [], [], [], [], [], [], [], [], []];
      for (let i = start; i < Math.min(start + BATCH, TOTAL); i++) {
        const team = pick(TEAMS);
        const tid = teamId[team];
        const type = pick(TYPES);
        const status = pick(STATUSES);
        const priority = pick(PRIORITIES);
        const creator = pick(writers[tid]);
        const unassigned = status === "open" && Math.random() < 0.5;
        const assignee = unassigned ? null : pick(writers[tid]);
        const created = now - Math.random() * 90 * DAY;
        const updated = Math.min(now, created + Math.random() * 5 * DAY);
        const due = Math.random() < 0.6 ? new Date(now + (Math.random() * 40 - 10) * DAY).toISOString() : null;

        cols[0].push(`${pick(SUBJECTS[type])} #${i + 1}`);
        cols[1].push(`Auto-generated demo item ${i + 1} for team ${team}. Needs investigation and follow-up.`);
        cols[2].push(type);
        cols[3].push(priority);
        cols[4].push(status);
        cols[5].push(tid);
        cols[6].push(assignee);
        cols[7].push(creator);
        cols[8].push(due);
        cols[9].push(new Date(created).toISOString());
        cols[10].push(new Date(updated).toISOString());
      }
      await c.query(
        `INSERT INTO work_items (title,description,type,priority,status,team_id,assignee_id,created_by,due_date,created_at,updated_at)
         SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::bigint[],$7::bigint[],$8::bigint[],$9::timestamptz[],$10::timestamptz[],$11::timestamptz[])`,
        cols
      );
    }

    // history for every item, so the timeline is not empty
    await c.query(`INSERT INTO activity_events (item_id, actor_id, kind, payload, created_at)
                   SELECT id, created_by, 'created', '{}'::jsonb, created_at FROM work_items`);
    await c.query(`INSERT INTO activity_events (item_id, actor_id, kind, payload, created_at)
                   SELECT id, assignee_id, 'assigned', jsonb_build_object('to', assignee_id), created_at + interval '1 minute'
                   FROM work_items WHERE assignee_id IS NOT NULL`);
    await c.query(`INSERT INTO activity_events (item_id, actor_id, kind, payload, created_at)
                   SELECT id, assignee_id, 'status_changed', jsonb_build_object('from','open','to',status), updated_at
                   FROM work_items WHERE status <> 'open'`);

    await c.query("COMMIT");
    const counts = await pool.query(
      "SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM work_items) items, (SELECT count(*) FROM activity_events) events"
    );
    console.log("seeded:", counts.rows[0]);
    console.log(`demo password for every user: ${PASSWORD}`);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
main();