import { HttpError } from "./errors";

export type Role = "viewer" | "member" | "lead" | "admin";
export type Action = "read" | "create" | "comment" | "claim" | "edit" | "transition" | "approve" | "assign";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  roles: Map<number, Role>; // teamId -> role
  teams: { id: number; name: string; role: Role }[];
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2, admin: 3 };

const MIN_ROLE: Record<Action, Role> = {
  read: "viewer",
  create: "member",
  comment: "member",
  claim: "member",
  edit: "member",
  transition: "member",
  approve: "lead",
  assign: "lead",
};

export interface Resource {
  team_id: number;
  assignee_id?: number | null;
}

// The ONLY place that decides whether a user may do something.
export function authorize(user: AuthUser, action: Action, resource: Resource): Role {
  const role = user.roles.get(Number(resource.team_id));
  if (!role) throw new HttpError(404, "Not found");
  if (RANK[role] < RANK[MIN_ROLE[action]]) {
    throw new HttpError(403, `Role '${role}' cannot ${action} items in this team`);
  }
  if ((action === "edit" || action === "transition") && role === "member") {
    const a = resource.assignee_id;
    if (a != null && Number(a) !== user.id) {
      throw new HttpError(403, "Only the assignee or a lead can change this item");
    }
  }
  return role;
}

export function readableTeamIds(user: AuthUser): number[] {
  return [...user.roles.keys()];
}