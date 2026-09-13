import "server-only";
import { withTenant, withSystem } from "@/db/client";
import { audit } from "@/domain/audit";
import { matchesSuppression, withinSendWindow } from "@/domain/compliance";
import type { CampaignPayload } from "@/domain/payload";
import { MockMailboxAdapter } from "@/domain/adapters/mock-mailbox";
import { MockModelAdapter } from "@/domain/adapters/mock-model";

/**
 * Process due message deliveries for a run. Re-checks run state, kill switches,
 * suppression and caps immediately before each send (spec: pause must stop
 * every not-yet-sent job; suppression is checked at scheduling AND pre-send).
 */
export async function processDueDeliveries(workspaceId: string, limit = 50) {
  return withTenant(workspaceId, async (db) => {
    const due = await db.query(
      `select md.*, cr.status as run_status, cr.campaign_version_id, w.kill_switch as ws_kill, o.kill_switch as org_kill
         from message_deliveries md
         join campaign_runs cr on cr.id = md.campaign_run_id
         join workspaces w on w.id = md.workspace_id
         join organizations o on o.id = md.organization_id
        where md.status = 'scheduled' and md.scheduled_at <= now()
        order by md.scheduled_at limit $1 for update of md skip locked`, [limit]);
    if (due.rowCount === 0) return { sent: 0, skipped: 0 };

    const sup = (await db.query(`select scope, normalized_value, expires_at from suppression_entries`)).rows;
    let sent = 0, skipped = 0;
    for (const d of due.rows) {
      if (d.org_kill || d.ws_kill || d.run_status !== "running") { skipped++; continue; }
      const cp = await db.query(`select normalized_value, do_not_contact from contact_points where id = $1`, [d.contact_point_id]);
      const addr = cp.rows[0]?.normalized_value ?? "";
      if (cp.rows[0]?.do_not_contact || matchesSuppression(sup, addr).suppressed) {
        await db.query(`update message_deliveries set status = 'suppressed' where id = $1`, [d.id]);
        skipped++;
        continue;
      }
      // stop conditions: reply/bounce/unsubscribe/conversion on this thread stops follow-ups
      const stopCheck = await db.query(
        `select 1 from delivery_events de
           join message_deliveries m on m.id = de.message_delivery_id
          where m.person_id = $1 and m.campaign_version_id = $2
            and de.type in ('bounced','unsubscribed') limit 1`, [d.person_id, d.campaign_version_id]);
      const replied = await db.query(
        `select 1 from inbound_messages where person_id = $1 limit 1`, [d.person_id]);
      const converted = await db.query(
        `select 1 from conversions where person_id = $1 and campaign_id =
           (select campaign_id from campaign_versions where id = $2) limit 1`, [d.person_id, d.campaign_version_id]);
      if (stopCheck.rowCount || replied.rowCount || converted.rowCount) {
        await db.query(`update message_deliveries set status = 'skipped', error_code = 'stop_condition' where id = $1`, [d.id]);
        skipped++;
        continue;
      }
      // caps, transactional
      const ver = await db.query(`select payload_json from campaign_versions where id = $1`, [d.campaign_version_id]);
      const payload = ver.rows[0].payload_json as CampaignPayload;
      if (!withinSendWindow(new Date(), payload.delivery.timezone, payload.delivery.send_window)) {
        await db.query(`update message_deliveries set scheduled_at = now() + interval '15 minutes' where id = $1`, [d.id]);
        skipped++;
        continue;
      }
      const usage = await db.query(
        `select
           count(*) filter (where md.workspace_id = $1) as ws,
           count(*) filter (where md.sender_identity_id = $2) as sender,
           count(*) filter (where split_part(cp.normalized_value,'@',2) = split_part($3,'@',2)) as dom
         from message_deliveries md join contact_points cp on cp.id = md.contact_point_id
         where md.sent_at::date = now()::date and md.workspace_id = $1`, [d.workspace_id, d.sender_identity_id, addr]);
      const u = usage.rows[0];
      if (Number(u.ws) >= payload.delivery.daily_workspace_cap ||
          Number(u.sender) >= payload.delivery.sender_daily_cap ||
          Number(u.dom) >= payload.delivery.per_domain_cap) {
        await db.query(`update message_deliveries set scheduled_at = (now()::date + 1)::timestamptz + interval '9 hours' where id = $1`, [d.id]);
        skipped++;
        continue;
      }
      // render + send via adapter
      const person = await db.query(
        `select p.full_name, p.title, co.name as company from people p left join companies co on co.id = p.company_id where p.id = $1`,
        [d.person_id]);
      const senderRow = await db.query(`select * from sender_identities where id = $1`, [d.sender_identity_id]);
      const step = payload.sequence.find((s) => s.step_number === d.step_number);
      if (!step) { skipped++; continue; }
      const vars = {
        first_name: person.rows[0].full_name.split(" ")[0],
        full_name: person.rows[0].full_name,
        company: person.rows[0].company ?? "",
        title: person.rows[0].title ?? "",
        sender_name: senderRow.rows[0].display_name,
      };
      const subject = step.subject_template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k) => (vars as Record<string,string>)[k] ?? "");
      const body = step.body_template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k) => (vars as Record<string,string>)[k] ?? "");
      const adapter = new MockMailboxAdapter(db, workspaceId);
      await db.query(`update message_deliveries set status = 'sending' where id = $1`, [d.id]);
      const result = await adapter.send({
        fromAddress: senderRow.rows[0].address, fromName: senderRow.rows[0].display_name,
        toAddress: addr, subject, body, threadRef: d.thread_ref, idempotencyKey: d.idempotency_key,
      });
      await db.query(
        `update message_deliveries set status = 'sent', sent_at = now(), provider_message_id = $2,
           thread_ref = $3, subject_rendered = $4, body_rendered = $5 where id = $1`,
        [d.id, result.providerMessageId, result.threadRef, subject, body]);
      await db.query(
        `insert into delivery_events (organization_id, workspace_id, message_delivery_id, provider_event_id, type)
         values ($1,$2,$3,$4,'sent') on conflict do nothing`,
        [d.organization_id, d.workspace_id, d.id, `evt_${result.providerMessageId}`]);
      sent++;

      // schedule the next step with stop conditions armed
      const next = payload.sequence.find((s) => s.step_number === d.step_number + 1);
      if (next) {
        await db.query(
          `insert into message_deliveries
             (organization_id, workspace_id, campaign_run_id, campaign_version_id, person_id, contact_point_id,
              sequence_step_id, step_number, sender_identity_id, idempotency_key, scheduled_at, status, thread_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval, 'scheduled', $12)
           on conflict (idempotency_key) do nothing`,
          [d.organization_id, d.workspace_id, d.campaign_run_id, d.campaign_version_id, d.person_id,
           d.contact_point_id, d.sequence_step_id, next.step_number, d.sender_identity_id,
           `${d.campaign_version_id}:${d.person_id}:${next.step_number}`, String(next.delay_minutes), result.threadRef]);
      } else {
        // no next step: if every delivery for this run is terminal, complete it
        const open = await db.query(
          `select 1 from message_deliveries where campaign_run_id = $1 and status in ('scheduled','sending') limit 1`, [d.campaign_run_id]);
        if (!open.rowCount) {
          await db.query(`update campaign_runs set status = 'completed' where id = $1`, [d.campaign_run_id]);
        }
      }
    }
    return { sent, skipped };
  });
}

/** Ingest an inbound reply (from webhook processing or the dev simulator). */
export async function ingestReply(workspaceId: string, input: {
  providerMessageId: string; threadRef?: string; from: string; subject: string; body: string;
}) {
  return withTenant(workspaceId, async (db) => {
    const org = await db.query(`select organization_id from workspaces where id = $1`, [workspaceId]);
    const organizationId = org.rows[0].organization_id as string;
    const person = await db.query(
      `select p.id from people p where p.normalized_email = lower($1) limit 1`, [input.from]);
    const ins = await db.query(
      `insert into inbound_messages (organization_id, workspace_id, provider_message_id, thread_ref, sender_contact, person_id, subject, body)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (workspace_id, provider_message_id) do nothing returning id`,
      [organizationId, workspaceId, input.providerMessageId, input.threadRef ?? null,
       input.from, person.rows[0]?.id ?? null, input.subject, input.body]);
    if (ins.rowCount === 0) return { duplicate: true };
    const inboundId = ins.rows[0].id as string;

    // immediate suppression on unsubscribe language, before any AI work
    if (/unsubscribe|remove me|stop email|opt.?out/i.test(input.body)) {
      await db.query(
        `insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source)
         values ($1,$2,'workspace',lower($3),'unsubscribe reply','inbound') on conflict do nothing`,
        [organizationId, workspaceId, input.from]);
      await db.query(
        `update message_deliveries set status = 'skipped', error_code = 'unsubscribed'
          where workspace_id = $1 and status = 'scheduled'
            and contact_point_id in (select id from contact_points where normalized_value = lower($2))`,
        [workspaceId, input.from]);
    }

    const model = new MockModelAdapter();
    const cls = await model.classifyReply({ subject: input.subject, body: input.body });
    await db.query(
      `insert into reply_classifications (inbound_message_id, category, confidence, extracted_json)
       values ($1,$2,$3,$4)`, [inboundId, cls.category, cls.confidence, JSON.stringify({ rationale: cls.rationale })]);
    const sensitive = ["interested","objection","negotiation","complaint","question"].includes(cls.category) || cls.confidence < 0.7;
    const draft = await model.draftReply({ subject: input.subject, body: input.body, category: cls.category });
    await db.query(
      `insert into reply_drafts (organization_id, workspace_id, inbound_message_id, body, policy_class, status)
       values ($1,$2,$3,$4,$5,'draft')`, [organizationId, workspaceId, inboundId, draft.body, sensitive ? "sensitive" : "routine"]);
    await audit(db, {
      organizationId, workspaceId, actorType: "webhook",
      action: "reply.ingested", targetType: "inbound_message", targetId: inboundId,
      metadata: { category: cls.category, confidence: cls.confidence, suppressed: /unsubscribe/i.test(input.body) },
    });
    return { inboundId, category: cls.category };
  });
}
