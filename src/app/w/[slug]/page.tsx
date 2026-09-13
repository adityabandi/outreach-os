import Link from "next/link";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Stat, Pill, Empty, LinkButton } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function Dashboard({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const [prospects, qualified, sent, replies, meetings, pending, campaigns, activity, health] = await Promise.all([
      db.query(`select count(*)::int n from people`),
      db.query(`select count(*)::int n from qualification_runs where disposition = 'qualified'`),
      db.query(`select count(*)::int n from message_deliveries where status = 'sent' and sent_at > now() - interval '7 days'`),
      db.query(`select count(*)::int n from inbound_messages where received_at > now() - interval '7 days'`),
      db.query(`select count(*)::int n from conversions where event_type = 'meeting'`),
      db.query(`select count(*)::int n from approval_requests where status = 'pending'`),
      db.query(`select c.id, c.name, c.status,
                  (select count(*) from campaign_versions cv where cv.campaign_id = c.id) as versions
                 from campaigns c order by c.created_at desc limit 6`),
      db.query(`select action, actor_type, occurred_at, metadata_json from audit_events
                 where workspace_id = $1 order by occurred_at desc limit 8`, [ctx.workspaceId]),
      (async () => {
        const [kill, failed, senders, suppr, sentToday, cap] = await Promise.all([
          db.query(`select kill_switch from workspaces where id = $1`, [ctx.workspaceId]),
          db.query(`select count(*)::int n from job_runs where status = 'failed' and scheduled_at > now() - interval '24 hours'`),
          db.query(`select verification_status, count(*)::int n from sender_identities group by verification_status`),
          db.query(`select count(*)::int n from suppression_entries where expires_at is null or expires_at > now()`),
          db.query(`select count(*)::int n from message_deliveries where status = 'sent' and sent_at > now() - interval '24 hours'`),
          db.query(`select coalesce(min((payload_json->'delivery'->>'daily_workspace_cap')::int), 0) cap from campaign_versions where status = 'running'`),
        ]);
        const senderMap = Object.fromEntries(senders.rows.map((r: any) => [r.verification_status, r.n]));
        return {
          killSwitch: kill.rows[0]?.kill_switch ?? false,
          failedJobs: failed.rows[0].n,
          sendersVerified: senderMap["verified"] ?? 0,
          sendersTotal: senders.rows.reduce((a: number, r: any) => a + r.n, 0),
          suppressions: suppr.rows[0].n,
          sentToday: sentToday.rows[0].n,
          dailyCap: cap.rows[0].cap,
        };
      })(),
    ]);
    return {
      prospects: prospects.rows[0].n, qualified: qualified.rows[0].n, sent: sent.rows[0].n,
      replies: replies.rows[0].n, meetings: meetings.rows[0].n, pending: pending.rows[0].n,
      campaigns: campaigns.rows, activity: activity.rows, health,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-fg-mute">Everything across this workspace at a glance.</p>
        </div>
        <div className="flex gap-2">
          <LinkButton href={`/w/${slug}/prospects/import`}>Import prospects</LinkButton>
          <LinkButton href={`/w/${slug}/campaigns/new`} kind="primary">New campaign</LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Prospects" value={data.prospects} />
        <Stat label="Qualified" value={data.qualified} tone="#3ECF9A" />
        <Stat label="Sent (7d)" value={data.sent} />
        <Stat label="Replies (7d)" value={data.replies} tone="#6AA8FF" />
        <Stat label="Meetings" value={data.meetings} tone="#B79CFF" />
        <Stat label="Awaiting approval" value={data.pending} tone={data.pending > 0 ? "#FFB224" : undefined} />
      </div>

      {(() => {
        const h = data.health;
        const attention = h.killSwitch || h.failedJobs > 0 || h.sendersVerified < h.sendersTotal;
        const capPct = h.dailyCap > 0 ? Math.min(100, Math.round((h.sentToday / h.dailyCap) * 100)) : 0;
        return (
          <Panel>
            <PanelHeader
              title="Send health"
              sub="Deliverability guardrails across this workspace, live."
              actions={<Pill tone={attention ? "amber" : "green"} dot>{attention ? "attention" : "all clear"}</Pill>}
            />
            <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-5">
              <div className="bg-ink-850 px-5 py-4">
                <div className="label">Kill switch</div>
                <div className={`mt-1 text-sm font-semibold ${h.killSwitch ? "text-rose" : "text-mint"}`}>{h.killSwitch ? "ENGAGED" : "released"}</div>
              </div>
              <div className="bg-ink-850 px-5 py-4">
                <div className="label">Senders verified</div>
                <div className="mt-1 text-sm font-semibold">{h.sendersVerified}<span className="text-fg-faint">/{h.sendersTotal}</span></div>
              </div>
              <div className="bg-ink-850 px-5 py-4">
                <div className="label">Sent (24h) vs cap</div>
                <div className="mt-1 text-sm font-semibold">{h.sentToday}<span className="text-fg-faint">/{h.dailyCap || "-"}</span></div>
                {h.dailyCap > 0 && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-750">
                    <div className={`h-full rounded-full ${capPct > 85 ? "bg-rose" : capPct > 60 ? "bg-flare" : "bg-mint"}`} style={{ width: `${capPct}%` }} />
                  </div>
                )}
              </div>
              <div className="bg-ink-850 px-5 py-4">
                <div className="label">Active suppressions</div>
                <div className="mt-1 text-sm font-semibold">{h.suppressions}</div>
              </div>
              <div className="bg-ink-850 px-5 py-4">
                <div className="label">Failed jobs (24h)</div>
                <div className={`mt-1 text-sm font-semibold ${h.failedJobs > 0 ? "text-rose" : ""}`}>{h.failedJobs}</div>
              </div>
            </div>
          </Panel>
        );
      })()}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Campaigns" actions={<LinkButton href={`/w/${slug}/campaigns`}>View all</LinkButton>} />
          {data.campaigns.length === 0 ? (
            <Empty title="No campaigns yet" hint="Create your first campaign to start the approval flow." />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Status</th><th className="th text-right">Versions</th></tr></thead>
              <tbody>
                {data.campaigns.map((c: any) => (
                  <tr key={c.id} className="hover:bg-ink-850/60 transition">
                    <td className="td"><Link className="font-medium text-fg hover:text-flare" href={`/w/${slug}/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td className="td"><StatePill state={c.status} /></td>
                    <td className="td text-right text-fg-mute">{c.versions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Recent activity" />
          <ul className="divide-y divide-line-soft">
            {data.activity.map((a: any, i: number) => (
              <li key={i} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="text-[11px] text-fg-soft">{a.action}</code>
                  <span className="text-[10px] text-fg-faint">{new Date(a.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-fg-faint">
                  <Pill tone={a.actor_type === "webhook" ? "blue" : a.actor_type === "user" ? "gray" : "purple"}>{a.actor_type}</Pill>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
