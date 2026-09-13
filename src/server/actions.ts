"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSystem } from "@/db/client";
import { createSession, destroySession, requireWorkspace } from "@/server/auth";
import {
  createCampaign, saveDraftPayload, requestApproval, decideApproval,
  launchVersion, controlRun, setKillSwitch,
} from "@/server/campaigns";
import { importProspectsCsv, setContactVerification, addSuppression, liftSuppression } from "@/server/prospects";
import { ingestReply, processDueDeliveries } from "@/server/delivery";
import { setReplyDraftStatus, updateReplyDraft } from "@/server/replies";
import { updateWorkspacePolicy } from "@/server/settings";
import { archiveOffer, createClaim, createIcp, createOffer, retireClaim } from "@/server/library";
import type { CampaignPayload } from "@/domain/payload";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const user = await withSystem(async (db) => {
    const r = await db.query(`select id from users where email = $1 and status = 'active'`, [email]);
    return r.rows[0];
  });
  if (!user) redirect("/login?error=unknown");
  await createSession(user.id);
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function createCampaignAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("name required");
  const { campaignId } = await createCampaign(ctx, { name });
  revalidatePath(`/w/${slug}/campaigns`);
  redirect(`/w/${slug}/campaigns/${campaignId}`);
}

export async function saveDraftAction(slug: string, versionId: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  const recipientIds = formData.getAll("recipient").map(String);
  const recipients = [];
  for (const rid of recipientIds) {
    const [person_id, contact_point_id] = rid.split(":");
    recipients.push({ person_id, contact_point_id });
  }
  const steps = [1, 2]
    .map((n) => ({
      step_number: n,
      delay_minutes: Number(formData.get(`step${n}_delay`) ?? 0),
      subject_template: String(formData.get(`step${n}_subject`) ?? ""),
      body_template: String(formData.get(`step${n}_body`) ?? ""),
      stop_conditions: ["reply", "bounce", "unsubscribe", "conversion"],
    }))
    .filter((s) => s.body_template.trim());
  const payload: Omit<CampaignPayload, "schema_version" | "workspace_id" | "campaign_id"> = {
    sender_identity_id: String(formData.get("sender_identity_id") ?? ""),
    channel: "email",
    offer_id: String(formData.get("offer_id") ?? "") || null,
    icp_id: String(formData.get("icp_id") ?? "") || null,
    claim_ids: formData.getAll("claim_id").map(String),
    recipients,
    sequence: steps,
    personalization_rules: { allowed_variables: ["first_name", "full_name", "company", "title", "sender_name"] },
    delivery: {
      timezone: String(formData.get("timezone") ?? "UTC"),
      send_window: { start_hour: Number(formData.get("start_hour") ?? 8), end_hour: Number(formData.get("end_hour") ?? 20) },
      daily_workspace_cap: Number(formData.get("daily_workspace_cap") ?? 50),
      sender_daily_cap: Number(formData.get("sender_daily_cap") ?? 25),
      per_domain_cap: Number(formData.get("per_domain_cap") ?? 5),
    },
    follow_up: { enabled: steps.length > 1 },
    reply_policy: { auto_send: false },
    suppression_policy: { check_before_send: true },
  };
  await saveDraftPayload(ctx, versionId, payload);
  revalidatePath(`/w/${slug}`);
}

export async function requestApprovalAction(slug: string, versionId: string) {
  const ctx = await requireWorkspace(slug);
  await requestApproval(ctx, versionId);
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}/campaigns`);
}

export async function decideApprovalAction(slug: string, approvalId: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  const note = String(formData.get("note") ?? "");
  await decideApproval(ctx, approvalId, decision, note);
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}/campaigns`);
}

export async function launchAction(slug: string, versionId: string) {
  const ctx = await requireWorkspace(slug);
  await launchVersion(ctx, versionId);
  revalidatePath(`/w/${slug}`);
}

export async function runControlAction(slug: string, runId: string, action: "pause" | "resume" | "stop") {
  const ctx = await requireWorkspace(slug);
  await controlRun(ctx, runId, action);
  revalidatePath(`/w/${slug}`);
}

export async function killSwitchAction(slug: string, engaged: boolean) {
  const ctx = await requireWorkspace(slug);
  await setKillSwitch(ctx, engaged);
  revalidatePath(`/w/${slug}`);
}

export async function importCsvAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  const listName = String(formData.get("list_name") ?? "CSV import");
  const csv = String(formData.get("csv") ?? "");
  const report = await importProspectsCsv(ctx, listName, csv);
  revalidatePath(`/w/${slug}/prospects`);
  redirect(`/w/${slug}/prospects/import/result?list=${report.listId}`);
}

export async function editReplyDraftAction(slug: string, draftId: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await updateReplyDraft(ctx, draftId, String(formData.get("body") ?? ""));
  revalidatePath(`/w/${slug}/replies`);
}

export async function replyDraftStatusAction(slug: string, draftId: string, status: "sent" | "discarded") {
  const ctx = await requireWorkspace(slug);
  await setReplyDraftStatus(ctx, draftId, status);
  revalidatePath(`/w/${slug}/replies`);
}

export async function verifyContactAction(slug: string, contactPointId: string, status: "verified" | "risky" | "invalid") {
  const ctx = await requireWorkspace(slug);
  await setContactVerification(ctx, contactPointId, status);
  revalidatePath(`/w/${slug}/prospects`);
}

export async function addSuppressionAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  const expires = String(formData.get("expires_at") ?? "");
  await addSuppression(ctx, String(formData.get("value") ?? ""), String(formData.get("scope") ?? "workspace"), String(formData.get("reason") ?? "manual"), expires || null);
  revalidatePath(`/w/${slug}/suppressions`);
}

export async function updatePolicyAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await updateWorkspacePolicy(ctx, {
    dailySendCap: Number(formData.get("daily_send_cap")),
    perDomainCap: Number(formData.get("per_domain_cap")),
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function createOfferAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await createOffer(ctx, {
    name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? ""),
    pricingText: String(formData.get("pricing_text") ?? ""), callToAction: String(formData.get("call_to_action") ?? ""),
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function archiveOfferAction(slug: string, offerId: string) {
  const ctx = await requireWorkspace(slug);
  await archiveOffer(ctx, offerId);
  revalidatePath(`/w/${slug}/settings`);
}

export async function createIcpAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await createIcp(ctx, {
    name: String(formData.get("name") ?? ""), criteriaJson: String(formData.get("criteria_json") ?? ""),
    territories: String(formData.get("territories") ?? ""), languages: String(formData.get("languages") ?? ""),
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function createClaimAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await createClaim(ctx, {
    claimText: String(formData.get("claim_text") ?? ""), evidenceUrl: String(formData.get("evidence_url") ?? ""),
    evidenceNote: String(formData.get("evidence_note") ?? ""),
  });
  revalidatePath(`/w/${slug}/settings`);
}

export async function retireClaimAction(slug: string, claimId: string) {
  const ctx = await requireWorkspace(slug);
  await retireClaim(ctx, claimId);
  revalidatePath(`/w/${slug}/settings`);
}

export async function liftSuppressionAction(slug: string, entryId: string) {
  const ctx = await requireWorkspace(slug);
  await liftSuppression(ctx, entryId);
  revalidatePath(`/w/${slug}/suppressions`);
}

// dev tools: run the queue inline and simulate an inbound reply
export async function processQueueAction(slug: string) {
  const ctx = await requireWorkspace(slug);
  await processDueDeliveries(ctx.workspaceId);
  revalidatePath(`/w/${slug}`);
}

export async function simulateReplyAction(slug: string, formData: FormData) {
  const ctx = await requireWorkspace(slug);
  await ingestReply(ctx.workspaceId, {
    providerMessageId: `sim_${Date.now()}`,
    from: String(formData.get("from") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
  });
  revalidatePath(`/w/${slug}/replies`);
}
