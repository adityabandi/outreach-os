import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, Stat } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const funnel = await db.query(
      `select
         count(*) filter (where status = 'sent')::int as sent,
         count(*) filter (where status = 'suppressed')::int as suppressed,
         count(*) filter (where status = 'skipped')::int as skipped,
         count(*) filter (where status = 'failed')::int as failed
       from message_deliveries`);
    const replies = await db.query(`select category, count(*)::int n from reply_classifications group by category order by n desc`);
    const conv = await db.query(
      `select event_type, count(*)::int n, coalesce(sum(value_amount),0)::numeric as value
         from conversions group by event_type`);
    // per-campaign funnel: replies join through the delivery thread, conversions carry campaign_id
    const byCampaign = await db.query(
      `select c.id, c.name, c.status,
         count(distinct md.id) filter (where md.status = 'sent')::int as sent,
         count(distinct im.id)::int as replies,
         count(distinct im.id) filter (where rc.category in ('interested','question','negotiation'))::int as positive,
         coalesce(cnv.meetings, 0)::int as meetings,
         coalesce(cnv.revenue, 0)::numeric as revenue
       from campaigns c
       left join campaign_versions cv on cv.campaign_id = c.id
       left join message_deliveries md on md.campaign_version_id = cv.id
       left join inbound_messages im on im.thread_ref = md.thread_ref
       left join lateral (select category from reply_classifications r where r.inbound_message_id = im.id limit 1) rc on true
       left join (select campaign_id,
                    count(*) filter (where event_type = 'meeting')::int as meetings,
                    sum(value_amount) as revenue
                  from conversions group by campaign_id) cnv on cnv.campaign_id = c.id
       group by c.id, c.name, c.status, cnv.meetings, cnv.revenue order by sent desc`);
    const recentConv = await db.query(
      `select cn.id, cn.event_type, cn.value_amount, cn.currency, cn.occurred_at, cn.attribution_json,
              p.full_name, c.name as campaign_name
         from conversions cn
         left join people p on p.id = cn.person_id
         left join campaigns c on c.id = cn.campaign_id
        order by cn.occurred_at desc limit 12`);
    // 14-day send/reply series
    const series = await db.query(
      `with days as (select generate_series(current_date - 13, current_date, '1 day')::date d)
       select d,
         (select count(*)::int from message_deliveries md where md.status = 'sent' and md.sent_at::date = d) as sent,
         (select count(*)::int from inbound_messages im where im.received_at::date = d) as replies
       from days order by d`);
    return { funnel: funnel.rows[0], replies: replies.rows, conversions: conv.rows, byCampaign: byCampaign.rows, series: series.rows, recentConv: recentConv.rows };
  });
  const f = data.funnel;
  const totalReplies = data.replies.reduce((a: number, r: any) => a + r.n, 0);
  const rate = f.sent > 0 ? ((totalReplies / f.sent) * 100).toFixed(1) : "0.0";
  const maxSent = Math.max(1, ...data.series.map((d: any) => d.sent));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-fg-mute">Funnel counts reconcile to prospect and message records - no estimated metrics.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Sent" value={f.sent} />
        <Stat label="Reply rate" value={`${rate}%`} tone="#6AA8FF" hint={`${totalReplies} replies`} />
        <Stat label="Suppressed" value={f.suppressed} tone="#F47067" />
        <Stat label="Skipped" value={f.skipped} />
        <Stat label="Failed" value={f.failed} tone={f.failed > 0 ? "#F47067" : undefined} />
      </div>

      <Panel>
        <PanelHeader title="Last 14 days" sub="Sends vs replies per day, from delivery and inbound records." />
        <div className="flex items-end gap-[3px] px-5 pb-2 pt-5">
          {data.series.map((d: any) => (
            <div key={d.d} className="group relative flex-1">
              <div className="flex h-28 items-end justify-center gap-[2px]">
                <div className="w-2.5 rounded-sm bg-sky/70" style={{ height: `${(d.sent / maxSent) * 100}%`, minHeight: d.sent > 0 ? 3 : 0 }} />
                <div className="w-2.5 rounded-sm bg-mint/70" style={{ height: `${(d.replies / maxSent) * 100}%`, minHeight: d.replies > 0 ? 3 : 0 }} />
              </div>
              <div className="mt-1.5 text-center text-[9px] text-fg-faint">{new Date(d.d).toLocaleDateString("en-GB", { day: "numeric", month: "numeric" })}</div>
              <div className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line-soft bg-ink-900 px-2 py-1 text-[10px] text-fg-soft opacity-0 shadow-lg transition group-hover:opacity-100">
                {d.sent} sent · {d.replies} replies
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-4 border-t border-line-soft px-5 py-3 text-[11px] text-fg-mute">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-sky/70" /> sent</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-mint/70" /> replies</span>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Funnel by campaign" sub="Replies attributed through the delivery thread; conversions carry their campaign." />
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Campaign</th><th className="th text-right">Sent</th><th className="th text-right">Replies</th>
              <th className="th text-right">Reply rate</th><th className="th text-right">Positive</th><th className="th text-right">Meetings</th><th className="th text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.byCampaign.map((c: any) => (
              <tr key={c.id}>
                <td className="td font-medium">{c.name}</td>
                <td className="td text-right font-mono text-xs">{c.sent}</td>
                <td className="td text-right font-mono text-xs">{c.replies}</td>
                <td className="td text-right font-mono text-xs text-sky">{c.sent > 0 ? `${((c.replies / c.sent) * 100).toFixed(0)}%` : "-"}</td>
                <td className="td text-right font-mono text-xs text-mint">{c.positive}</td>
                <td className="td text-right font-mono text-xs text-lilac">{c.meetings}</td>
                <td className="td text-right font-mono text-xs">{Number(c.revenue) > 0 ? `$${Number(c.revenue).toFixed(2)}` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Replies by category" />
          <ul className="divide-y divide-line-soft">
            {data.replies.map((r: any) => (
              <li key={r.category} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="text-fg-soft">{r.category.replace(/_/g, " ")}</span>
                <span className="font-mono text-xs text-fg-mute">{r.n}</span>
              </li>
            ))}
            {data.replies.length === 0 && <li className="px-5 py-4 text-sm text-fg-faint">No replies yet.</li>}
          </ul>
        </Panel>
        <Panel>
          <PanelHeader title="Conversions" />
          <ul className="divide-y divide-line-soft">
            {data.conversions.map((cv: any) => (
              <li key={cv.event_type} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="text-fg-soft">{cv.event_type}</span>
                <span className="font-mono text-xs text-fg-mute">{cv.n}{Number(cv.value) > 0 ? ` · $${Number(cv.value).toFixed(2)}` : ""}</span>
              </li>
            ))}
            {data.conversions.length === 0 && <li className="px-5 py-4 text-sm text-fg-faint">No conversions yet.</li>}
          </ul>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Recent conversions" sub="External signup and revenue events mapped back to the recipient and campaign - discount code match first, signup email as fallback. One row per external event reference." />
        <table className="w-full">
          <thead><tr><th className="th">When</th><th className="th">Person</th><th className="th">Type</th><th className="th">Value</th><th className="th">Campaign</th><th className="th">Matched by</th><th className="th">Provider</th></tr></thead>
          <tbody>
            {data.recentConv.map((cn: any) => (
              <tr key={cn.id} className="hover:bg-ink-850/60">
                <td className="td text-xs text-fg-mute">{new Date(cn.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="td font-medium">{cn.full_name ?? <span className="text-fg-faint">-</span>}</td>
                <td className="td text-fg-soft">{cn.event_type}</td>
                <td className="td font-mono text-xs text-fg-mute">{cn.value_amount != null ? `${cn.currency ?? "$"}${Number(cn.value_amount).toFixed(2)}` : "-"}</td>
                <td className="td text-fg-mute">{cn.campaign_name ?? <span className="text-fg-faint">-</span>}</td>
                <td className="td text-xs text-fg-mute">{cn.attribution_json?.matched_by ?? "-"}{cn.attribution_json?.code ? <span className="ml-1 font-mono">({cn.attribution_json.code})</span> : ""}</td>
                <td className="td text-xs text-fg-mute">{cn.attribution_json?.provider ?? "-"}</td>
              </tr>
            ))}
            {data.recentConv.length === 0 && (
              <tr><td colSpan={7} className="td py-6 text-center text-sm text-fg-faint">No conversions recorded yet. When a recipient signs up with their discount code, the Rewardful or Stripe webhook lands here.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
