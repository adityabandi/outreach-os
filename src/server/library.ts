import "server-only";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canOperate, canApprove, type WorkspaceContext } from "@/domain/tenancy";
import { DomainError } from "@/server/campaigns";

/** Offers and ICPs are operator-maintained. Claims are compliance artifacts:
 *  only an approver may add one, and it is recorded as approved by them. */

export async function createOffer(ctx: WorkspaceContext, input: { name: string; description: string; pricingText: string; callToAction: string }) {
  canOperate(ctx);
  if (!input.name.trim()) throw new DomainError("validation", "offer name required");
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `insert into offers (organization_id, workspace_id, name, description, pricing_text, call_to_action)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [ctx.organizationId, ctx.workspaceId, input.name.trim(), input.description, input.pricingText, input.callToAction]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "offer.create", targetType: "offer", targetId: r.rows[0].id, metadata: { name: input.name },
    });
    return { ok: true };
  });
}

export async function archiveOffer(ctx: WorkspaceContext, offerId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`update offers set status = 'archived' where id = $1 and workspace_id = $2 and status = 'active' returning id`, [offerId, ctx.workspaceId]);
    if (r.rowCount === 0) throw new DomainError("conflict", "offer not found or already archived");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "offer.archive", targetType: "offer", targetId: offerId, metadata: {},
    });
    return { ok: true };
  });
}

export async function createIcp(ctx: WorkspaceContext, input: { name: string; criteriaJson: string; territories: string; languages: string }) {
  canOperate(ctx);
  if (!input.name.trim()) throw new DomainError("validation", "ICP name required");
  let criteria: unknown = {};
  try { criteria = input.criteriaJson.trim() ? JSON.parse(input.criteriaJson) : {}; }
  catch { throw new DomainError("validation", "criteria must be valid JSON"); }
  const csv = (s: string) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `insert into ideal_customer_profiles (organization_id, workspace_id, name, criteria_json, territories, languages)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [ctx.organizationId, ctx.workspaceId, input.name.trim(), JSON.stringify(criteria), csv(input.territories), csv(input.languages)]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "icp.create", targetType: "ideal_customer_profile", targetId: r.rows[0].id, metadata: { name: input.name },
    });
    return { ok: true };
  });
}

export async function createClaim(ctx: WorkspaceContext, input: { claimText: string; evidenceUrl: string; evidenceNote: string }) {
  canApprove(ctx);
  if (!input.claimText.trim()) throw new DomainError("validation", "claim text required");
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `insert into approved_claims (organization_id, workspace_id, claim_text, evidence_url, evidence_note, valid_from, approved_by)
       values ($1,$2,$3,$4,$5,now(),$6) returning id`,
      [ctx.organizationId, ctx.workspaceId, input.claimText.trim(), input.evidenceUrl || null, input.evidenceNote || null, ctx.actor.userId]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "claim.create", targetType: "approved_claim", targetId: r.rows[0].id,
      metadata: { claim: input.claimText, evidence_url: input.evidenceUrl || null },
    });
    return { ok: true };
  });
}

export async function retireClaim(ctx: WorkspaceContext, claimId: string) {
  canApprove(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`update approved_claims set status = 'retired', valid_until = now() where id = $1 and workspace_id = $2 and status = 'active' returning id`, [claimId, ctx.workspaceId]);
    if (r.rowCount === 0) throw new DomainError("conflict", "claim not found or already retired");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "claim.retire", targetType: "approved_claim", targetId: claimId, metadata: {},
    });
    return { ok: true };
  });
}
