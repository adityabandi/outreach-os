import type { Db } from "@/db/client";

export type AuditActorType = "user" | "system" | "worker" | "webhook";

export interface AuditEntry {
  organizationId: string;
  workspaceId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEYS = /secret|token|password|key|credential/i;

/** Redact anything that looks like a secret before it touches the audit trail. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? "[redacted]" : redact(v),
      ]),
    );
  }
  return value;
}

/** Append-only audit writer. Never updates, never deletes. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_events
       (organization_id, workspace_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.organizationId,
      entry.workspaceId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.requestId ?? null,
      JSON.stringify(redact(entry.metadata ?? {})),
    ],
  );
}
