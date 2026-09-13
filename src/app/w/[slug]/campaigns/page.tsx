import Link from "next/link";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Empty, LinkButton } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select c.id, c.name, c.status, c.created_at, u.display_name as creator,
              (select count(*) from campaign_versions cv where cv.campaign_id = c.id) as versions,
              (select cv.id from campaign_versions cv where cv.campaign_id = c.id order by cv.version_number desc limit 1) as latest_version_id,
              (select count(*) from message_deliveries md join campaign_versions cv on cv.id = md.campaign_version_id
                where cv.campaign_id = c.id and md.status = 'sent') as sent_count
         from campaigns c left join users u on u.id = c.created_by
        order by c.created_at desc`);
    return r.rows;
  });
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-fg-mute">Every send runs through an approved, immutable version.</p>
        </div>
        <LinkButton href={`/w/${slug}/campaigns/new`} kind="primary">New campaign</LinkButton>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <Empty title="No campaigns yet" action={<LinkButton href={`/w/${slug}/campaigns/new`} kind="primary">Create one</LinkButton>} />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Name</th><th className="th">Status</th><th className="th">Created by</th>
              <th className="th text-right">Sent</th><th className="th text-right">Versions</th><th className="th"></th>
            </tr></thead>
            <tbody>
              {rows.map((c: any) => (
                <tr key={c.id} className="hover:bg-ink-850/60 transition">
                  <td className="td font-medium"><Link className="hover:text-flare" href={`/w/${slug}/campaigns/${c.id}`}>{c.name}</Link></td>
                  <td className="td"><StatePill state={c.status} /></td>
                  <td className="td text-fg-mute">{c.creator}</td>
                  <td className="td text-right text-fg-mute">{c.sent_count}</td>
                  <td className="td text-right text-fg-mute">v{c.versions}</td>
                  <td className="td text-right"><Link className="text-xs text-flare hover:underline" href={`/w/${slug}/campaigns/${c.id}`}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
