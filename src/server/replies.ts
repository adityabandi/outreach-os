import "server-only";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canOperate, type WorkspaceContext } from "@/domain/tenancy";
import { DomainError } from "@/server/campaigns";

/**
 * Human review of reply drafts. Drafts are never auto-sent (hard product rule);
 * an operator edits the draft, then sends it from their own mail client and marks
 * it sent here, or discards it. Every transition is audited.
 */
/** Mark a warm reply handled: a human has seen it and responded (or chosen not to). */
export async function markReplyHandled(ctx: WorkspaceContext, inboundId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update inbound_messages set handled_at = now(), handled_by = $2
        where id = $1 and handled_at is null returning id`,
      [inboundId, ctx.actor.userId]);
    if (r.rowCount === 0) throw new DomainError("missing", "reply not found or already handled");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "reply.handled", targetType: "inbound_message", targetId: inboundId,
      metadata: {},
    });
    return { ok: true };
  });
}

export async function updateReplyDraft(ctx: WorkspaceContext, draftId: string, body: string) {
  canOperate(ctx);
  if (!body.trim()) throw new DomainError("validation", "draft body cannot be empty");
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update reply_drafts set body = $3
        where id = $1 and workspace_id = $2 and status = 'draft'
        returning id`, [draftId, ctx.workspaceId, body]);
    if (r.rowCount === 0) throw new DomainError("conflict", "draft not found or no longer editable");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "reply_draft.edited", targetType: "reply_draft", targetId: draftId,
      metadata: { chars: body.length },
    });
    return { ok: true };
  });
}

export async function setReplyDraftStatus(ctx: WorkspaceContext, draftId: string, status: "sent" | "discarded") {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update reply_drafts set status = $3
        where id = $1 and workspace_id = $2 and status in ('draft','pending_approval')
        returning id`, [draftId, ctx.workspaceId, status]);
    if (r.rowCount === 0) throw new DomainError("conflict", "draft not found or already finalized");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: status === "sent" ? "reply_draft.marked_sent_externally" : "reply_draft.discarded",
      targetType: "reply_draft", targetId: draftId, metadata: {},
    });
    return { ok: true };
  });
}
