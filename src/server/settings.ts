import "server-only";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canAdmin, type WorkspaceContext } from "@/domain/tenancy";
import { DomainError } from "@/server/campaigns";

/**
 * Workspace policy changes are versioned, never mutated in place: each save
 * inserts policy version N+1 and audits the delta. Admin-only.
 * reply_auto_send is deliberately not editable - replies never auto-send in v1.
 */
export async function updateWorkspacePolicy(
  ctx: WorkspaceContext,
  input: { dailySendCap: number; perDomainCap: number },
) {
  canAdmin(ctx);
  if (!Number.isInteger(input.dailySendCap) || input.dailySendCap < 1 || input.dailySendCap > 10000)
    throw new DomainError("validation", "daily cap must be 1-10000");
  if (!Number.isInteger(input.perDomainCap) || input.perDomainCap < 1 || input.perDomainCap > 1000)
    throw new DomainError("validation", "per-domain cap must be 1-1000");
  return withTenant(ctx.workspaceId, async (db) => {
    const cur = await db.query(
      `select * from workspace_policies where workspace_id = $1 order by version desc limit 1`, [ctx.workspaceId]);
    const prev = cur.rows[0];
    const r = await db.query(
      `insert into workspace_policies (organization_id, workspace_id, version, daily_send_cap, per_domain_cap, allowed_channels, reply_auto_send_policy, retention_json, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, version`,
      [ctx.organizationId, ctx.workspaceId, (prev?.version ?? 0) + 1,
       input.dailySendCap, input.perDomainCap,
       prev?.allowed_channels ?? ["email"], prev?.reply_auto_send_policy ?? { mode: "off" },
       prev?.retention_json ?? {}, ctx.actor.userId]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "policy.update", targetType: "workspace_policy", targetId: r.rows[0].id,
      metadata: {
        version: r.rows[0].version,
        daily_send_cap: { from: prev?.daily_send_cap ?? null, to: input.dailySendCap },
        per_domain_cap: { from: prev?.per_domain_cap ?? null, to: input.perDomainCap },
      },
    });
    return { ok: true, version: r.rows[0].version };
  });
}
