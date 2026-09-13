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
    const byCampaign = await db.query(
      `select c.name,
         count(*) filter (where md.status = 'sent')::int as sent,
         (select count(*) from inbound_messages im where im.workspace_id = $1)::int as replies
       from campaigns c
       left join campaign_versions cv on cv.campaign_id = c.id
       left join message_deliveries md on md.campaign_version_id = cv.id
       group by c.name order by sent desc`, [ctx.workspaceId]);
    return { funnel: funnel.rows[0], replies: replies.rows, conversions: conv.rows, byCampaign: byCampaign.rows };
  });
  const f = data.funnel;
  const totalReplies = data.replies.reduce((a: number, r: any) => a + r.n, 0);
  const rate = f.sent > 0 ? ((totalReplies / f.sent) * 100).toFixed(1) : "0.0";
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
        <Panel>
          <PanelHeader title="By campaign" />
          <ul className="divide-y divide-line-soft">
            {data.byCampaign.map((c: any) => (
              <li key={c.name} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="text-fg-soft">{c.name}</span>
                <span className="font-mono text-xs text-fg-mute">{c.sent} sent</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
