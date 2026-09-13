import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { withSystem } from "@/db/client";

/**
 * Provider webhook ingress. Authenticates the provider, persists the raw event,
 * dedupes by (provider, external_event_id), enqueues domain processing.
 * No long-running work inline; no user session involved.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const raw = await req.text();
  const secret = process.env[`WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, "_")}`] ?? process.env.WEBHOOK_SECRET_DEV;
  const signature = req.headers.get("x-signature") ?? "";
  let signatureValid = false;
  if (secret) {
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    signatureValid = signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const externalEventId = String(payload.id ?? "");
  if (!externalEventId) return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  if (!signatureValid) return NextResponse.json({ error: "bad_signature" }, { status: 401 });

  const result = await withSystem(async (db) => {
    // map the external account to exactly one workspace
    const integ = await db.query(
      `select * from lookup_integration($1, $2)`,
      [provider, String(payload.account ?? "")]);
    const ws = integ.rows[0] ?? null;
    const ins = await db.query(
      `insert into provider_webhook_events (provider, external_event_id, workspace_id, organization_id, signature_valid, payload_json)
       values ($1,$2,$3,$4,$5,$6) on conflict (provider, external_event_id) do nothing returning id`,
      [provider, externalEventId, ws?.workspace_id ?? null, ws?.organization_id ?? null, signatureValid, raw]);
    if (ins.rowCount === 0) return { duplicate: true };
    if (ws) {
      await db.query(
        `insert into job_runs (organization_id, workspace_id, job_type, idempotency_key, payload_json)
         values ($1,$2,'webhook.process',$3,$4) on conflict (idempotency_key) do nothing`,
        [ws.organization_id, ws.workspace_id, `webhook:${provider}:${externalEventId}`,
         JSON.stringify({ provider, externalEventId })]);
    }
    return { recorded: true, workspace: ws?.workspace_id ?? null };
  });
  return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
}
