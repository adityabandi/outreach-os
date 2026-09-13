import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal query surface so the ingress logic is testable without next/server. */
export interface WebhookDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export type WebhookOutcome =
  | { status: 400; body: { error: "invalid_json" | "missing_event_id" } }
  | { status: 401; body: { error: "bad_signature" } }
  | { status: 200; body: { duplicate: true } }
  | { status: 202; body: { recorded: true; workspace: string | null } };

export function webhookSecretFor(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, "_")}`] ?? env.WEBHOOK_SECRET_DEV;
}

export function verifyWebhookSignature(secret: string | undefined, raw: string, signature: string): boolean {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Webhook ingress core: authenticate, persist raw event, dedupe by
 * (provider, external_event_id), enqueue domain processing. No long-running
 * work inline. Runs pre-tenancy; account->workspace mapping goes through the
 * security-definer lookup_integration() because RLS hides integrations.
 */
export async function handleWebhookPost(
  provider: string,
  raw: string,
  signature: string,
  secret: string | undefined,
  withSystem: <T>(fn: (db: WebhookDb) => Promise<T>) => Promise<T>,
): Promise<WebhookOutcome> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const externalEventId = String(payload.id ?? "");
  if (!externalEventId) return { status: 400, body: { error: "missing_event_id" } };
  if (!verifyWebhookSignature(secret, raw, signature)) return { status: 401, body: { error: "bad_signature" } };

  const result = await withSystem(async (db) => {
    const integ = await db.query(`select * from lookup_integration($1, $2)`, [provider, String(payload.account ?? "")]);
    const ws = integ.rows[0] ?? null;
    const ins = await db.query(
      `insert into provider_webhook_events (provider, external_event_id, workspace_id, organization_id, signature_valid, payload_json)
       values ($1,$2,$3,$4,$5,$6) on conflict (provider, external_event_id) do nothing returning id`,
      [provider, externalEventId, ws?.workspace_id ?? null, ws?.organization_id ?? null, true, raw]);
    if (ins.rowCount === 0) return { duplicate: true as const };
    if (ws) {
      await db.query(
        `insert into job_runs (organization_id, workspace_id, job_type, idempotency_key, payload_json)
         values ($1,$2,'webhook.process',$3,$4) on conflict (idempotency_key) do nothing`,
        [ws.organization_id, ws.workspace_id, `webhook:${provider}:${externalEventId}`,
         JSON.stringify({ provider, externalEventId })]);
    }
    return { recorded: true as const, workspace: (ws?.workspace_id as string | undefined) ?? null };
  });
  return result.duplicate ? { status: 200, body: result } : { status: 202, body: result };
}
