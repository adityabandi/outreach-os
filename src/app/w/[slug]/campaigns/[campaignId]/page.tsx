import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill, HashChip, LinkButton, Empty } from "@/ui/primitives";
import { validateReadiness } from "@/server/campaigns";
import { saveDraftAction, requestApprovalAction, launchAction, runControlAction, generateLinesAction } from "@/server/actions";
import type { CampaignPayload } from "@/domain/payload";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CampaignDetail({ params }: { params: Promise<{ slug: string; campaignId: string }> }) {
  const { slug, campaignId } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const c = await db.query(
      `select c.*, u.display_name as creator from campaigns c left join users u on u.id = c.created_by where c.id = $1`, [campaignId]);
    if (c.rowCount === 0) return null;
    const versions = await db.query(`select * from campaign_versions where campaign_id = $1 order by version_number desc`, [campaignId]);
    const latest = versions.rows[0];
    const senders = await db.query(`select * from sender_identities order by address`);
    const offers = await db.query(`select id, name from offers where status = 'active'`);
    const icps = await db.query(`select id, name from ideal_customer_profiles where status = 'active'`);
    const prospects = await db.query(
      `select p.id as person_id, p.full_name, p.title, cp.id as contact_point_id, cp.normalized_value, cp.verification_status,
              co.name as company, q.disposition, q.score
         from people p
         join contact_points cp on cp.person_id = p.id and cp.type = 'email'
         left join companies co on co.id = p.company_id
         left join lateral (select disposition, score from qualification_runs qr where qr.person_id = p.id order by created_at desc limit 1) q on true
        order by p.full_name`);
    const runs = await db.query(
      `select cr.*, cv.version_number,
         (select count(*)::int from message_deliveries md where md.campaign_run_id = cr.id) as total,
         (select count(*)::int from message_deliveries md where md.campaign_run_id = cr.id and md.status = 'sent') as sent,
         (select count(*)::int from message_deliveries md where md.campaign_run_id = cr.id and md.status = 'scheduled') as scheduled,
         (select count(*)::int from message_deliveries md where md.campaign_run_id = cr.id and md.status in ('suppressed','skipped')) as stopped,
         (select count(*)::int from message_deliveries md where md.campaign_run_id = cr.id and md.status = 'failed') as failed,
         (select min(md.scheduled_at) from message_deliveries md where md.campaign_run_id = cr.id and md.status = 'scheduled') as next_send
        from campaign_runs cr join campaign_versions cv on cv.id = cr.campaign_version_id
        where cv.campaign_id = $1 order by cr.launched_at desc nulls last`, [campaignId]);
    const deliveries = await db.query(
      `select md.status, count(*)::int as n from message_deliveries md
         join campaign_versions cv on cv.id = md.campaign_version_id
        where cv.campaign_id = $1 group by md.status`, [campaignId]);
    const approvals = await db.query(
      `select ar.*, u.display_name as requester from approval_requests ar left join users u on u.id = ar.requested_by
        where ar.resource_type = 'campaign_version' and ar.resource_id = any(
          select id from campaign_versions where campaign_id = $1) order by ar.requested_at desc`, [campaignId]);
    let readiness = null;
    if (latest && (latest.status === "draft" || latest.status === "rejected")) {
      readiness = await validateReadiness(db, ctx, latest.id);
    }
    return { campaign: c.rows[0], versions: versions.rows, latest, senders: senders.rows, offers: offers.rows, icps: icps.rows, prospects: prospects.rows, runs: runs.rows, deliveries: deliveries.rows, approvals: approvals.rows, readiness };
  });
  if (!data) notFound();
  const { campaign, latest, versions } = data;
  const payload = (latest?.payload_json ?? {}) as Partial<CampaignPayload>;
  const editable = latest && (latest.status === "draft" || latest.status === "rejected");
  const canApprove = ctx.isOrgOwner || ctx.roles.includes("approver");
  const pendingApproval = data.approvals.find((a: any) => a.status === "pending" && a.resource_id === latest?.id);
  const approved = data.approvals.find((a: any) => a.status === "approved" && a.resource_id === latest?.id);
  const deliv = Object.fromEntries(data.deliveries.map((d: any) => [d.status, d.n]));
  const selectedRecipients = new Set((payload.recipients ?? []).map((r) => `${r.person_id}:${r.contact_point_id}`));
  const lineByPair = new Map((payload.recipients ?? []).map((r) => [`${r.person_id}:${r.contact_point_id}`, (r as { line?: string }).line ?? ""]));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{campaign.name}</h1>
            <StatePill state={campaign.status} />
          </div>
          <p className="mt-1 text-sm text-fg-mute">
            Created by {campaign.creator} · {versions.length} version{versions.length > 1 ? "s" : ""} · latest v{latest?.version_number}
            {latest?.payload_hash && <span className="ml-2"><HashChip hash={latest.payload_hash} /></span>}
          </p>
        </div>
        {latest && latest.status === "approved" && (
          <form action={launchAction.bind(null, slug, latest.id)}>
            <button className="btn-primary">Launch campaign</button>
          </form>
        )}
        {pendingApproval && canApprove && (
          <LinkButton href={`/w/${slug}/approvals/${pendingApproval.id}`} kind="primary">Review approval →</LinkButton>
        )}
      </div>

      {data.runs.length > 0 && (
        <Panel>
          <PanelHeader title="Runs" sub="Launch, pause, resume and stop. Pause blocks every not-yet-sent message." />
          <table className="w-full">
            <thead><tr><th className="th">Run</th><th className="th">Version</th><th className="th">Status</th><th className="th">Progress</th><th className="th">Next send</th><th className="th">Launched</th><th className="th text-right">Actions</th></tr></thead>
            <tbody>
              {data.runs.map((r: any) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs text-fg-mute">{r.id.slice(0, 8)}</td>
                  <td className="td">v{r.version_number}</td>
                  <td className="td"><StatePill state={r.status} /></td>
                  <td className="td min-w-[140px]">
                    {r.total > 0 ? (
                      <div>
                        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-ink-750">
                          <div className="flex h-full">
                            <span className="bg-mint" style={{ width: `${(r.sent / r.total) * 100}%` }} />
                            <span className="bg-sky/60" style={{ width: `${(r.scheduled / r.total) * 100}%` }} />
                            <span className="bg-flare/70" style={{ width: `${(r.stopped / r.total) * 100}%` }} />
                            <span className="bg-rose" style={{ width: `${(r.failed / r.total) * 100}%` }} />
                          </div>
                        </div>
                        <div className="mt-1 text-[10px] text-fg-faint">{r.sent}/{r.total} sent{r.stopped > 0 ? ` · ${r.stopped} stopped` : ""}{r.failed > 0 ? ` · ${r.failed} failed` : ""}</div>
                      </div>
                    ) : <span className="text-xs text-fg-faint">-</span>}
                  </td>
                  <td className="td text-fg-mute text-xs">{r.next_send ? new Date(r.next_send).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                  <td className="td text-fg-mute text-xs">{r.launched_at ? new Date(r.launched_at).toLocaleString("en-GB") : "-"}</td>
                  <td className="td text-right">
                    <span className="inline-flex gap-2">
                      {r.status === "running" && (<>
                        <form action={runControlAction.bind(null, slug, r.id, "pause")}><button className="btn-ghost !px-2.5 !py-1 text-xs">Pause</button></form>
                        <form action={runControlAction.bind(null, slug, r.id, "stop")}><button className="btn-danger !px-2.5 !py-1 text-xs">Stop</button></form>
                      </>)}
                      {r.status === "paused" && (<>
                        <form action={runControlAction.bind(null, slug, r.id, "resume")}><button className="btn-primary !px-2.5 !py-1 text-xs">Resume</button></form>
                        <form action={runControlAction.bind(null, slug, r.id, "stop")}><button className="btn-danger !px-2.5 !py-1 text-xs">Stop</button></form>
                      </>)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.keys(deliv).length > 0 && (
            <div className="flex gap-2 border-t border-line px-5 py-3">
              {["sent","scheduled","suppressed","skipped","failed"].filter((s) => deliv[s]).map((s) => (
                <Pill key={s} tone={s === "sent" ? "green" : s === "scheduled" ? "blue" : s === "failed" || s === "suppressed" ? "red" : "gray"}>{deliv[s]} {s}</Pill>
              ))}
            </div>
          )}
        </Panel>
      )}

      {editable && (
        <form action={saveDraftAction.bind(null, slug, latest.id)} className="space-y-4">
          <Panel>
            <PanelHeader title={`Draft v${latest.version_number}`} sub="Edits are free here. Submitting for approval freezes everything on this page." />
            <div className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-3">
              <div>
                <label className="label">Sender identity</label>
                <select name="sender_identity_id" className="input" defaultValue={payload.sender_identity_id ?? ""}>
                  <option value="">Choose sender…</option>
                  {data.senders.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.display_name} &lt;{s.address}&gt; · cap {s.daily_cap}/day{s.verification_status !== "verified" ? " (unverified)" : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Offer</label>
                <select name="offer_id" className="input" defaultValue={payload.offer_id ?? ""}>
                  <option value="">None</option>
                  {data.offers.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">ICP</label>
                <select name="icp_id" className="input" defaultValue={payload.icp_id ?? ""}>
                  <option value="">None</option>
                  {data.icps.map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Timezone</label>
                <input name="timezone" className="input" defaultValue={payload.delivery?.timezone ?? "Europe/Madrid"} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="label">Window start</label><input name="start_hour" type="number" min="0" max="23" className="input" defaultValue={payload.delivery?.send_window?.start_hour ?? 8} /></div>
                <div><label className="label">Window end</label><input name="end_hour" type="number" min="0" max="23" className="input" defaultValue={payload.delivery?.send_window?.end_hour ?? 20} /></div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div><label className="label">Workspace cap</label><input name="daily_workspace_cap" type="number" className="input" defaultValue={payload.delivery?.daily_workspace_cap ?? 50} /></div>
                <div><label className="label">Sender cap</label><input name="sender_daily_cap" type="number" className="input" defaultValue={payload.delivery?.sender_daily_cap ?? 25} /></div>
                <div><label className="label">Per-domain</label><input name="per_domain_cap" type="number" className="input" defaultValue={payload.delivery?.per_domain_cap ?? 5} /></div>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Sequence" sub="Variables: {{first_name}}, {{full_name}}, {{company}}, {{title}}, {{sender_name}}, {{personalization_line}}" />
            <div className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-2">
              {[1, 2].map((n) => {
                const step = payload.sequence?.find((s) => s.step_number === n);
                return (
                  <div key={n} className="panel-inset p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-fg-soft">Step {n}{n > 1 ? " (follow-up)" : ""}</span>
                      <span className="flex items-center gap-2 text-[11px] text-fg-faint">
                        delay (min) <input name={`step${n}_delay`} type="number" className="input !w-20 !py-1 !text-xs" defaultValue={step?.delay_minutes ?? (n === 1 ? 0 : 4320)} />
                      </span>
                    </div>
                    <input name={`step${n}_subject`} className="input" placeholder="Subject" defaultValue={step?.subject_template ?? ""} />
                    <textarea name={`step${n}_body`} rows={9} className="input font-mono !text-[12px] leading-relaxed" placeholder="Body…" defaultValue={step?.body_template ?? ""} />
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Audience" sub="Only qualified prospects with verified contact routes pass readiness. Personalization lines are hash-locked with the version - approvers see the exact text." />
            <table className="w-full">
              <thead><tr><th className="th w-10"></th><th className="th">Name</th><th className="th">Company</th><th className="th">Email</th><th className="th">Contact</th><th className="th">Fit</th><th className="th w-[32%]">Personalization line</th></tr></thead>
              <tbody>
                {data.prospects.map((p: any) => {
                  const pair = `${p.person_id}:${p.contact_point_id}`;
                  const selected = selectedRecipients.has(pair);
                  return (
                    <tr key={p.contact_point_id} className="hover:bg-ink-850/60">
                      <td className="td"><input type="checkbox" name="recipient" value={pair} defaultChecked={selected} className="accent-flare" /></td>
                      <td className="td font-medium">{p.full_name}<span className="ml-2 text-xs text-fg-faint">{p.title}</span></td>
                      <td className="td text-fg-mute">{p.company}</td>
                      <td className="td font-mono text-xs text-fg-mute">{p.normalized_value}</td>
                      <td className="td"><StatePill state={p.verification_status} /></td>
                      <td className="td">{p.disposition ? <StatePill state={p.disposition} /> : <span className="text-fg-faint text-xs">-</span>}{p.score != null && <span className="ml-2 text-xs text-fg-faint">{Number(p.score).toFixed(2)}</span>}</td>
                      <td className="td">
                        {selected ? (
                          <input name={`line:${pair}`} className="input !py-1 !text-xs" placeholder="Generate below or write one"
                            defaultValue={lineByPair.get(pair) ?? ""} />
                        ) : (
                          <span className="text-[11px] text-fg-faint">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(payload.recipients?.length ?? 0) > 0 && (
              <div className="border-t border-line-soft px-5 py-3 text-[11px] text-fg-faint">
                {(payload.recipients ?? []).filter((r) => (r as { line?: string }).line?.trim()).length} of {payload.recipients?.length} selected recipients have a line. Reference it as {"{{personalization_line}}"} in the copy.
              </div>
            )}
          </Panel>

          {data.readiness && (
            <Panel>
              <PanelHeader title="Readiness" />
              <ul className="space-y-2 px-5 py-4">
                {data.readiness.issues.length === 0 && <li className="text-sm text-mint">All checks pass. This version can be submitted for approval.</li>}
                {data.readiness.issues.map((i, k) => (
                  <li key={k} className={`flex gap-2 text-sm ${i.level === "error" ? "text-rose" : "text-flare"}`}>
                    <span>{i.level === "error" ? "✕" : "⚠"}</span><span>{i.message}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" className="btn-ghost">Save draft</button>
          </div>
        </form>
      )}
      {editable && (payload.recipients?.length ?? 0) > 0 && (
        <form action={generateLinesAction.bind(null, slug, latest.id)} className="-mt-2">
          <button className="btn-ghost text-xs">Generate personalization lines from saved recipients</button>
          <span className="ml-2 text-[11px] text-fg-faint">Uses stored evidence only - never invents facts. Review and edit the lines, then save again.</span>
        </form>
      )}
      {editable && (
        <form action={requestApprovalAction.bind(null, slug, latest.id)}>
          <button className="btn-primary" disabled={!data.readiness?.ok}>Submit v{latest.version_number} for approval</button>
        </form>
      )}

      {!editable && (
        <Panel>
          <PanelHeader title={`Version v${latest?.version_number} payload`} sub="Frozen at submission. Any edit requires a new version and a new approval." />
          <div className="grid grid-cols-2 gap-4 px-5 py-4 text-sm lg:grid-cols-4">
            <div><div className="label">Sender</div><div className="font-mono text-xs">{data.senders.find((s: any) => s.id === payload.sender_identity_id)?.address ?? "-"}</div></div>
            <div><div className="label">Recipients</div><div>{payload.recipients?.length ?? 0}</div></div>
            <div><div className="label">Steps</div><div>{payload.sequence?.length ?? 0}</div></div>
            <div><div className="label">Caps</div><div className="text-xs text-fg-mute">{payload.delivery ? `${payload.delivery.daily_workspace_cap}/ws · ${payload.delivery.sender_daily_cap}/sender · ${payload.delivery.per_domain_cap}/domain` : "-"}</div></div>
          </div>
          {approved && (
            <div className="border-t border-line px-5 py-3 text-xs text-fg-mute">
              Approved hash <HashChip hash={approved.payload_hash} /> · decision recorded with approver + timestamp in the audit log.
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
