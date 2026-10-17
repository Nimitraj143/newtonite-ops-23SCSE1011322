import type { Action } from "./permissions";

export const STATUSES = ["open", "in_progress", "awaiting_approval", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];

// Which status can move to which. Anything not listed is rejected by the server.
export const TRANSITIONS: Record<Status, Status[]> = {
  open: ["in_progress"],
  in_progress: ["open", "awaiting_approval"],
  awaiting_approval: ["in_progress", "resolved"], // reject -> in_progress, approve -> resolved
  resolved: ["closed", "in_progress"],            // close, or reopen
  closed: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: Status): Status[] {
  return TRANSITIONS[from];
}

// Leaving "awaiting_approval" (approve or reject) needs a Lead/Admin; other moves need only "transition".
export function actionForTransition(from: Status, _to: Status): Action {
  return from === "awaiting_approval" ? "approve" : "transition";
}