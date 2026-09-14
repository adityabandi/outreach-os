import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant, type Db } from "@/db/client";
import { audit } from "@/domain/audit";
import { matchesSuppression, withinSendWindow, domainOf } from "@/domain/compliance";
import { payloadHash, type CampaignPayload } from "@/domain/payload";
import { assertTransition, type CampaignState, type RunState } from "@/domain/state-machine";
import { canApprove, canOperate, type WorkspaceContext } from "@/domain/tenancy";
import { MockMailboxAdapter } from "@/domain/adapters/mock-mailbox";
import { MockModelAdapter } from "@/domain/adapters/mock-model";

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function renderTemplate(tpl: string, vars: Record<string, string>, allowed: string[]): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, name) => {
    if (!allowed.includes(name)) throw new DomainError("validation", `variable {{${name}}} is not in the allowed set`);
    if (!(name in vars)) throw new DomainError("validation", `missing value for {{${name}}}`);
    return vars[name];
  });
}

// ---------- campaign + draft version ----------

export async function createCampaign(ctx: WorkspaceContext, input: { name: string; offerId?: string; icpId?: string }) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `insert into campaigns (organization_id, workspace_id, name, offer_id, icp_id, created_by)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [ctx.organizationId, ctx.workspaceId, input.name, input.offerId ?? null, input.icpId ?? null, ctx.actor.userId],
    );
    const campaignId = r.rows[0].id as string;
    const v = await db.query(
      `insert into campaign_versions (campaign_id, version_number, payload_json, status, created_by)
       values ($1, 1, '{}', 'draft', $2) returning id`,
      [campaignId, ctx.actor.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "campaign.create", targetType: "campaign", targetId: campaignId,
      metadata: { name: input.name },
    });
    return { campaignId, versionId: v.rows[0].id as string };
  });
}

export async function saveDraftPayload(
  ctx: WorkspaceContext,
  versionId: string,
  payload: Omit<CampaignPayload, "schema_version" | "workspace_id" | "campaign_id">,
) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const v = await db.query(
      `select cv.id, cv.status, cv.campaign_id, c.workspace_id from campaign_versions cv
         join campaigns c on c.id = cv.campaign_id where cv.id = $1 for update`,
      [versionId],
    );
    if (v.rowCount === 0 || v.rows[0].workspace_id !== ctx.workspaceId)
      throw new DomainError("tenancy", "version not found");
    if (v.rows[0].status !== "draft" && v.rows[0].status !== "rejected")
      throw new DomainError("conflict", `version is ${v.rows[0].status}; create a new version to edit`);
    const full: CampaignPayload = {
      schema_version: 1,
      workspace_id: ctx.workspaceId,
      campaign_id: v.rows[0].campaign_id,
      ...payload,
    };
    await db.query("update campaign_versions set payload_json = $2, payload_hash = null where id = $1", [
      versionId, JSON.stringify(full),
    ]);
    // materialize the recipients manifest from the payload (same transaction):
    // readiness, launch and the approval page all read this table
    await db.query(`delete from campaign_version_recipients where campaign_version_id = $1`, [versionId]);
    for (const r of payload.recipients) {
      await db.query(
        `insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id)
         values ($1,$2,$3) on conflict do nothing`, [versionId, r.person_id, r.contact_point_id]);
    }
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "campaign_version.edit_draft", targetType: "campaign_version", targetId: versionId,
      metadata: { recipients: payload.recipients.length, steps: payload.sequence.length },
    });
    return { ok: true };
  });
}

// ---------- readiness validation ----------

export interface ReadinessIssue { level: "error" | "warning"; code: string; message: string }

export async function validateReadiness(db: Db, ctx: WorkspaceContext, versionId: string) {
  const issues: ReadinessIssue[] = [];
  const vr = await db.query(
    `select cv.*, c.workspace_id from campaign_versions cv join campaigns c on c.id = cv.campaign_id
      where cv.id = $1`, [versionId]);
  if (vr.rowCount === 0) return { ok: false, issues: [{ level: "error" as const, code: "missing", message: "version not found" }] };
  const payload = vr.rows[0].payload_json as CampaignPayload;
  if (!payload || !payload.sender_identity_id) {
    issues.push({ level: "error", code: "no_sender", message: "No sender identity configured." });
    return { ok: false, issues };
  }
  const sender = await db.query(`select * from sender_identities where id = $1`, [payload.sender_identity_id]);
  if (sender.rowCount === 0) issues.push({ level: "error", code: "sender_missing", message: "Sender identity does not exist." });
  else if (sender.rows[0].verification_status !== "verified")
    issues.push({ level: "error", code: "sender_unverified", message: `Sender ${sender.rows[0].address} is not verified.` });
  else if (sender.rows[0].status !== "active")
    issues.push({ level: "error", code: "sender_disabled", message: `Sender ${sender.rows[0].address} is disabled.` });

  if (!payload.recipients?.length) issues.push({ level: "error", code: "no_recipients", message: "Recipient list is empty." });
  if (!payload.sequence?.length) issues.push({ level: "error", code: "no_sequence", message: "Sequence has no steps." });

  const contacts = await db.query(
    `select cp.id, cp.verification_status, cp.do_not_contact, cp.normalized_value,
            p.full_name, p.normalized_email
       from campaign_version_recipients cvr
       join contact_points cp on cp.id = cvr.contact_point_id
       join people p on p.id = cvr.person_id
      where cvr.campaign_version_id = $1`, [versionId]);
  const byId = new Map(contacts.rows.map((r) => [r.id, r]));
  let unverified = 0;
  for (const rec of payload.recipients ?? []) {
    const cp = byId.get(rec.contact_point_id);
    if (!cp) { issues.push({ level: "error", code: "contact_missing", message: `Recipient ${rec.person_id} has no stored contact point.` }); continue; }
    if (cp.do_not_contact) issues.push({ level: "error", code: "dnc", message: `${cp.normalized_value} is marked do-not-contact.` });
    if (cp.verification_status === "unverified" || cp.verification_status === "invalid") { unverified++; }
    if (cp.verification_status === "risky")
      issues.push({ level: "warning", code: "risky_contact", message: `${cp.normalized_value} is marked risky - sends will go out, review recommended.` });
  }
  if (unverified > 0)
    issues.push({ level: "error", code: "unverified_contacts", message: `${unverified} recipient(s) do not have a verified contact route.` });

  const sup = await db.query(`select scope, normalized_value, expires_at from suppression_entries`);
  let suppressedCount = 0;
  for (const rec of payload.recipients ?? []) {
    const cp = byId.get(rec.contact_point_id);
    if (cp && matchesSuppression(sup.rows, cp.normalized_value).suppressed) suppressedCount++;
  }
  if (suppressedCount > 0)
    issues.push({ level: "error", code: "suppressed_recipients", message: `${suppressedCount} recipient(s) are on the suppression list.` });

  if (payload.claim_ids?.length) {
    const claims = await db.query(`select id, status from approved_claims where id = any($1::uuid[])`, [payload.claim_ids]);
    const active = new Set(claims.rows.filter((c) => c.status === "active").map((c) => c.id));
    const missing = payload.claim_ids.filter((id) => !active.has(id));
    if (missing.length) issues.push({ level: "error", code: "claims_inactive", message: `${missing.length} referenced claim(s) are not active approved claims.` });
  }
  const domains = new Map<string, number>();
  for (const rec of payload.recipients ?? []) {
    const cp = byId.get(rec.contact_point_id);
    if (cp) { const d = domainOf(cp.normalized_value); domains.set(d, (domains.get(d) ?? 0) + 1); }
  }
  for (const [d, n] of domains) {
    if (n > (payload.delivery?.per_domain_cap ?? 5))
      issues.push({ level: "warning", code: "domain_concentration", message: `${n} recipients at ${d} exceed the per-domain cap of ${payload.delivery?.per_domain_cap}; extra sends will roll to later days.` });
  }
  const usesLine = (payload.sequence ?? []).some(
    (st) => /\{\{\s*personalization_line\s*\}\}/.test(st.subject_template) || /\{\{\s*personalization_line\s*\}\}/.test(st.body_template));
  if (usesLine) {
    const missing = (payload.recipients ?? []).filter((r) => !r.line?.trim()).length;
    if (missing > 0)
      issues.push({ level: "error", code: "personalization_missing",
        message: `${missing} recipient(s) have no personalization line - generate or write one, or remove {{personalization_line}} from the copy.` });
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ---------- personalization ----------

/**
 * Draft one evidence-backed personalization line per recipient via the model
 * adapter. Drafts/rejected versions only; lines land inside payload_json, so
 * they are hash-locked and approved exactly like the copy they appear in.
 */
export async function generatePersonalization(ctx: WorkspaceContext, versionId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const v = await db.query(
      `select cv.*, c.workspace_id from campaign_versions cv join campaigns c on c.id = cv.campaign_id
        where cv.id = $1 for update`, [versionId]);
    const row = v.rows[0];
    if (!row || row.workspace_id !== ctx.workspaceId) throw new DomainError("tenancy", "version not found");
    if (row.status !== "draft" && row.status !== "rejected")
      throw new DomainError("conflict", `version is ${row.status}; only drafts can be edited`);
    const payload = row.payload_json as CampaignPayload;
    if (!payload.recipients?.length) throw new DomainError("validation", "save a draft with recipients first");
    const offer = payload.offer_id
      ? (await db.query(`select name from offers where id = $1`, [payload.offer_id])).rows[0]
      : null;
    const model = new MockModelAdapter();
    let generated = 0;
    const recipients = [];
    for (const r of payload.recipients) {
      const person = (await db.query(
        `select p.full_name, p.title, co.name as company from people p
           left join companies co on co.id = p.company_id where p.id = $1`, [r.person_id])).rows[0];
      if (!person) { recipients.push(r); continue; }
      const ev = await db.query(
        `select excerpt from evidence_items where subject_type = 'person' and subject_id = $1
          order by observed_at desc limit 2`, [r.person_id]);
      const { line } = await model.generatePersonalization({
        firstName: person.full_name.split(" ")[0], fullName: person.full_name,
        company: person.company ?? "", title: person.title ?? "",
        offerName: offer?.name ?? null, evidence: ev.rows.map((x) => x.excerpt as string),
      });
      recipients.push({ ...r, line });
      generated++;
    }
    await db.query(`update campaign_versions set payload_json = $2, payload_hash = null where id = $1`,
      [versionId, JSON.stringify({ ...payload, recipients })]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "campaign_version.personalize", targetType: "campaign_version", targetId: versionId,
      metadata: { generated, model: model.provider },
    });
    return { generated };
  });
}

// ---------- approval ----------

export async function requestApproval(ctx: WorkspaceContext, versionId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const v = await db.query(
      `select cv.*, c.workspace_id, c.status as campaign_status, c.id as campaign_id
         from campaign_versions cv join campaigns c on c.id = cv.campaign_id
        where cv.id = $1 for update of cv`, [versionId]);
    if (v.rowCount === 0 || v.rows[0].workspace_id !== ctx.workspaceId) throw new DomainError("tenancy", "version not found");
    // spec: DRAFT -> READY_FOR_REVIEW (validation gate) -> APPROVAL_PENDING (freeze)
    assertTransition(v.rows[0].status as CampaignState, "ready_for_review");
    assertTransition("ready_for_review", "approval_pending");
    const check = await validateReadiness(db, ctx, versionId);
    if (!check.ok) throw new DomainError("validation", `readiness failed: ${check.issues.filter(i=>i.level==="error").map(i=>i.message).join(" | ")}`);
    const hash = payloadHash(v.rows[0].payload_json);
    await db.query(`update campaign_versions set payload_hash = $2, status = 'approval_pending' where id = $1`, [versionId, hash]);
    await db.query(`update campaigns set status = 'approval_pending' where id = $1`, [v.rows[0].campaign_id]);
    await db.query(`update approval_requests set status = 'superseded'
                     where resource_type = 'campaign_version' and resource_id = $1 and status = 'pending'`, [versionId]);
    const ar = await db.query(
      `insert into approval_requests (organization_id, workspace_id, resource_type, resource_id, payload_hash, requested_by)
       values ($1,$2,'campaign_version',$3,$4,$5) returning id`,
      [ctx.organizationId, ctx.workspaceId, versionId, hash, ctx.actor.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "approval.request", targetType: "campaign_version", targetId: versionId,
      metadata: { payload_hash: hash },
    });
    return { approvalId: ar.rows[0].id as string, hash };
  });
}

export async function decideApproval(
  ctx: WorkspaceContext, approvalId: string, decision: "approved" | "rejected", note: string,
) {
  canApprove(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from approval_requests where id = $1 for update`, [approvalId]);
    if (r.rowCount === 0 || r.rows[0].workspace_id !== ctx.workspaceId) throw new DomainError("tenancy", "approval request not found");
    const req = r.rows[0];
    if (req.status !== "pending") throw new DomainError("conflict", `approval already ${req.status}`);
    if (req.requested_by === ctx.actor.userId && decision === "approved")
      throw new DomainError("authorization", "requester cannot approve their own campaign version");
    const v = await db.query(`select * from campaign_versions where id = $1`, [req.resource_id]);
    const recomputed = payloadHash(v.rows[0].payload_json);
    if (recomputed !== req.payload_hash)
      throw new DomainError("approval_mismatch", "payload changed since approval was requested; request a new approval");
    await db.query(
      `update approval_requests set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`,
      [approvalId, decision, ctx.actor.userId, note || null]);
    const vStatus = decision === "approved" ? "approved" : "rejected";
    await db.query(`update campaign_versions set status = $2 where id = $1`, [req.resource_id, vStatus]);
    await db.query(`update campaigns set status = $2 where id = (select campaign_id from campaign_versions where id = $1)`,
      [req.resource_id, vStatus]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: `approval.${decision}`, targetType: "campaign_version", targetId: req.resource_id,
      metadata: { payload_hash: req.payload_hash, note: note || null },
    });
    return { ok: true };
  });
}

// ---------- launch & run control ----------

export async function launchVersion(ctx: WorkspaceContext, versionId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const v = await db.query(
      `select cv.*, c.workspace_id, c.organization_id from campaign_versions cv
         join campaigns c on c.id = cv.campaign_id where cv.id = $1 for update of cv`, [versionId]);
    if (v.rowCount === 0 || v.rows[0].workspace_id !== ctx.workspaceId) throw new DomainError("tenancy", "version not found");
    const ver = v.rows[0];

    // verify approval + hash BEFORE any state change (spec F.1)
    const approved = await db.query(
      `select payload_hash from approval_requests
        where resource_type = 'campaign_version' and resource_id = $1 and status = 'approved'
        order by decided_at desc limit 1`, [versionId]);
    if (approved.rowCount === 0) throw new DomainError("approval", "no approval recorded for this version");
    const recomputed = payloadHash(ver.payload_json);
    if (recomputed !== approved.rows[0].payload_hash)
      throw new DomainError("approval_mismatch", "payload hash differs from the approved hash - launch refused");

    const kill = await db.query(
      `select w.kill_switch as ws, o.kill_switch as org from workspaces w
         join organizations o on o.id = w.organization_id where w.id = $1`, [ctx.workspaceId]);
    if (kill.rows[0].org || kill.rows[0].ws) throw new DomainError("kill_switch", "send kill switch is engaged");

    // APPROVED -> SCHEDULED -> RUNNING per the state machine
    assertTransition(ver.status as CampaignState, "scheduled");
    assertTransition("scheduled", "running");

    const payload = ver.payload_json as CampaignPayload;
    const integ = await db.query(
      `select status from integrations where provider = 'mock-mailbox' and status != 'healthy' limit 1`);
    if (integ.rowCount && integ.rows.length > 0) throw new DomainError("provider_unavailable", "mailbox integration unhealthy");

    const run = await db.query(
      `insert into campaign_runs (campaign_version_id, status, launched_by, launched_at)
       values ($1, 'running', $2, now()) returning id`, [versionId, ctx.actor.userId]);
    const runId = run.rows[0].id as string;
    await db.query(`update campaign_versions set status = 'running' where id = $1`, [versionId]);
    await db.query(`update campaigns set status = 'running' where id = $1`, [ver.campaign_id]);

    // Schedule step 1 for every recipient. Suppression + DNC re-checked at schedule time.
    const sup = (await db.query(`select scope, normalized_value, expires_at from suppression_entries`)).rows;
    const contacts = await db.query(
      `select cvr.person_id, cvr.contact_point_id, cp.normalized_value, cp.do_not_contact
         from campaign_version_recipients cvr join contact_points cp on cp.id = cvr.contact_point_id
        where cvr.campaign_version_id = $1`, [versionId]);
    const byPair = new Map(contacts.rows.map((r) => [`${r.person_id}:${r.contact_point_id}`, r]));
    const step1 = payload.sequence.find((s) => s.step_number === 1);
    if (!step1) throw new DomainError("validation", "sequence has no step 1");
    const stepRow = await db.query(
      `select id from sequence_steps where template_id = (select id from sequence_templates limit 1) and step_number = 1 limit 1`);
    const sender = await db.query(`select * from sender_identities where id = $1`, [payload.sender_identity_id]);

    let scheduled = 0, suppressed = 0;
    for (const rec of payload.recipients) {
      const c = byPair.get(`${rec.person_id}:${rec.contact_point_id}`);
      if (!c) continue;
      const idem = `${versionId}:${rec.person_id}:1`;
      const hit = matchesSuppression(sup, c.normalized_value);
      const status = c.do_not_contact || hit.suppressed ? "suppressed" : "scheduled";
      if (status === "suppressed") suppressed++; else scheduled++;
      await db.query(
        `insert into message_deliveries
           (organization_id, workspace_id, campaign_run_id, campaign_version_id, person_id, contact_point_id,
            sequence_step_id, step_number, sender_identity_id, idempotency_key, scheduled_at, status)
         values ($1,$2,$3,$4,$5,$6,$7,1,$8,$9, now(), $10)
         on conflict (idempotency_key) do nothing`,
        [ctx.organizationId, ctx.workspaceId, runId, versionId, rec.person_id, rec.contact_point_id,
         stepRow.rows[0]?.id ?? null, payload.sender_identity_id, idem, status]);
    }
    await db.query(
      `insert into job_runs (organization_id, workspace_id, job_type, idempotency_key, payload_json)
       values ($1,$2,'campaign.schedule',$3,$4) on conflict (idempotency_key) do nothing`,
      [ctx.organizationId, ctx.workspaceId, `schedule:${runId}`, JSON.stringify({ runId })]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "campaign.launch", targetType: "campaign_version", targetId: versionId,
      metadata: { run_id: runId, scheduled, suppressed, sender: sender.rows[0]?.address },
    });
    return { runId, scheduled, suppressed };
  });
}

export async function controlRun(ctx: WorkspaceContext, runId: string, action: "pause" | "resume" | "stop") {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select cr.*, c.workspace_id from campaign_runs cr
         join campaign_versions cv on cv.id = cr.campaign_version_id
         join campaigns c on c.id = cv.campaign_id where cr.id = $1 for update of cr`, [runId]);
    if (r.rowCount === 0 || r.rows[0].workspace_id !== ctx.workspaceId) throw new DomainError("tenancy", "run not found");
    const from = r.rows[0].status as RunState;
    const to: RunState = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
    const legal: Record<RunState, RunState[]> = {
      scheduled: ["stopped"], running: ["paused", "stopped"], paused: ["running", "stopped"],
      stopped: [], completed: [], failed: [],
    };
    if (!legal[from]?.includes(to)) throw new DomainError("conflict", `cannot ${action} a ${from} run`);
    await db.query(
      `update campaign_runs set status = $2,
         paused_by = case when $2 = 'paused' then $3 else paused_by end,
         paused_at = case when $2 = 'paused' then now() else paused_at end,
         stop_reason = case when $2 = 'stopped' then 'operator stop' else stop_reason end
       where id = $1`, [runId, to, ctx.actor.userId]);
    if (to === "running" || to === "stopped" || to === "paused") {
      await db.query(`update campaign_versions set status = $2 where id = $1`, [r.rows[0].campaign_version_id, to]);
      await db.query(
        `update campaigns set status = $2 where id = (select campaign_id from campaign_versions where id = $1)`,
        [r.rows[0].campaign_version_id, to]);
    }
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: `campaign.${action}`, targetType: "campaign_run", targetId: runId,
      metadata: { from, to },
    });
    return { ok: true, status: to };
  });
}

export async function setKillSwitch(ctx: WorkspaceContext, engaged: boolean) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    await db.query(`update workspaces set kill_switch = $2 where id = $1`, [ctx.workspaceId, engaged]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: engaged ? "kill_switch.engage" : "kill_switch.release",
      targetType: "workspace", targetId: ctx.workspaceId,
    });
    return { ok: true };
  });
}
