// Canonical immutable campaign payload + content hashing.
import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted recursively, no insignificant whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/** The exact payload frozen at approval. Any material edit changes the hash. */
export interface CampaignPayload {
  schema_version: 1;
  workspace_id: string;
  campaign_id: string;
  sender_identity_id: string;
  channel: "email";
  offer_id: string | null;
  icp_id: string | null;
  claim_ids: string[];
  recipients: { person_id: string; contact_point_id: string; line?: string }[];
  sequence: {
    step_number: number;
    delay_minutes: number;
    subject_template: string;
    body_template: string;
    stop_conditions: string[];
  }[];
  personalization_rules: { allowed_variables: string[] };
  delivery: {
    timezone: string;
    send_window: { start_hour: number; end_hour: number };
    daily_workspace_cap: number;
    sender_daily_cap: number;
    per_domain_cap: number;
  };
  follow_up: { enabled: boolean };
  reply_policy: { auto_send: false };
  suppression_policy: { check_before_send: true };
}
