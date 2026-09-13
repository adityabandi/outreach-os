import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, Pill, Empty } from "@/ui/primitives";
import { addSuppressionAction } from "@/server/actions";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from suppression_entries order by created_at desc limit 200`);
    return r.rows;
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Suppressions</h1>
        <p className="mt-1 text-sm text-fg-mute">Checked at scheduling and again immediately before every send. Unsubscribe replies land here instantly.</p>
      </div>
      <Panel>
        <PanelHeader title="Add suppression" />
        <form action={addSuppressionAction.bind(null, slug)} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-4">
          <input name="value" className="input" placeholder="email or domain" required />
          <select name="scope" className="input" defaultValue="workspace">
            <option value="workspace">this workspace</option>
            <option value="domain">domain-wide</option>
            <option value="global">global</option>
          </select>
          <input name="reason" className="input" placeholder="reason" required />
          <button className="btn-ghost">Add</button>
        </form>
      </Panel>
      <Panel>
        {rows.length === 0 ? <Empty title="No suppressions" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Value</th><th className="th">Scope</th><th className="th">Reason</th><th className="th">Source</th><th className="th">Added</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs">{r.normalized_value}</td>
                  <td className="td"><Pill tone={r.scope === "global" ? "red" : r.scope === "domain" ? "amber" : "gray"}>{r.scope}</Pill></td>
                  <td className="td text-fg-mute">{r.reason}</td>
                  <td className="td text-fg-mute text-xs">{r.source}</td>
                  <td className="td text-fg-faint text-xs">{new Date(r.created_at).toLocaleDateString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
