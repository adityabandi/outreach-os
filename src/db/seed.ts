// Demo seed: two isolated workspaces with realistic campaign state.
import { Client } from "./client";
import { payloadHash, type CampaignPayload } from "@/domain/payload";

const client = new Client({
  connectionString: process.env.SEED_DATABASE_URL ?? "postgres://outreach:outreach@localhost:5433/outreach_os",
});
await client.connect();
const q = (text: string, params?: unknown[]) => client.query(text, params as never[]);
const one = async (text: string, params?: unknown[]) => (await q(text, params)).rows[0];

await q("truncate organizations cascade");
await q("truncate users cascade");
await q("delete from sessions");

const org = await one(`insert into organizations (name) values ('Bandi Ventures') returning id`);
const orgId = org.id;

const aditya = await one(`insert into users (email, display_name) values ('adi@bandi.dev','Aditya Bandi') returning id`);
const lara = await one(`insert into users (email, display_name) values ('lara@ayurvedanest.org','Lara Vidal') returning id`);
const priya = await one(`insert into users (email, display_name) values ('priya@bandi.dev','Priya Shah') returning id`);
await q(`insert into organization_memberships (organization_id, user_id, role) values ($1,$2,'org_owner')`, [orgId, aditya.id]);

// ---------- workspace A: Ayurveda Nest ----------
const wsA = await one(`insert into workspaces (organization_id, name, slug, domain, default_timezone)
  values ($1,'Ayurveda Nest','ayurveda-nest','ayurvedanest.org','Europe/Madrid') returning id`, [orgId]);
const A = wsA.id;
await q(`insert into workspace_memberships (workspace_id, user_id, role) values
  ($1,$2,'workspace_admin'), ($1,$2,'approver'), ($1,$3,'campaign_operator'), ($1,$4,'analyst')`,
  [A, aditya.id, lara.id, priya.id]);
await q(`insert into workspace_policies (organization_id, workspace_id, daily_send_cap, per_domain_cap, created_by)
  values ($1,$2,50,5,$3)`, [orgId, A, aditya.id]);

const offer = await one(`insert into offers (organization_id, workspace_id, name, description, pricing_text, call_to_action)
  values ($1,$2,'Ayurveda Nest Pro','Subscription wellness plans with guided Ayurvedic programs.',
  '$19/month or $120/year, price locked for the life of the subscription','Start a 7-day free trial') returning id`, [orgId, A]);
const icp = await one(`insert into ideal_customer_profiles (organization_id, workspace_id, name, criteria_json, exclusions_json, territories, languages)
  values ($1,$2,'Wellness creators','{"audience":"5k-500k","topics":["ayurveda","yoga","holistic health"],"platforms":["instagram","youtube","tiktok"]}',
  '{"exclude":["competitor brands","inactive 90d+"]}','{"US","UK","ES","IN"}','{"en","es"}') returning id`, [orgId, A]);
await q(`insert into approved_claims (organization_id, workspace_id, claim_text, evidence_url, status, approved_by) values
  ($1,$2,'7-day free trial on both plans','https://ayurvedanest.org/pricing','active',$3),
  ($1,$2,'Price locked for the life of the subscription','https://ayurvedanest.org/pricing','active',$3)`,
  [orgId, A, aditya.id]);
const senderLara = await one(`insert into sender_identities (organization_id, workspace_id, display_name, address, verification_status, daily_cap, verified_at)
  values ($1,$2,'Lara from Ayurveda Nest','lara@ayurvedanest.org','verified',25, now()) returning id`, [orgId, A]);
const senderAdi = await one(`insert into sender_identities (organization_id, workspace_id, display_name, address, verification_status, daily_cap, verified_at)
  values ($1,$2,'Aditya Bandi','aditya@ayurvedanest.org','verified',10, now()) returning id`, [orgId, A]);
await q(`insert into sender_identities (organization_id, workspace_id, display_name, address, verification_status, daily_cap)
  values ($1,$2,'Ayurveda Nest Growth','growth@ayurvedanest.org','unverified',25)`, [orgId, A]);
await q(`insert into integrations (organization_id, workspace_id, provider, external_account_id, status, last_health_check_at)
  values ($1,$2,'mock-mailbox','dev-outbox','healthy', now())`, [orgId, A]);
await q(`insert into integrations (organization_id, workspace_id, provider, external_account_id, encrypted_secret_ref, status)
  values ($1,$2,'gmail','lara@ayurvedanest.org','GMAIL_REFRESH_TOKEN_LARA','pending')`, [orgId, A]);
await q(`insert into success_events (organization_id, workspace_id, name, event_type) values
  ($1,$2,'Trial started','signup'), ($1,$2,'Paid subscription','revenue')`, [orgId, A]);

const creators = [
  ["Maya Chen","maya@wildrootwellness.com","Creator, 84k IG","Wild Root Wellness","wildrootwellness.com","US"],
  ["Elena Ruiz","elena@pranaflow.co","Yoga teacher, 41k YT","Prana Flow","pranaflow.co","ES"],
  ["James Okafor","james@groundedbody.com","Creator, 120k TikTok","Grounded Body","groundedbody.com","UK"],
  ["Sofia Marino","sofia@herbaldaily.io","Writer, Herbal Daily","Herbal Daily","herbaldaily.io","US"],
  ["Arjun Mehta","arjun@vedicliving.in","Creator, 210k IG","Vedic Living","vedicliving.in","IN"],
  ["Claire Dubois","claire@maisonherbes.fr","Creator, 36k IG","Maison des Herbes","maisonherbes.fr","FR"],
  ["Tom Alvarez","tom@ritualmorning.com","Creator, 58k YT","Ritual Morning","ritualmorning.com","US"],
  ["Nina Petrova","nina@slowapothecary.com","Founder","Slow Apothecary","slowapothecary.com","UK"],
  ["Ravi Shankar","ravi@prakritipath.in","Creator, 95k IG","Prakriti Path","prakritipath.in","IN"],
  ["Hannah Lee","hannah@leewellness.com","Creator, 12k IG","Lee Wellness","leewellness.com","US"],
];
const peopleIds: Record<string, { personId: string; contactId: string }> = {};
for (const [name, email, title, company, domain, country] of creators) {
  const c = await one(`insert into companies (organization_id, workspace_id, name, normalized_domain, country, industry, size_band)
    values ($1,$2,$3,$4,$5,'wellness','creator') returning id`, [orgId, A, company, domain, country]);
  const p = await one(`insert into people (organization_id, workspace_id, company_id, full_name, title, normalized_email)
    values ($1,$2,$3,$4,$5,$6) returning id`, [orgId, A, c.id, name, title, email]);
  const ev = await one(`insert into evidence_items (organization_id, workspace_id, subject_type, subject_id, source_type, source_url, excerpt, content_hash)
    values ($1,$2,'person',$3,'csv','https://instagram.com/' || lower(split_part($4,' ',1)),
    $5, md5($4)) returning id`,
    [orgId, A, p.id, name, `${name} (${title}) posts weekly about Ayurveda and holistic routines; recent series on morning rituals aligns with Ayurveda Nest programs.`]);
  const cp = await one(`insert into contact_points (organization_id, workspace_id, person_id, type, normalized_value, verification_status, verification_provider, verified_at, evidence_id)
    values ($1,$2,$3,'email',$4,'verified','manual',now(),$5) returning id`, [orgId, A, p.id, email, ev.id]);
  peopleIds[email] = { personId: p.id, contactId: cp.id };
  const score = 0.62 + (name.length % 30) / 100;
  await q(`insert into qualification_runs (organization_id, workspace_id, person_id, icp_id, score, confidence, disposition, reasons_json, evidence_ids)
    values ($1,$2,$3,$4,$5,$6,'qualified',$7,$8::uuid[])`,
    [orgId, A, p.id, icp.id, score.toFixed(3), (0.7 + (name.length % 20) / 100).toFixed(3),
     JSON.stringify([{ reason: "Audience size in target band", evidence: ev.id }, { reason: "Ayurveda/holistic content focus", evidence: ev.id }]),
     [ev.id]]);
}
// one unverified + one risky to show states
await q(`update contact_points set verification_status = 'unverified', verified_at = null where normalized_value = 'hannah@leewellness.com'`);
await q(`update contact_points set verification_status = 'risky' where normalized_value = 'claire@maisonherbes.fr'`);
await q(`update qualification_runs set disposition = 'research_queue', confidence = 0.42 where person_id = $1`,
  [peopleIds["hannah@leewellness.com"].personId]);
await q(`insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source)
  values ($1,$2,'workspace','nina@slowapothecary.com','Asked not to be contacted in June','inbound')`, [orgId, A]);

const tpl = await one(`insert into sequence_templates (organization_id, workspace_id, name, channel)
  values ($1,$2,'Creator outreach - 2 steps','email') returning id`, [orgId, A]);
const step1 = await one(`insert into sequence_steps (template_id, step_number, delay_minutes, subject_template, body_template) values
  ($1,1,0,'{{first_name}}, your Ayurveda series + a partnership idea',
   'Hi {{first_name}},\n\nI have been following {{company}} - your recent morning-ritual series is exactly the kind of grounded Ayurveda content we love.\n\nI run Ayurveda Nest: guided Ayurvedic programs on a simple subscription ($19/month or $120/year, 7-day free trial). We are partnering with a small group of creators this quarter, and I think your audience would genuinely benefit.\n\nOpen to a quick look? I can send over the partner terms - they include a per-subscriber commission and free access for you.\n\n- {{sender_name}}') returning id`, [tpl.id]);
await one(`insert into sequence_steps (template_id, step_number, delay_minutes, subject_template, body_template) values
  ($1,2,4320,'Re: {{first_name}}, your Ayurveda series + a partnership idea',
   'Hi {{first_name}},\n\nQuick nudge in case this got buried. The short version: we pay partners $5 per active monthly subscriber and $30 per annual one, and your audience keeps their trial pricing for life.\n\nHappy to send details or jump on a 15-minute call - whichever is easier.\n\n- {{sender_name}}') returning id`, [tpl.id]);

// Campaign 1: RUNNING (Wave 1)
const camp1 = await one(`insert into campaigns (organization_id, workspace_id, name, offer_id, icp_id, status, created_by)
  values ($1,$2,'Creator Wave 1',$3,$4,'running',$5) returning id`, [orgId, A, offer.id, icp.id, lara.id]);
const recipients1 = ["maya@wildrootwellness.com","elena@pranaflow.co","james@groundedbody.com","sofia@herbaldaily.io","arjun@vedicliving.in","tom@ritualmorning.com","ravi@prakritipath.in"]
  .map((e) => ({ person_id: peopleIds[e].personId, contact_point_id: peopleIds[e].contactId }));
const payload1: CampaignPayload = {
  schema_version: 1, workspace_id: A, campaign_id: camp1.id,
  sender_identity_id: senderLara.id, channel: "email", offer_id: offer.id, icp_id: icp.id,
  claim_ids: [],
  recipients: recipients1,
  sequence: [
    { step_number: 1, delay_minutes: 0, subject_template: "{{first_name}}, your Ayurveda series + a partnership idea", body_template: "Hi {{first_name}},\n\nI have been following {{company}} - your recent morning-ritual series is exactly the kind of grounded Ayurveda content we love.\n\nI run Ayurveda Nest: guided Ayurvedic programs on a simple subscription ($19/month or $120/year, 7-day free trial). We are partnering with a small group of creators this quarter, and I think your audience would genuinely benefit.\n\nOpen to a quick look? I can send over the partner terms - they include a per-subscriber commission and free access for you.\n\n- {{sender_name}}", stop_conditions: ["reply","bounce","unsubscribe","conversion"] },
    { step_number: 2, delay_minutes: 4320, subject_template: "Re: {{first_name}}, your Ayurveda series + a partnership idea", body_template: "Hi {{first_name}},\n\nQuick nudge in case this got buried. The short version: we pay partners $5 per active monthly subscriber and $30 per annual one, and your audience keeps their trial pricing for life.\n\nHappy to send details or jump on a 15-minute call - whichever is easier.\n\n- {{sender_name}}", stop_conditions: ["reply","bounce","unsubscribe","conversion"] },
  ],
  personalization_rules: { allowed_variables: ["first_name","full_name","company","title","sender_name"] },
  delivery: { timezone: "Europe/Madrid", send_window: { start_hour: 8, end_hour: 20 }, daily_workspace_cap: 50, sender_daily_cap: 25, per_domain_cap: 5 },
  follow_up: { enabled: true },
  reply_policy: { auto_send: false },
  suppression_policy: { check_before_send: true },
};
const hash1 = payloadHash(payload1);
const ver1 = await one(`insert into campaign_versions (campaign_id, version_number, payload_json, payload_hash, status, created_by)
  values ($1,1,$2,$3,'running',$4) returning id`, [camp1.id, JSON.stringify(payload1), hash1, lara.id]);
for (const r of recipients1) {
  await q(`insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id) values ($1,$2,$3)`,
    [ver1.id, r.person_id, r.contact_point_id]);
}
const ar1 = await one(`insert into approval_requests (organization_id, workspace_id, resource_type, resource_id, payload_hash, status, requested_by, decided_by, decided_at, decision_note)
  values ($1,$2,'campaign_version',$3,$4,'approved',$5,$6, now() - interval '2 days','Wave 1 looks good - send it.') returning id`,
  [orgId, A, ver1.id, hash1, lara.id, aditya.id]);
const run1 = await one(`insert into campaign_runs (campaign_version_id, status, launched_by, launched_at)
  values ($1,'running',$2, now() - interval '6 days') returning id`, [ver1.id, lara.id]);

// deliveries: 5 sent step1, maya+elena got step2 sent, arjun step2 scheduled
const sentEmails = ["maya@wildrootwellness.com","elena@pranaflow.co","james@groundedbody.com","sofia@herbaldaily.io","arjun@vedicliving.in"];
const sentDaysAgo: Record<string, number> = { maya: 6, elena: 5, james: 4, sofia: 2, arjun: 1 };
for (const e of sentEmails) {
  const { personId, contactId } = peopleIds[e];
  const pmid = `mock_wave1_${e.split("@")[0]}`;
  const sentAt = new Date(Date.now() - sentDaysAgo[e.split("@")[0]] * 86400_000);
  const d = await one(`insert into message_deliveries
    (organization_id, workspace_id, campaign_run_id, campaign_version_id, person_id, contact_point_id, sequence_step_id,
     step_number, sender_identity_id, provider_message_id, idempotency_key, scheduled_at, sent_at, status, thread_ref,
     subject_rendered, body_rendered)
    values ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10, $14, $14, 'sent', $11,
            $12, $13) returning id`,
    [orgId, A, run1.id, ver1.id, personId, contactId, step1.id, senderLara.id, pmid, `${ver1.id}:${personId}:1`,
     `thr_${pmid}`, `${e.split("@")[0]}, your Ayurveda series + a partnership idea`,
     `Hi ${e.split("@")[0]},\n\nI have been following your work - your recent morning-ritual series is exactly the kind of grounded Ayurveda content we love...`, sentAt]);
  await q(`insert into delivery_events (organization_id, workspace_id, message_delivery_id, provider_event_id, type, occurred_at)
    values ($1,$2,$3,$4,'sent', $5)`, [orgId, A, d.id, `evt_${pmid}`, sentAt]);
  await q(`insert into outbox_messages (workspace_id, message_delivery_id, from_address, to_address, subject, body, provider_message_id, thread_ref)
    values ($1,$2,'lara@ayurvedanest.org',$3,$4,$5,$6,$7)`,
    [A, d.id, e, `${e.split("@")[0]}, your Ayurveda series + a partnership idea`, "Hi ...", pmid, `thr_${pmid}`]);
}
// tom + ravi still scheduled for step 1
for (const e of ["tom@ritualmorning.com","ravi@prakritipath.in"]) {
  const { personId, contactId } = peopleIds[e];
  await q(`insert into message_deliveries
    (organization_id, workspace_id, campaign_run_id, campaign_version_id, person_id, contact_point_id, sequence_step_id,
     step_number, sender_identity_id, idempotency_key, scheduled_at, status)
    values ($1,$2,$3,$4,$5,$6,$7,1,$8,$9, now(), 'scheduled') on conflict (idempotency_key) do nothing`,
    [orgId, A, run1.id, ver1.id, personId, contactId, step1.id, senderLara.id, `${ver1.id}:${personId}:1`]);
}
// replies: maya interested, elena question, james unsubscribe (suppressed)
const replies: [string, string, string, number][] = [
  ["maya@wildrootwellness.com","Re: your Ayurveda series + a partnership idea","Hi Lara, this sounds interesting - tell me more about the commission terms. Would love to talk.", 4],
  ["elena@pranaflow.co","Re: your Ayurveda series + a partnership idea","Thanks for reaching out! How does the partner dashboard work and what does my audience pay after the trial?", 2],
  ["james@groundedbody.com","Re: your Ayurveda series + a partnership idea","Please remove me from your list. Unsubscribe.", 1],
];
for (const [from, subject, body, replyDaysAgo] of replies) {
  const { personId } = peopleIds[from];
  const im = await one(`insert into inbound_messages (organization_id, workspace_id, provider_message_id, thread_ref, sender_contact, person_id, subject, body, received_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8, $9) returning id`,
    [orgId, A, `in_${from.split("@")[0]}`, `thr_mock_wave1_${from.split("@")[0]}`, from, personId, subject, body,
     new Date(Date.now() - replyDaysAgo * 86400_000)]);
  const cat = from.startsWith("maya") ? "interested" : from.startsWith("elena") ? "question" : "unsubscribe";
  const conf = cat === "unsubscribe" ? 0.98 : 0.86;
  await q(`insert into reply_classifications (inbound_message_id, category, confidence, extracted_json) values ($1,$2,$3,$4)`,
    [im.id, cat, conf, JSON.stringify({ rationale: `matched rule for ${cat}` })]);
  await q(`insert into reply_drafts (organization_id, workspace_id, inbound_message_id, body, policy_class)
    values ($1,$2,$3,$4,$5)`,
    [orgId, A, im.id,
     cat === "interested" ? "Hi Maya, great to hear! Here are the terms: $5 per active monthly subscriber, $30 per annual. Want me to send the partner link?" : cat === "question" ? "Hi Elena, happy to clarify - the dashboard shows pending, approved and paid earnings live. After the trial your audience pays $19/month or $120/year, locked." : "",
     cat === "unsubscribe" ? "routine" : "sensitive"]);
}
await q(`insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source)
  values ($1,$2,'workspace','james@groundedbody.com','unsubscribe reply','inbound') on conflict do nothing`, [orgId, A]);
await q(`insert into conversions (organization_id, workspace_id, person_id, campaign_id, event_type, value_amount, currency, attribution_json, occurred_at)
  values ($1,$2,$3,$4,'meeting',null,null,'{"rule":"direct_thread"}', now() - interval '2 days'),
         ($1,$2,$5,$4,'signup',19,'USD','{"rule":"direct_thread"}', now() - interval '12 hours')`,
  [orgId, A, peopleIds["maya@wildrootwellness.com"].personId, camp1.id, peopleIds["elena@pranaflow.co"].personId]);

// Campaign 2: APPROVAL PENDING (for the review screen). v1 was rejected; v2 shows the diff view.
const camp2 = await one(`insert into campaigns (organization_id, workspace_id, name, offer_id, icp_id, status, created_by)
  values ($1,$2,'Creator Wave 2 - Europe',$3,$4,'approval_pending',$5) returning id`, [orgId, A, offer.id, icp.id, lara.id]);
const recipients2v1 = ["elena@pranaflow.co","tom@ritualmorning.com"]
  .map((e) => ({ person_id: peopleIds[e].personId, contact_point_id: peopleIds[e].contactId }));
const payload2v1: CampaignPayload = {
  ...payload1, campaign_id: camp2.id, recipients: recipients2v1, sender_identity_id: senderLara.id,
  sequence: [{ ...payload1.sequence[0],
    subject_template: "Quick question, {{first_name}}",
    body_template: "Hi {{first_name}},\n\nLove what you are building with {{company}}. I run Ayurveda Nest and we are looking for a few creator partners this quarter.\n\nWorth a short chat?\n\n- {{sender_name}}" }],
  delivery: { ...payload1.delivery, daily_workspace_cap: 30, send_window: { start_hour: 9, end_hour: 17 } },
};
const hash2v1 = payloadHash(payload2v1);
const ver2v1 = await one(`insert into campaign_versions (campaign_id, version_number, payload_json, payload_hash, status, created_by)
  values ($1,1,$2,$3,'rejected',$4) returning id`, [camp2.id, JSON.stringify(payload2v1), hash2v1, lara.id]);
for (const r of recipients2v1) {
  await q(`insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id) values ($1,$2,$3)`,
    [ver2v1.id, r.person_id, r.contact_point_id]);
}
await q(`insert into approval_requests (organization_id, workspace_id, resource_type, resource_id, payload_hash, status, requested_by, decided_by, decided_at, decision_note)
  values ($1,$2,'campaign_version',$3,$4,'rejected',$5,$6, now() - interval '3 days','Too thin - add Claire, send from my address, and sharpen the ask.')`,
  [orgId, A, ver2v1.id, hash2v1, lara.id, aditya.id]);
const recipients2 = ["elena@pranaflow.co","claire@maisonherbes.fr","tom@ritualmorning.com"]
  .map((e) => ({ person_id: peopleIds[e].personId, contact_point_id: peopleIds[e].contactId }));
const payload2: CampaignPayload = { ...payload1, campaign_id: camp2.id, recipients: recipients2, sender_identity_id: senderAdi.id };
const hash2 = payloadHash(payload2);
const ver2 = await one(`insert into campaign_versions (campaign_id, version_number, payload_json, payload_hash, status, created_by)
  values ($1,2,$2,$3,'approval_pending',$4) returning id`, [camp2.id, JSON.stringify(payload2), hash2, lara.id]);
for (const r of recipients2) {
  await q(`insert into campaign_version_recipients (campaign_version_id, person_id, contact_point_id) values ($1,$2,$3)`,
    [ver2.id, r.person_id, r.contact_point_id]);
}
await q(`insert into approval_requests (organization_id, workspace_id, resource_type, resource_id, payload_hash, status, requested_by)
  values ($1,$2,'campaign_version',$3,$4,'pending',$5)`, [orgId, A, ver2.id, hash2, lara.id]);

// Campaign 3: draft
const camp3 = await one(`insert into campaigns (organization_id, workspace_id, name, offer_id, icp_id, status, created_by)
  values ($1,$2,'Retail buyers - test',$3,$4,'draft',$5) returning id`, [orgId, A, offer.id, icp.id, lara.id]);
await one(`insert into campaign_versions (campaign_id, version_number, payload_json, status, created_by)
  values ($1,1,'{}','draft',$2) returning id`, [camp3.id, lara.id]);

// ---------- workspace B: isolation proof ----------
const wsB = await one(`insert into workspaces (organization_id, name, slug, domain, default_timezone)
  values ($1,'Northwind Demo','northwind-demo','northwind.example','UTC') returning id`, [orgId]);
const B = wsB.id;
await q(`insert into workspace_memberships (workspace_id, user_id, role) values ($1,$2,'workspace_admin'), ($1,$2,'approver')`, [B, aditya.id]);
await q(`insert into workspace_policies (organization_id, workspace_id, created_by) values ($1,$2,$3)`, [orgId, B, aditya.id]);
await q(`insert into companies (organization_id, workspace_id, name, normalized_domain) values ($1,$2,'Northwind Traders','northwind.example')`, [orgId, B]);
await q(`insert into people (organization_id, workspace_id, full_name, normalized_email)
  values ($1,$2,'Demo Person','demo@northwind.example')`, [orgId, B]);
await q(`insert into sender_identities (organization_id, workspace_id, display_name, address, verification_status)
  values ($1,$2,'Demo Sender','hello@northwind.example','verified')`, [orgId, B]);

await q(`insert into audit_events (organization_id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json) values
  ($1,$2,'user',$3,'campaign.create','campaign',$4,'{"name":"Creator Wave 1"}'),
  ($1,$2,'user',$5,'approval.request','campaign_version',$6,'{}'),
  ($1,$2,'user',$3,'approval.approved','campaign_version',$6,'{"note":"Wave 1 looks good - send it."}'),
  ($1,$2,'user',$5,'campaign.launch','campaign_version',$6,'{}'),
  ($1,$2,'webhook',null,'reply.ingested','inbound_message',null,'{"category":"interested"}'),
  ($1,$2,'webhook',null,'reply.ingested','inbound_message',null,'{"category":"unsubscribe","suppressed":true}')`,
  [orgId, A, aditya.id, camp1.id, lara.id, ver1.id]);

console.log("seed complete", { orgId, wsA: A, wsB: B, hash1, hash2 });
await client.end();
