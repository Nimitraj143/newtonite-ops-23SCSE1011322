import { Router, Request } from "express";
import { z } from "zod";
import { authenticate } from "./auth";
import { pool, withTx } from "./db";
import { HttpError } from "./errors";
import { Action, AuthUser, authorize, readableTeamIds } from "./permissions";
import { STATUSES, Status, actionForTransition, canTransition, nextStatuses } from "./workflow";
import { idempotent } from "./idempotency";

export const itemsRouter = Router();
itemsRouter.use(authenticate); // every route below needs a logged-in user

const TYPES = ["incident", "customer_issue", "payment", "compliance", "task"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

// Anything with a query() method: the pool or a transaction client
type Db = { query: (text: string, values?: any[]) => Promise<any> };

const ITEM_SQL = `
  SELECT w.id, w.title, w.description, w.type, w.priority, w.status,
         w.team_id, t.name AS team_name,
         w.assignee_id, a.name AS assignee_name,
         w.created_by, c.name AS created_by_name,
         w.due_date, w.version, w.created_at, w.updated_at
  FROM work_items w
  JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id
  JOIN users c ON c.id = w.created_by`;

async function getItem(db: Db, id: number) {
  const r = await db.query(`${ITEM_SQL} WHERE w.id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function addEvent(db: Db, itemId: number, actorId: number | null, kind: string, payload: object = {}) {
  const r = await db.query(
    `INSERT INTO activity_events (item_id, actor_id, kind, payload) VALUES ($1, $2, $3, $4)
     RETURNING id, kind, payload, created_at`,
    [itemId, actorId, kind, JSON.stringify(payload)]
  );
  return r.rows[0];
}

function parseId(req: Request): number {
  return z.coerce.number().int().positive().parse(req.params.id);
}

function allowed(user: AuthUser, action: Action, item: any): boolean {
  try {
    authorize(user, action, item);
    return true;
  } catch {
    return false;
  }
}

// The item plus what THIS user may do with it (the UI uses this; the server still enforces everything)
function present(user: AuthUser, item: any) {
  const open = item.status !== "resolved" && item.status !== "closed";
  return {
    ...item,
    can: {
      edit: item.status !== "closed" && allowed(user, "edit", item),
      claim: open && item.assignee_id == null && allowed(user, "claim", item),
      assign: item.status !== "closed" && allowed(user, "assign", item),
      comment: allowed(user, "comment", item),
    },
    allowed_transitions: nextStatuses(item.status as Status).filter((to) =>
      allowed(user, actionForTransition(item.status as Status, to), item)
    ),
  };
}

// ---------- list + search + filters + cursor pagination ----------

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TYPES).optional(),
  team_id: z.coerce.number().int().optional(),
  assignee: z.string().optional(), // "me", "none" or a user id
  view: z.enum(["assigned_to_me", "unassigned_urgent", "awaiting_my_approval"]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
type ListFilters = z.infer<typeof listSchema>;

function buildFilters(user: AuthUser, f: ListFilters) {
  const params: any[] = [];
  const where: string[] = [];
  const add = (v: any) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Resource-level authorization in SQL: you only ever see items from YOUR teams
  let teamIds = readableTeamIds(user);
  if (f.team_id !== undefined) {
    if (!teamIds.includes(f.team_id)) throw new HttpError(404, "Not found");
    teamIds = [f.team_id];
  }
  where.push(`w.team_id = ANY(${add(teamIds)}::bigint[])`);

  if (f.status) where.push(`w.status = ${add(f.status)}`);
  if (f.priority) where.push(`w.priority = ${add(f.priority)}`);
  if (f.type) where.push(`w.type = ${add(f.type)}`);

  if (f.assignee === "me") where.push(`w.assignee_id = ${add(user.id)}`);
  else if (f.assignee === "none") where.push(`w.assignee_id IS NULL`);
  else if (f.assignee) {
    const n = Number(f.assignee);
    if (!Number.isInteger(n)) throw new HttpError(400, "Invalid assignee filter");
    where.push(`w.assignee_id = ${add(n)}`);
  }

  if (f.view === "assigned_to_me") {
    where.push(`w.assignee_id = ${add(user.id)}`, `w.status NOT IN ('resolved','closed')`);
  } else if (f.view === "unassigned_urgent") {
    where.push(`w.assignee_id IS NULL`, `w.priority = 'urgent'`, `w.status NOT IN ('resolved','closed')`);
  } else if (f.view === "awaiting_my_approval") {
    const approverTeams = user.teams.filter((t) => t.role === "lead" || t.role === "admin").map((t) => t.id);
    where.push(`w.status = 'awaiting_approval'`, `w.team_id = ANY(${add(approverTeams)}::bigint[])`);
  }

  if (f.q) where.push(`w.search_vec @@ websearch_to_tsquery('english', ${add(f.q)})`);
  return { where, params, add };
}

itemsRouter.get("/", async (req, res) => {
  const user = req.user!;
  const f = listSchema.parse(req.query);
  const { where, params, add } = buildFilters(user, f);
  if (f.cursor) where.push(`w.id < ${add(f.cursor)}`); // keyset pagination: cost does not grow with page number
  const limitParam = add(f.limit + 1); // fetch one extra row to know if there is a next page
  const r = await pool.query(`${ITEM_SQL} WHERE ${where.join(" AND ")} ORDER BY w.id DESC LIMIT ${limitParam}`, params);
  const hasMore = r.rows.length > f.limit;
  const items = hasMore ? r.rows.slice(0, f.limit) : r.rows;
  res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
});

// Counts for the three dashboard views
itemsRouter.get("/summary", async (req, res) => {
  const user = req.user!;
  const views = ["assigned_to_me", "unassigned_urgent", "awaiting_my_approval"] as const;
  const counts = await Promise.all(
    views.map(async (view) => {
      const { where, params } = buildFilters(user, listSchema.parse({ view }));
      const r = await pool.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${where.join(" AND ")}`, params);
      return r.rows[0].n as number;
    })
  );
  res.json({ assigned_to_me: counts[0], unassigned_urgent: counts[1], awaiting_my_approval: counts[2] });
});

// ---------- create (idempotent) ----------

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(""),
  type: z.enum(TYPES),
  priority: z.enum(PRIORITIES),
  team_id: z.number().int().positive(),
  due_date: z.string().datetime().nullable().optional(),
});

itemsRouter.post("/", async (req, res) => {
  const user = req.user!;
  const body = createSchema.parse(req.body);
  authorize(user, "create", { team_id: body.team_id });

  const result = await idempotent(req, user.id, async (c) => {
    const r = await c.query(
      `INSERT INTO work_items (title, description, type, priority, team_id, created_by, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [body.title, body.description, body.type, body.priority, body.team_id, user.id, body.due_date ?? null]
    );
    const id = r.rows[0].id as number;
    await addEvent(c, id, user.id, "created", { title: body.title, type: body.type, priority: body.priority });
    return { status: 201, body: present(user, await getItem(c, id)) };
  });
  res.status(result.status).set("Idempotent-Replayed", String(result.replayed)).json(result.body);
});

// ---------- detail ----------

itemsRouter.get("/:id", async (req, res) => {
  const user = req.user!;
  const item = await getItem(pool, parseId(req));
  if (!item) throw new HttpError(404, "Not found");
  authorize(user, "read", item); // not in the item's team -> 404
  res.json(present(user, item));
});

// ---------- edit with optimistic locking ----------

const patchSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    due_date: z.string().datetime().nullable().optional(),
  })
  .refine((b) => ["title", "description", "priority", "due_date"].some((k) => (b as any)[k] !== undefined), {
    message: "No fields to update",
  });

itemsRouter.patch("/:id", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const body = patchSchema.parse(req.body);

  const updated = await withTx(async (c) => {
    const item = await getItem(c, id);
    if (!item) throw new HttpError(404, "Not found");
    authorize(user, "edit", item);
    if (item.status === "closed") throw new HttpError(422, "Closed items cannot be edited");

    const sets: string[] = [];
    const params: any[] = [id, body.version];
    const changed: Record<string, { from: any; to: any }> = {};
    const set = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
      changed[col] = { from: item[col], to: val };
    };
    if (body.title !== undefined && body.title !== item.title) set("title", body.title);
    if (body.description !== undefined && body.description !== item.description) set("description", body.description);
    if (body.priority !== undefined && body.priority !== item.priority) set("priority", body.priority);
    if (body.due_date !== undefined) {
      const cur = item.due_date ? new Date(item.due_date).getTime() : null;
      const next = body.due_date ? new Date(body.due_date).getTime() : null;
      if (cur !== next) set("due_date", body.due_date);
    }
    if (!sets.length) return item; // nothing actually changed

    // The version check: matches 0 rows if someone else changed the item after the client loaded it
    const r = await c.query(
      `UPDATE work_items SET ${sets.join(", ")}, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2 RETURNING id`,
      params
    );
    if (!r.rowCount) {
      throw new HttpError(409, "This item changed since you loaded it", {
        item: present(user, await getItem(c, id)),
      });
    }
    if (changed.priority) await addEvent(c, id, user.id, "priority_changed", changed.priority);
    const others = Object.keys(changed).filter((k) => k !== "priority");
    if (others.length) await addEvent(c, id, user.id, "edited", { fields: others });
    return getItem(c, id);
  });
  res.json(present(user, updated));
});

// ---------- atomic claim ----------

itemsRouter.post("/:id/claim", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const item = await withTx(async (c) => {
    const current = await getItem(c, id);
    if (!current) throw new HttpError(404, "Not found");
    authorize(user, "claim", current);

    // ONE statement decides the winner. Two simultaneous claims: the second waits for the row lock,
    // re-checks "assignee_id IS NULL", finds it taken, and updates 0 rows.
    const r = await c.query(
      `UPDATE work_items SET assignee_id = $2, version = version + 1, updated_at = now()
       WHERE id = $1 AND assignee_id IS NULL AND status NOT IN ('resolved', 'closed') RETURNING id`,
      [id, user.id]
    );
    if (!r.rowCount) {
      const cur = await getItem(c, id);
      if (cur.assignee_id === user.id) return cur; // already mine: a repeated click is a harmless success
      const why = cur.assignee_id ? `Already claimed by ${cur.assignee_name}` : `Cannot claim an item that is ${cur.status}`;
      throw new HttpError(409, why, { item: present(user, cur) });
    }
    await addEvent(c, id, user.id, "claimed", { from: null, to: user.id });
    return getItem(c, id);
  });
  res.json(present(user, item));
});

// ---------- workflow transition ----------

const transitionSchema = z.object({ to: z.enum(STATUSES), version: z.number().int().positive() });

itemsRouter.post("/:id/transition", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const body = transitionSchema.parse(req.body);

  const item = await withTx(async (c) => {
    const current = await getItem(c, id);
    if (!current) throw new HttpError(404, "Not found");
    authorize(user, "read", current); // outsiders get 404 before anything else
    const from = current.status as Status;
    if (!canTransition(from, body.to)) {
      throw new HttpError(422, `Cannot move from '${from}' to '${body.to}'`, { allowed: nextStatuses(from) });
    }
    authorize(user, actionForTransition(from, body.to), current); // approve/reject needs Lead or Admin

    // Starting work gives the item an owner if it had none
    const r = await c.query(
      `UPDATE work_items SET status = $3::text,
         assignee_id = CASE WHEN $3::text = 'in_progress' THEN COALESCE(assignee_id, $4::bigint) ELSE assignee_id END,
         version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2 RETURNING id`,
      [id, body.version, body.to, user.id]
    );
    if (!r.rowCount) {
      throw new HttpError(409, "This item changed since you loaded it", { item: present(user, await getItem(c, id)) });
    }
    await addEvent(c, id, user.id, "status_changed", { from, to: body.to });
    if (body.to === "in_progress" && current.assignee_id == null) {
      await addEvent(c, id, user.id, "assigned", { from: null, to: user.id, auto: true });
    }
    return getItem(c, id);
  });
  res.json(present(user, item));
});

// ---------- assign (Lead/Admin) + outbox job ----------

const assignSchema = z.object({
  assignee_id: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
});

itemsRouter.post("/:id/assign", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const body = assignSchema.parse(req.body);

  const item = await withTx(async (c) => {
    const current = await getItem(c, id);
    if (!current) throw new HttpError(404, "Not found");
    authorize(user, "assign", current);
    if (current.status === "closed") throw new HttpError(422, "Closed items cannot be reassigned");

    if (body.assignee_id !== null) {
      const m = await c.query(`SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2`, [body.assignee_id, current.team_id]);
      if (!m.rowCount || m.rows[0].role === "viewer") {
        throw new HttpError(422, "Assignee must be a non-viewer member of the item's team");
      }
    }
    const r = await c.query(
      `UPDATE work_items SET assignee_id = $3, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2 RETURNING version`,
      [id, body.version, body.assignee_id]
    );
    if (!r.rowCount) {
      throw new HttpError(409, "This item changed since you loaded it", { item: present(user, await getItem(c, id)) });
    }
    await addEvent(c, id, user.id, "assigned", { from: current.assignee_id, to: body.assignee_id });

    // Outbox: the job is saved in the SAME transaction as the change; a worker sends it later (Step 7)
    if (body.assignee_id !== null && body.assignee_id !== user.id) {
      await c.query(
        `INSERT INTO outbox_jobs (type, payload, dedupe_key) VALUES ('notify_assignee', $1, $2)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [JSON.stringify({ item_id: id, user_id: body.assignee_id, title: current.title }), `notify_assignee:${id}:${r.rows[0].version}`]
      );
    }
    return getItem(c, id);
  });
  res.json(present(user, item));
});

// ---------- comments + activity timeline ----------

const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) });

itemsRouter.post("/:id/comments", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const body = commentSchema.parse(req.body);
  const item = await getItem(pool, id);
  if (!item) throw new HttpError(404, "Not found");
  authorize(user, "comment", item);

  const result = await idempotent(req, user.id, async (c) => ({
    status: 201,
    body: await addEvent(c, id, user.id, "comment", { body: body.body }),
  }));
  res.status(result.status).json(result.body);
});

itemsRouter.get("/:id/activity", async (req, res) => {
  const user = req.user!;
  const id = parseId(req);
  const q = z
    .object({
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    })
    .parse(req.query);
  const item = await getItem(pool, id);
  if (!item) throw new HttpError(404, "Not found");
  authorize(user, "read", item);

  const params: any[] = [id];
  let cursorSql = "";
  if (q.cursor) {
    params.push(q.cursor);
    cursorSql = `AND e.id < $${params.length}`;
  }
  params.push(q.limit + 1);
  const r = await pool.query(
    `SELECT e.id, e.kind, e.payload, e.created_at, e.actor_id, u.name AS actor_name
     FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.item_id = $1 ${cursorSql} ORDER BY e.id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = r.rows.length > q.limit;
  const events = hasMore ? r.rows.slice(0, q.limit) : r.rows;
  res.json({ events, nextCursor: hasMore ? events[events.length - 1].id : null });
});