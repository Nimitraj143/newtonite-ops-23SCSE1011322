import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ZodError } from "zod";
import { authRouter } from "./auth";
import { itemsRouter } from "./items";
import { HttpError } from "./errors";
import { notificationsRouter } from "./notifications";


export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use("/items", itemsRouter);
  app.use("/notifications", notificationsRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof ZodError) return res.status(400).json({ error: "Invalid input", details: err.issues });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}