// End-to-end functional test against live services + DB (RLS, approval, launch, send, suppression).
import pg from "pg";
import { withTenant, withSystem } from "@/db/client";
import {
  createCampaign, saveDraftPayload, requestApproval, decideApproval, launchVersion, controlRun,
} from "@/server/campaigns";
import { processDueDeliveries, ingestReply } from "@/server/delivery";
import { importProspectsCsv, addSuppression, liftSuppression } from "@/server/prospects";
import { updateReplyDraft, setReplyDraftStatus } from "@/server/replies";
import type { WorkspaceContext } from "@/domain/tenancy";

const sys = new pg.Client("postgres://outreach:outreach@localhost:5433/outreach_os");
await sys.connect();
const q = (t: string, p?: unknown[]) => sys.query(t, p as never[]);

const wsA = (await q(`select id, organization_id from workspaces where slug='ayurveda-nest'`)).rows[0];
const wsB = (await q(`select id from workspaces where slug='northwind-demo'`)).rows[0];
const adi = (await q(`select id, email, display_name from users where email='adi@bandi.dev'`)).rows[0];
const lara = (await q(`select id, email, display_name from users where email='lara@ayurvedanest.org'`)).rows[0];

const laraCtx: WorkspaceContext = {
  actor: { userId: lara.id, email: lara.email, displayName: lara.display_name },
  organizationId: wsA.organization_id, workspaceId: wsA.id, workspaceSlug: "ayurveda-nest",
  roles: ["campaign_operator"], isOrgOwner: false,
};
const adiCtx: WorkspaceContext = {
  actor: { userId: adi.id, email: adi.email, displayName: adi.display_name },
  organizationId: wsA.organization_id, workspaceId: wsA.id, workspaceSlug: "ayurveda-nest",
  roles: ["approver"], isOrgOwner: false,
};

const sender = (await q(`select id from sender_identities where address='lara@ayurvedanest.org'`)).rows[0];
const recips = (await q(
  `select p.id person_id, cp.id contact_point_id from people p join contact_points cp on cp.person_id=p.id
    where p.normalized_email in ('sofia@herbaldaily.io','arjun@vedicliving.in') and cp.verification_status='verified'`)).rows;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " - " + extra : ""}`);
  ok ? pass++ : fail++;
};

// 1. draft -> save -> approval
const { campaignId, versionId } = await createCampaign(laraCtx, { name: "E2E Flow Check" });
await saveDraftPayload(laraCtx, versionId, {
  sender_identity_id: sender.id, channel: "email", offer_id: null, icp_id: null, claim_ids: [],
  recipients: recips,
  sequence: [
    { step_number: 1, delay_minutes: 0, subject_template: "Hi {{first_name}}", body_template: "Body one for {{first_name}} at {{company}}.", stop_conditions: ["reply","bounce","unsubscribe","conversion"] },
    { step_number: 2, delay_minutes: 60, subject_template: "Re: Hi {{first_name}}", body_template: "Follow-up for {{first_name}}.", stop_conditions: ["reply","bounce","unsubscribe","conversion"] },
  ],
  personalization_rules: { allowed_variables: ["first_name","full_name","company","title","sender_name"] },
  delivery: { timezone: "Europe/Madrid", send_window: { start_hour: 0, end_hour: 23 }, daily_workspace_cap: 50, sender_daily_cap: 25, per_domain_cap: 5 },
  follow_up: { enabled: true }, reply_policy: { auto_send: false }, suppression_policy: { check_before_send: true },
});
// recipients manifest table (normally set by the builder save path)
await withTenant(wsA.id, (db) => Promise.all(recips.map((r) =>
  db.query(`insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id) values ($1,$2,$3) on conflict do nothing`, [versionId, r.person_id, r.contact_point_id]))));

// 2. launch without approval must fail
let blocked = false;
try { await launchVersion(laraCtx, versionId); } catch (e: any) { blocked = e.code === "approval" || e.name === "StateError"; }
check("launch without approval refused", blocked);

const { approvalId, hash } = await requestApproval(laraCtx, versionId);

// 3. requester cannot approve own version
blocked = false;
try { await decideApproval(laraCtx as WorkspaceContext, approvalId, "approved", ""); } catch (e: any) { blocked = e.code === "authorization" || e.name === "AuthzError"; }
check("requester cannot self-approve", blocked);

// 4. cross-tenant read returns nothing (RLS)
const cross = await withTenant(wsB.id, (db) => db.query(`select count(*)::int n from campaigns`));
check("RLS: workspace B sees 0 of A's campaigns", cross.rows[0].n === 0);

// 5a. DB trigger makes approved versions immutable
await decideApproval(adiCtx, approvalId, "approved", "e2e ok");
let tamperBlocked = false;
await q(`update campaign_versions set payload_json = payload_json || '{"delivery":{"per_domain_cap":99}}' where id = $1`, [versionId])
  .catch(() => { tamperBlocked = true; });
check("DB trigger blocks mutation of approved version", tamperBlocked);

// 5b. hash mismatch at launch is refused (simulate stale approval)
await q(`update approval_requests set payload_hash = 'deadbeef' where id = $1`, [approvalId]);
blocked = false;
try { await launchVersion(laraCtx, versionId); } catch (e: any) { blocked = e.code === "approval_mismatch"; }
check("stale approval hash refuses launch", blocked);
await q(`update approval_requests set payload_hash = $2 where id = $1`, [approvalId, hash]);

const { runId, scheduled } = await launchVersion(laraCtx, versionId);
check("launch after valid approval schedules step 1", scheduled === 2, `${scheduled} scheduled`);

// 6. process queue: sends via mock adapter, idempotent
let r = await processDueDeliveries(wsA.id);
const sent1 = (await q(`select count(*)::int n from message_deliveries where campaign_run_id=$1 and status='sent'`, [runId])).rows[0].n;
check("step 1 sent to both recipients", sent1 === 2, `${sent1} sent`);
r = await processDueDeliveries(wsA.id);
const sentAfterRerun = (await q(`select count(*)::int n from message_deliveries where campaign_run_id=$1 and status='sent'`, [runId])).rows[0].n;
check("re-processing is idempotent (no duplicates)", sentAfterRerun === 2);
const outbox = (await q(`select count(*)::int n from outbox_messages where workspace_id=$1 and to_address like '%herbaldaily%' or to_address like '%vedicliving%'`, [wsA.id])).rows[0].n;
check("mock mailbox recorded the sends", outbox >= 2, `${outbox} outbox rows`);

// 7. unsubscribe reply suppresses immediately and skips follow-ups
await ingestReply(wsA.id, { providerMessageId: `e2e_unsub_${Date.now()}`, from: "sofia@herbaldaily.io", subject: "Re: Hi", body: "Please unsubscribe me." });
const sup = (await q(`select 1 from suppression_entries where normalized_value='sofia@herbaldaily.io'`)).rowCount;
const skipped = (await q(`select count(*)::int n from message_deliveries where campaign_run_id=$1 and status in ('skipped','suppressed')`, [runId])).rows[0].n;
check("unsubscribe suppresses + kills follow-up", (sup ?? 0) > 0 && skipped >= 1, `${skipped} stopped`);

// 8. pause blocks remaining sends
await controlRun(laraCtx, runId, "pause");
const before = (await q(`select count(*)::int n from message_deliveries where campaign_run_id=$1 and status='sent'`, [runId])).rows[0].n;
await q(`update message_deliveries set scheduled_at = now() - interval '1 minute' where campaign_run_id=$1 and status='scheduled'`, [runId]);
await processDueDeliveries(wsA.id);
const after = (await q(`select count(*)::int n from message_deliveries where campaign_run_id=$1 and status='sent'`, [runId])).rows[0].n;
check("paused run sends nothing", before === after);

// 9. audit trail covers the lifecycle
const acts = (await q(`select distinct action from audit_events where target_id in ($1::uuid, $2::uuid, $3::uuid) or metadata_json->>'run_id' = $2::text`, [versionId, runId, campaignId])).rows.map((x) => x.action);
check("audit trail records lifecycle", ["campaign.create","approval.request","approval.approved","campaign.launch","campaign.pause"].every((a) => acts.includes(a)), acts.join(","));

// 9b. reply draft review: edit, finalize, immutability after finalize
const unsubIn = await ingestReply(wsA.id, { providerMessageId: `e2e_draft_${Date.now()}`, from: "arjun@vedicliving.in", subject: "Re: Hi", body: "Interesting, what are the terms?" });
const draftRow = (await q(`select id, status from reply_drafts where inbound_message_id=$1`, [unsubIn.inboundId])).rows[0];
await updateReplyDraft(laraCtx, draftRow.id, "Edited by a human: terms are $5 monthly, $30 annual.");
await setReplyDraftStatus(laraCtx, draftRow.id, "sent");
let editAfterFinal = false;
try { await updateReplyDraft(laraCtx, draftRow.id, "tamper"); } catch (e: any) { editAfterFinal = e.code === "conflict"; }
const draftAudit = (await q(`select distinct action from audit_events where target_id=$1`, [draftRow.id])).rows.map((x) => x.action);
check("reply draft editable then immutable after finalize, audited",
  editAfterFinal && draftAudit.includes("reply_draft.edited") && draftAudit.includes("reply_draft.marked_sent_externally"),
  draftAudit.join(","));

// 10. CSV import: first run imports, re-import merges without duplicating, suppressed + invalid rows reported
const csv1 = "full_name,email,title,company,domain,country\nE2E Person,e2e.person@example.com,Dev,E2E Co,e2e.example,US\nBad Row,not-an-email,,,,";
const r1 = await importProspectsCsv(laraCtx, "E2E Import", csv1);
const csv2 = "full_name,email,title,company,domain,country\nE2E Person,e2e.person@example.com,Dev,E2E Co,e2e.example,US\nNina P,nina@slowapothecary.com,Founder,Slow Apothecary,slowapothecary.com,UK";
const r2 = await importProspectsCsv(laraCtx, "E2E Import 2", csv2);
const personCount = (await q(`select count(*)::int n from people where normalized_email='e2e.person@example.com'`)).rows[0].n;
check("import creates new prospects and reports invalid rows", r1.imported === 1 && r1.skipped === 1, JSON.stringify({ i: r1.imported, s: r1.skipped }));
check("re-import merges, never duplicates; suppressed emails rejected", r2.merged === 1 && r2.suppressed === 1 && personCount === 1, JSON.stringify({ m: r2.merged, sup: r2.suppressed, people: personCount }));

// 11. suppression lifecycle: add with expiry, lift expires it, both audited
await addSuppression(laraCtx, "e2e-blocked@example.com", "workspace", "e2e test");
const blockedRow = (await q(`select id from suppression_entries where normalized_value='e2e-blocked@example.com' and (expires_at is null or expires_at > now())`)).rows[0];
await liftSuppression(laraCtx, blockedRow.id);
const stillActive = (await q(`select count(*)::int n from suppression_entries where normalized_value='e2e-blocked@example.com' and (expires_at is null or expires_at > now())`)).rows[0].n;
const supAudit = (await q(`select distinct action from audit_events where action in ('suppression.add','suppression.lift') and metadata_json->>'value'='e2e-blocked@example.com'`)).rows.map((x) => x.action);
check("suppression add + lift lifecycle audited", stillActive === 0 && supAudit.includes("suppression.add") && supAudit.includes("suppression.lift"), supAudit.join(","));

console.log(`\n${pass} passed, ${fail} failed`);
// cleanup e2e campaign so the demo state stays pristine (children first)
const cid = campaignId;
await q(`delete from reply_drafts where inbound_message_id in (select id from inbound_messages where provider_message_id like 'e2e_%')`);
await q(`delete from reply_classifications where inbound_message_id in (select id from inbound_messages where provider_message_id like 'e2e_%')`);
await q(`delete from inbound_messages where provider_message_id like 'e2e_%'`);
await q(`delete from delivery_events where message_delivery_id in (select md.id from message_deliveries md join campaign_versions cv on cv.id=md.campaign_version_id where cv.campaign_id=$1)`, [cid]);
await q(`delete from message_deliveries where campaign_version_id in (select id from campaign_versions where campaign_id=$1)`, [cid]);
await q(`delete from campaign_runs where campaign_version_id in (select id from campaign_versions where campaign_id=$1)`, [cid]);
await q(`delete from approval_requests where resource_id in (select id from campaign_versions where campaign_id=$1)`, [cid]);
await q(`delete from campaign_version_recipients where campaign_version_id in (select id from campaign_versions where campaign_id=$1)`, [cid]);
await q(`delete from campaign_versions where campaign_id=$1`, [cid]);
await q(`delete from campaigns where id=$1`, [cid]);
await q(`delete from suppression_entries where normalized_value='sofia@herbaldaily.io'`);
await q(`delete from prospect_list_members where prospect_list_id in (select id from prospect_lists where name like 'E2E Import%')`);
await q(`delete from evidence_items where subject_id in (select id from people where normalized_email='e2e.person@example.com')`);
await q(`delete from contact_points where normalized_value='e2e.person@example.com'`);
await q(`delete from people where normalized_email='e2e.person@example.com'`);
await q(`delete from companies where normalized_domain='e2e.example'`);
await q(`delete from audit_events where target_id in (select id from prospect_lists where name like 'E2E Import%')`);
await q(`delete from prospect_lists where name like 'E2E Import%'`);
await q(`delete from suppression_entries where normalized_value='e2e-blocked@example.com'`);
await q(`delete from outbox_messages where subject in ('Hi Sofia','Hi Arjun') or subject like 'Re: Hi%'`);
await q(`delete from job_runs where job_type='campaign.schedule'`);
await sys.end();
process.exit(fail > 0 ? 1 : 0);
