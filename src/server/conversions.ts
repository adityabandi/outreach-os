// Tenant-bound wrappers around the pure conversion mapping (domain/conversions).
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { DomainError } from "@/server/campaigns";
import { canOperate, type WorkspaceContext } from "@/domain/tenancy";
import { recordConversionEvent, type ConversionEventInput } from "@/domain/conversions";

export type { ConversionEventInput, ConversionOutcome } from "@/domain/conversions";
export { recordConversionEvent } from "@/domain/conversions";

/** Tenant wrapper used by the queue worker. */
export async function recordConversionForWorkspace(workspaceId: string, input: ConversionEventInput) {
  return withTenant(workspaceId, async (db) => {
    const ws = await db.query(`select organization_id from workspaces where id = $1`, [workspaceId]);
    return recordConversionEvent(db, { organizationId: ws.rows[0].organization_id as string, workspaceId }, input);
  });
}

const normCode = (c: string) => c.trim().toUpperCase().replace(/\s+/g, "");

/** Register a discount/referral code for a recipient (operator action, audited). */
export async function registerConversionCode(
  ctx: WorkspaceContext,
  input: { code: string; personId: string; campaignId?: string | null; source?: string },
) {
  canOperate(ctx);
  const code = normCode(input.code);
  if (code.length < 3) throw new DomainError("validation", "code too short");
  return withTenant(ctx.workspaceId, async (db) => {
    const person = await db.query(`select id from people where id = $1`, [input.personId]);
    if (person.rowCount === 0) throw new DomainError("tenancy", "person not found");
    const r = await db.query(
      `insert into conversion_codes (organization_id, workspace_id, normalized_code, display_code, person_id, campaign_id, source)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (workspace_id, normalized_code) do update set person_id = excluded.person_id, campaign_id = excluded.campaign_id
       returning id`,
      [ctx.organizationId, ctx.workspaceId, code, input.code.trim(), input.personId, input.campaignId ?? null, input.source ?? "manual"]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "conversion_code.register", targetType: "conversion_code", targetId: r.rows[0].id as string,
      metadata: { code: input.code.trim(), person_id: input.personId, campaign_id: input.campaignId ?? null },
    });
    return { id: r.rows[0].id as string, code };
  });
}
