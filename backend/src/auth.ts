import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "./db";
import { HttpError } from "./errors";
import { AuthUser, Role } from "./permissions";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

async function loadUser(id: number): Promise<AuthUser | null> {
  const u = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [id]);
  if (!u.rowCount) return null;
  const m = await pool.query(
    `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.id`,
    [id]
  );
  const teams = m.rows.map((r) => ({ id: Number(r.id), name: r.name as string, role: r.role as Role }));
  return {
    id: Number(u.rows[0].id),
    email: u.rows[0].email,
    name: u.rows[0].name,
    roles: new Map(teams.map((t) => [t.id, t.role])),
    teams,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Missing token");
  let payload: { sub: string };
  try {
    payload = jwt.verify(header.slice(7), getSecret()) as { sub: string };
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }
  const user = await loadUser(Number(payload.sub));
  if (!user) throw new HttpError(401, "Unknown user");
  req.user = user;
  next();
}

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const r = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
  const ok = r.rowCount ? await bcrypt.compare(password, r.rows[0].password_hash) : false;
  if (!ok) throw new HttpError(401, "Invalid email or password");
  const token = jwt.sign({ sub: String(r.rows[0].id) }, getSecret(), { expiresIn: "8h" });
  const user = await loadUser(Number(r.rows[0].id));
  res.json({ token, user: { id: user!.id, email: user!.email, name: user!.name, teams: user!.teams } });
});

authRouter.get("/me", authenticate, (req, res) => {
  const u = req.user!;
  res.json({ id: u.id, email: u.email, name: u.name, teams: u.teams });
});