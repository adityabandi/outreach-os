// Conversion intake: map an external signup/revenue event (Rewardful, Stripe)
// back to the person, campaign and delivery that sourced it, then record one
// deduplicated conversions row. Discount code match wins; email is the fallback.
import { audit } from "@/domain/audit";
import type { Db } from "@/db/client";

export class ConversionError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ConversionError"; }
}

export interface ConversionEventInput {
  externalRef: string;          // provider's unique event/referral id - dedupe key
  eventType: "signup" | "revenue" | "meeting";
  provider: string;             // rewardful | stripe | ...
  code?: string | null;         // discount / referral code used at signup
  email?: string | null;        // signup email, fallback matcher
  amount?: number | null;
  currency?: string | null;
  occurredAt?: string | null;
}

export type ConversionOutcome =
  | { recorded: true; matchedBy: "code" | "email"; personId: string; campaignId: string | null }
  | { recorded: false; reason: "duplicate" | "no_match" };

const normCode = (c: string) => c.trim().toUpperCase().replace(/\s+/g, "");
const normEmail = (e: string) => e.trim().toLowerCase();

export async function recordConversionEvent(
  db: Db,
  ids: { organizationId: string; workspaceId: string },
  input: ConversionEventInput,
): Promise<ConversionOutcome> {
  const externalRef = String(input.externalRef ?? "").trim();
  if (!externalRef) throw new ConversionError("validation", "external event reference required");

  // 1. match by discount code, then by signup email
  let personId: string | null = null;
  let campaignId: string | null = null;
  let matchedBy: "code" | "email" | null = null;
  if (input.code) {
    const r = await db.query(
      `select person_id, campaign_id from conversion_codes where normalized_code = $1`,
      [normCode(input.code)]);
    if (r.rows[0]) {
      personId = r.rows[0].person_id as string;
      campaignId = (r.rows[0].campaign_id as string | null) ?? null;
      matchedBy = "code";
    }
  }
  if (!personId && input.email) {
    const r = await db.query(
      `select person_id from contact_points where normalized_value = $1 limit 1`,
      [normEmail(input.email)]);
    if (r.rows[0]) { personId = r.rows[0].person_id as string; matchedBy = "email"; }
  }
  if (!personId || !matchedBy) return { recorded: false, reason: "no_match" };

  // 2. attribute: most recent sent delivery for this person (in-campaign when known)
  const d = await db.query(
    `select md.id, cv.campaign_id from message_deliveries md
       join campaign_versions cv on cv.id = md.campaign_version_id
      where md.person_id = $1 and md.status = 'sent'
        ${campaignId ? "and cv.campaign_id = $2" : ""}
      order by md.sent_at desc limit 1`,
    campaignId ? [personId, campaignId] : [personId]);
  const deliveryId = (d.rows[0]?.id as string | undefined) ?? null;
  if (!campaignId) campaignId = (d.rows[0]?.campaign_id as string | undefined) ?? null;

  // 3. record once per external reference
  const ins = await db.query(
    `insert into conversions (organization_id, workspace_id, person_id, campaign_id, message_delivery_id,
                              event_type, external_ref, value_amount, currency, occurred_at, attribution_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now()), $11)
     on conflict (workspace_id, external_ref) where external_ref is not null do nothing
     returning id`,
    [ids.organizationId, ids.workspaceId, personId, campaignId, deliveryId,
     input.eventType, externalRef, input.amount ?? null, input.currency ?? null,
     input.occurredAt ?? null,
     JSON.stringify({ provider: input.provider, code: input.code ?? null, matched_by: matchedBy })]);
  if (ins.rowCount === 0) return { recorded: false, reason: "duplicate" };

  await audit(db, {
    organizationId: ids.organizationId, workspaceId: ids.workspaceId,
    actorType: "system", actorId: null,
    action: "conversion.recorded", targetType: "conversion", targetId: ins.rows[0].id as string,
    metadata: { provider: input.provider, matched_by: matchedBy, event_type: input.eventType, external_ref: externalRef },
  });
  return { recorded: true, matchedBy, personId, campaignId };
}
