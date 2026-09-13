// Roles and authorization. Server-side checks on every command and query.
export type WorkspaceRole = "workspace_admin" | "campaign_operator" | "approver" | "analyst";
export type OrgRole = "org_owner";

export interface Actor {
  userId: string;
  email: string;
  displayName: string;
}

export interface WorkspaceContext {
  actor: Actor;
  organizationId: string;
  workspaceId: string;
  workspaceSlug: string;
  roles: WorkspaceRole[];
  isOrgOwner: boolean;
}

export class AuthzError extends Error {
  code = "authorization";
  constructor(message = "not authorized") {
    super(message);
    this.name = "AuthzError";
  }
}

export function requireRole(ctx: WorkspaceContext, ...roles: WorkspaceRole[]) {
  if (ctx.isOrgOwner) return; // org owners hold every workspace capability
  if (!roles.some((r) => ctx.roles.includes(r))) {
    throw new AuthzError(`requires role: ${roles.join(" or ")}`);
  }
}

export const canOperate = (c: WorkspaceContext) => requireRole(c, "campaign_operator", "workspace_admin");
export const canApprove = (c: WorkspaceContext) => requireRole(c, "approver");
export const canAdmin = (c: WorkspaceContext) => requireRole(c, "workspace_admin");
export const canRead = (_c: WorkspaceContext) => {};
