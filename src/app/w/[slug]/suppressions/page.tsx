import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, Pill, Empty } from "@/ui/primitives";
import { addSuppressionAction, liftSuppressionAction } from "@/server/actions";
import { matchesSuppression } from "@/domain/compliance";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ check?: string }> }) {
  const { slug } = await params;
  const { check } = await searchParams;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from suppression_entries order by created_at desc limit 200`);
    return r.rows;
  });
  const active = rows.filter((r: any) => !r.expires_at || new Date(r.expires_at) > new Date());
  const checkResult = check
    ? matchesSuppression(active.map((r: any) => ({ scope: r.scope, normalized_value: r.normalized_value, expires_at: r.expires_at })), check)
    : null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Suppressions</h1>
        <p className="mt-1 text-sm text-fg-mute">Checked at scheduling and again immediately before every send. Unsubscribe replies land here instantly.</p>
      </div>
      <Panel>
        <PanelHeader title="Add suppression" />
        <form action={addSuppressionAction.bind(null, slug)} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-5">
          <input name="value" className="input" placeholder="email or domain" required />
          <select name="scope" className="input" defaultValue="workspace">
            <option value="workspace">this workspace</option>
            <option value="domain">domain-wide</option>
            <option value="global">global</option>
          </select>
          <input name="reason" className="input" placeholder="reason" required />
          <input name="expires_at" type="date" className="input" title="Optional expiry" />
          <button className="btn-ghost">Add</button>
        </form>
      </Panel>
      <Panel>
        <PanelHeader title="Test an address" sub="Dry-run the exact pre-send check against the active rules." />
        <form method="get" className="flex gap-3 px-5 py-4">
          <input name="check" className="input" placeholder="prospect@example.com" defaultValue={check ?? ""} required />
          <button className="btn-ghost">Check</button>
        </form>
        {check && checkResult && (
          <div className={`mx-5 mb-4 rounded-lg border px-4 py-3 text-sm ${checkResult.suppressed ? "border-rose/40 bg-rose/10 text-rose" : "border-mint/40 bg-mint/10 text-mint"}`}>
            {checkResult.suppressed ? `Suppressed: ${checkResult.reason}` : "Clear - this address would be sent to."}
          </div>
        )}
      </Panel>
      <Panel>
        {rows.length === 0 ? <Empty title="No suppressions" /> : (
          <table className="w-full">
            <thead><tr><th className="th">Value</th><th className="th">Scope</th><th className="th">Reason</th><th className="th">Source</th><th className="th">Added</th><th className="th">Expires</th><th className="th text-right"></th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs">{r.normalized_value}</td>
                  <td className="td"><Pill tone={r.scope === "global" ? "red" : r.scope === "domain" ? "amber" : "gray"}>{r.scope}</Pill></td>
                  <td className="td text-fg-mute">{r.reason}</td>
                  <td className="td text-fg-mute text-xs">{r.source}</td>
                  <td className="td text-fg-faint text-xs">{new Date(r.created_at).toLocaleDateString("en-GB")}</td>
                  <td className="td text-fg-faint text-xs">{r.expires_at ? new Date(r.expires_at).toLocaleDateString("en-GB") : "never"}</td>
                  <td className="td text-right">
                    {(!r.expires_at || new Date(r.expires_at) > new Date()) && (
                      <form action={liftSuppressionAction.bind(null, slug, r.id)}><button className="btn-ghost !px-2.5 !py-1 text-xs">Lift</button></form>
                    )}
                    {r.expires_at && new Date(r.expires_at) <= new Date() && <Pill tone="gray">expired</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
