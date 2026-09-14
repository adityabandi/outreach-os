import "server-only";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canAdmin, type WorkspaceContext } from "@/domain/tenancy";
import { MockMailboxAdapter } from "@/domain/adapters/mock-mailbox";
import {
  VERIFICATION_TTL_MS,
  checkVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  isValidEmail,
  normalizeAddress,
} from "@/domain/senders";
import { DomainError } from "@/server/campaigns";

/**
 * Sender identity lifecycle. Admin-only: a sender is the face of every email
 * the workspace sends, so creating and verifying one is a workspace-admin
 * capability. Verification proves control of the address via an emailed code;
 * campaigns refuse unverified senders at readiness-check time, and the
 * delivery loop re-checks verification + active status immediately before
 * every send, so disabling a sender stops even already-scheduled deliveries.
 */
export async function createSender(
  ctx: WorkspaceContext,
  input: { displayName: string; address: string; dailyCap: number },
) {
  canAdmin(ctx);
  const address = normalizeAddress(input.address);
  const displayName = input.displayName.trim();
  if (!displayName) throw new DomainError("validation", "display name required");
  if (!isValidEmail(address)) throw new DomainError("validation", "sender address must be a valid email");
  if (!Number.isInteger(input.dailyCap) || input.dailyCap < 1 || input.dailyCap > 10000)
    throw new DomainError("validation", "daily cap must be 1-10000");
  return withTenant(ctx.workspaceId, async (db) => {
    const existing = await db.query(
      `select id from sender_identities where workspace_id = $1 and lower(address) = $2`,
      [ctx.workspaceId, address],
    );
    if (existing.rowCount) throw new DomainError("conflict", `${address} already exists as a sender`);
    const r = await db.query(
      `insert into sender_identities (organization_id, workspace_id, display_name, address, daily_cap, created_by)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [ctx.organizationId, ctx.workspaceId, displayName, address, input.dailyCap, ctx.actor.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "sender.create", targetType: "sender_identity", targetId: r.rows[0].id,
      metadata: { address, display_name: displayName, daily_cap: input.dailyCap },
    });
    return { senderId: r.rows[0].id as string };
  });
}

/**
 * Email a 6-digit verification code to the sender address through the
 * workspace mailbox adapter. Only the hash is stored; the code itself never
 * touches the database or the audit trail. Allowed from unverified/failed and
 * from pending (acts as resend, rotating the code).
 */
export async function requestSenderVerification(ctx: WorkspaceContext, senderId: string) {
  canAdmin(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from sender_identities where id = $1`, [senderId]);
    const s = r.rows[0];
    if (!s) throw new DomainError("missing", "sender not found");
    if (s.status !== "active") throw new DomainError("validation", "sender is disabled");
    if (s.verification_status === "verified")
      throw new DomainError("validation", `${s.address} is already verified`);
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    await db.query(
      `update sender_identities
          set verification_status = 'pending', verification_token_hash = $2,
              verification_expires_at = $3, verification_sent_at = now()
        where id = $1`,
      [senderId, hashVerificationCode(code), expiresAt],
    );
    const adapter = new MockMailboxAdapter(db, ctx.workspaceId);
    await adapter.send({
      fromAddress: s.address, fromName: s.display_name, toAddress: s.address,
      subject: "Verify your Outreach OS sender address",
      body: [
        `Hi ${s.display_name},`,
        ``,
        `Your sender verification code for ${s.address} is:`,
        ``,
        `  ${code}`,
        ``,
        `It expires in 24 hours. Enter it under Settings > Senders to start sending from this address.`,
      ].join("\n"),
      idempotencyKey: `sender-verify:${senderId}:${Date.now()}`,
    });
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "sender.verification_request", targetType: "sender_identity", targetId: senderId,
      metadata: { address: s.address, expires_at: expiresAt.toISOString() },
    });
    return { ok: true };
  });
}

export async function confirmSenderVerification(ctx: WorkspaceContext, senderId: string, code: string) {
  canAdmin(ctx);
  // The verdict commits (failed status + audit) before the error is thrown -
  // throwing inside withTenant would roll the failure bookkeeping back.
  const outcome = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from sender_identities where id = $1`, [senderId]);
    const s = r.rows[0];
    if (!s) throw new DomainError("missing", "sender not found");
    if (s.verification_status === "verified")
      throw new DomainError("validation", `${s.address} is already verified`);
    const verdict = checkVerificationCode(
      { tokenHash: s.verification_token_hash, expiresAt: s.verification_expires_at },
      code,
    );
    if (verdict === "ok") {
      await db.query(
        `update sender_identities
            set verification_status = 'verified', verified_at = now(),
                verification_token_hash = null, verification_expires_at = null
          where id = $1`,
        [senderId],
      );
      await audit(db, {
        organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
        actorType: "user", actorId: ctx.actor.userId,
        action: "sender.verified", targetType: "sender_identity", targetId: senderId,
        metadata: { address: s.address },
      });
      return { verdict };
    }
    if (verdict === "expired" || verdict === "no_request") {
      await db.query(
        `update sender_identities
            set verification_status = 'failed', verification_token_hash = null, verification_expires_at = null
          where id = $1`,
        [senderId],
      );
    }
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "sender.verification_failed", targetType: "sender_identity", targetId: senderId,
      metadata: { address: s.address, reason: verdict },
    });
    return { verdict };
  });
  if (outcome.verdict !== "ok") {
    throw new DomainError(
      `verification_${outcome.verdict}`,
      outcome.verdict === "mismatch"
        ? "That code does not match - check the latest verification email and try again."
        : "The verification code expired - request a new one.",
    );
  }
  return { ok: true };
}

/** Disable stops every future and already-scheduled send from this sender. */
export async function setSenderStatus(ctx: WorkspaceContext, senderId: string, status: "active" | "disabled") {
  canAdmin(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update sender_identities set status = $2 where id = $1 returning address, status`,
      [senderId, status],
    );
    if (r.rowCount === 0) throw new DomainError("missing", "sender not found");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "sender.status", targetType: "sender_identity", targetId: senderId,
      metadata: { address: r.rows[0].address, status },
    });
    return { ok: true };
  });
}
