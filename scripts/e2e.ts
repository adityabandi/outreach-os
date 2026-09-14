// End-to-end functional test against live services + DB (RLS, approval, launch, send, suppression).
import pg from "pg";
import { withTenant, withSystem } from "@/db/client";
import {
  createCampaign, saveDraftPayload, requestApproval, decideApproval, launchVersion, controlRun,
} from "@/server/campaigns";
import { processDueDeliveries, ingestReply } from "@/server/delivery";
import { importProspectsCsv, addSuppression, liftSuppression } from "@/server/prospects";
import { updateReplyDraft, setReplyDraftStatus } from "@/server/replies";
import { updateWorkspacePolicy } from "@/server/settings";
import { createOffer, createIcp, createClaim, retireClaim } from "@/server/library";
import { confirmSenderVerification, createSender, requestSenderVerification, setSenderStatus } from "@/server/senders";
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
  delivery: { timezone: "Europe/Madrid", send_window: { start_hour: 0, end_hour: 24 }, daily_workspace_cap: 50, sender_daily_cap: 25, per_domain_cap: 5 },
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

// 12. workspace policy: versions forward, admin-only
const beforePol = (await q(`select max(version)::int v from workspace_policies where workspace_id=$1`, [wsA.id])).rows[0].v;
let operatorBlocked = false;
try { await updateWorkspacePolicy(laraCtx, { dailySendCap: 40, perDomainCap: 4 }); } catch (e: any) { operatorBlocked = e.name === "AuthzError"; }
const adminCtx: WorkspaceContext = { ...adiCtx, roles: ["workspace_admin", "approver"] };
const upd = await updateWorkspacePolicy(adminCtx, { dailySendCap: 60, perDomainCap: 6 });
const afterPol = (await q(`select max(version)::int v, (select daily_send_cap from workspace_policies where workspace_id=$1 order by version desc limit 1) cap from workspace_policies where workspace_id=$1`, [wsA.id])).rows[0];
const polAudit = (await q(`select count(*)::int n from audit_events where action='policy.update' and metadata_json->'daily_send_cap'->>'to'='60'`)).rows[0].n;
check("policy versions forward, admin-only, audited", operatorBlocked && upd.ok && afterPol.v === beforePol + 1 && afterPol.cap === 60 && polAudit === 1, `v${beforePol}->v${afterPol.v}`);

// 13. content library: operators manage offers/ICPs, claims are approver-gated
const adiFull: WorkspaceContext = { ...adiCtx, roles: ["workspace_admin", "approver"] };
await createOffer(laraCtx, { name: "E2E Offer", description: "d", pricingText: "$1", callToAction: "try" });
await createIcp(laraCtx, { name: "E2E ICP", criteriaJson: '{"topics":["test"]}', territories: "us, uk", languages: "en" });
let claimBlocked = false;
try { await createClaim(laraCtx, { claimText: "E2E claim", evidenceUrl: "", evidenceNote: "" }); } catch (e: any) { claimBlocked = e.name === "AuthzError"; }
await createClaim(adiFull, { claimText: "E2E claim", evidenceUrl: "https://e2e.example/proof", evidenceNote: "" });
const claimRow = (await q(`select id, approved_by from approved_claims where claim_text='E2E claim'`)).rows[0];
await retireClaim(adiFull, claimRow.id);
const claimGone = (await q(`select status from approved_claims where id=$1`, [claimRow.id])).rows[0].status;
check("library: operator creates offer/ICP, claims approver-gated + retired",
  claimBlocked && claimRow.approved_by === adi.id && claimGone === "retired");

// 14. sender verification lifecycle: admin-only, emailed code, expiry, disable stops sends
let createDenied = false;
try { await createSender(laraCtx, { displayName: "Nope", address: "nope@ayurvedanest.org", dailyCap: 5 }); }
catch (e: any) { createDenied = e.name === "AuthzError"; }
const { senderId: e2eSender } = await createSender(adiFull, { displayName: "E2E Sender", address: "E2E.Sender@ayurvedanest.org", dailyCap: 5 });
let dupDenied = false;
try { await createSender(adiFull, { displayName: "Dup", address: "e2e.sender@ayurvedanest.org", dailyCap: 5 }); }
catch (e: any) { dupDenied = e.code === "conflict"; }
await requestSenderVerification(adiFull, e2eSender);
const pend = (await q(`select verification_status, verification_token_hash, verification_expires_at from sender_identities where id=$1`, [e2eSender])).rows[0];
const vmail = (await q(
  `select body from outbox_messages where to_address='e2e.sender@ayurvedanest.org' order by created_at desc limit 1`)).rows[0];
const vcode = vmail?.body.match(/ {2}(\d{6})\n/)?.[1];
const wrongCode = vcode === "000000" ? "000001" : "000000";
let wrongDenied = false;
try { await confirmSenderVerification(adiFull, e2eSender, wrongCode); } catch (e: any) { wrongDenied = e.code === "verification_mismatch"; }
const stillPending = (await q(`select verification_status from sender_identities where id=$1`, [e2eSender])).rows[0].verification_status;
await confirmSenderVerification(adiFull, e2eSender, vcode ?? "xxxxxx");
const verifiedRow = (await q(
  `select verification_status, verified_at, verification_token_hash from sender_identities where id=$1`, [e2eSender])).rows[0];
check("sender verification: admin-only, unique address, code emailed, mismatch rejected, correct code verifies",
  createDenied && dupDenied && pend.verification_status === "pending" && !!pend.verification_token_hash &&
  !!pend.verification_expires_at && !!vcode && wrongDenied && stillPending === "pending" &&
  verifiedRow.verification_status === "verified" && !!verifiedRow.verified_at && !verifiedRow.verification_token_hash);

// 15. expired code fails the sender; re-request restores pending
const { senderId: expSender } = await createSender(adiFull, { displayName: "E2E Expiry", address: "e2e.expiry@ayurvedanest.org", dailyCap: 5 });
await requestSenderVerification(adiFull, expSender);
await q(`update sender_identities set verification_expires_at = now() - interval '1 hour' where id=$1`, [expSender]);
let expiredDenied = false;
try { await confirmSenderVerification(adiFull, expSender, "123456"); } catch (e: any) { expiredDenied = e.code === "verification_expired"; }
const failedRow = (await q(`select verification_status, verification_token_hash from sender_identities where id=$1`, [expSender])).rows[0];
await requestSenderVerification(adiFull, expSender);
const rePend = (await q(`select verification_status from sender_identities where id=$1`, [expSender])).rows[0].verification_status;
check("sender verification: expiry fails + clears code, re-request returns to pending",
  expiredDenied && failedRow.verification_status === "failed" && !failedRow.verification_token_hash && rePend === "pending");

// 16. disabling a sender skips its already-scheduled deliveries at send time
// fresh recipient: sofia is suppressed and arjun has replied by this point
const guardPerson = (await q(
  `insert into people (organization_id, workspace_id, full_name, normalized_email)
   values ($1,$2,'E2E Guard','e2e.guard@example.com') returning id`, [wsA.organization_id, wsA.id])).rows[0];
const guardCp = (await q(
  `insert into contact_points (organization_id, workspace_id, person_id, normalized_value, verification_status)
   values ($1,$2,$3,'e2e.guard@example.com','verified') returning id`, [wsA.organization_id, wsA.id, guardPerson.id])).rows[0];
const guardRecips = [{ person_id: guardPerson.id, contact_point_id: guardCp.id }];
const { campaignId: guardCid, versionId: guardVid } = await createCampaign(laraCtx, { name: "E2E Sender Guard" });
await saveDraftPayload(laraCtx, guardVid, {
  sender_identity_id: e2eSender, channel: "email", offer_id: null, icp_id: null, claim_ids: [],
  recipients: guardRecips,
  sequence: [{ step_number: 1, delay_minutes: 0, subject_template: "Guard {{first_name}}", body_template: "Body for {{first_name}}.", stop_conditions: ["reply","bounce","unsubscribe","conversion"] }],
  personalization_rules: { allowed_variables: ["first_name","full_name","company","title","sender_name"] },
  delivery: { timezone: "Europe/Madrid", send_window: { start_hour: 0, end_hour: 24 }, daily_workspace_cap: 50, sender_daily_cap: 25, per_domain_cap: 5 },
  follow_up: { enabled: false }, reply_policy: { auto_send: false }, suppression_policy: { check_before_send: true },
});
await withTenant(wsA.id, (db) => Promise.all(guardRecips.map((r) =>
  db.query(`insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id) values ($1,$2,$3) on conflict do nothing`, [guardVid, r.person_id, r.contact_point_id]))));
const guardApproval = await requestApproval(laraCtx, guardVid);
await decideApproval(adiCtx, guardApproval.approvalId, "approved", "e2e guard");
await launchVersion(laraCtx, guardVid);
await setSenderStatus(adiFull, e2eSender, "disabled");
const guardRes = await processDueDeliveries(wsA.id);
const guardRows = (await q(
  `select status, error_code, count(*) from message_deliveries where campaign_version_id=$1 group by 1,2`, [guardVid])).rows;
check("disabled sender: readiness-blocked at send time, deliveries skipped not sent",
  guardRes.sent === 0 && guardRows.length === 1 && guardRows[0].status === "skipped" && guardRows[0].error_code === "sender_unavailable",
  JSON.stringify(guardRows));

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
await q(`delete from audit_events where action='policy.update'`);
await q(`delete from workspace_policies where workspace_id=$1 and version > 1`, [wsA.id]);
await q(`delete from audit_events where action in ('offer.create','icp.create','claim.create','claim.retire')`);
await q(`delete from approved_claims where claim_text='E2E claim'`);
await q(`delete from offers where name='E2E Offer'`);
await q(`delete from ideal_customer_profiles where name='E2E ICP'`);
await q(`delete from outbox_messages where subject in ('Hi Sofia','Hi Arjun') or subject like 'Re: Hi%'`);
await q(`delete from job_runs where job_type='campaign.schedule'`);
await q(`delete from delivery_events where message_delivery_id in (select id from message_deliveries where campaign_version_id=$1)`, [guardVid]);
await q(`delete from message_deliveries where campaign_version_id=$1`, [guardVid]);
await q(`delete from campaign_runs where campaign_version_id=$1`, [guardVid]);
await q(`delete from approval_requests where resource_id=$1`, [guardVid]);
await q(`delete from campaign_version_recipients where campaign_version_id=$1`, [guardVid]);
await q(`delete from campaign_versions where id=$1`, [guardVid]);
await q(`delete from campaigns where id=$1`, [guardCid]);
await q(`delete from outbox_messages where to_address like 'e2e.%@ayurvedanest.org'`);
await q(`delete from audit_events where action like 'sender.%'`);
await q(`delete from sender_identities where address like 'e2e.%@ayurvedanest.org'`);
await q(`delete from contact_points where normalized_value='e2e.guard@example.com'`);
await q(`delete from people where normalized_email='e2e.guard@example.com'`);
await sys.end();
process.exit(fail > 0 ? 1 : 0);
