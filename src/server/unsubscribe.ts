import "server-only";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { verifyUnsubToken } from "@/domain/unsubscribe";

/**
 * Public one-click unsubscribe. No session: the HMAC token is the authority.
 * Writes a workspace-scope suppression (idempotent) and audits it. Scheduled
 * deliveries are stopped by the existing pre-send suppression re-check, and
 * the person-level reply stop-condition covers follow-ups.
 */
export async function recordUnsubscribe(token: string): Promise<{ ok: boolean; email?: string }> {
  const parsed = verifyUnsubToken(token);
  if (!parsed) return { ok: false };
  const { workspaceId, contactPointId, email } = parsed;
  return withTenant(workspaceId, async (db) => {
    // the token binds workspace + contact + address; re-check they still match
    const cp = await db.query(
      `select cp.normalized_value, cp.person_id, cp.workspace_id, p.organization_id
         from contact_points cp join people p on p.id = cp.person_id
        where cp.id = $1`, [contactPointId]);
    const row = cp.rows[0];
    if (!row || row.workspace_id !== workspaceId || row.normalized_value !== email) return { ok: false };
    await db.query(
      `insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source)
       values ($1,$2,'workspace',$3,'unsubscribe_link','unsubscribe_link') on conflict do nothing`,
      [row.organization_id, workspaceId, email]);
    await audit(db, {
      organizationId: row.organization_id, workspaceId,
      actorType: "webhook", actorId: null,
      action: "suppression.add", targetType: "suppression_entry",
      metadata: { scope: "workspace", value: email, reason: "unsubscribe_link", person_id: row.person_id },
    });
    return { ok: true, email };
  });
}
