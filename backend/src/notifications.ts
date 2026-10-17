import { Router } from "express";
import { authenticate } from "./auth";
import { pool } from "./db";

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get("/", async (req, res) => {
  const r = await pool.query(
    `SELECT id, item_id, message, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
    [req.user!.id]
  );
  res.json({ notifications: r.rows });
});