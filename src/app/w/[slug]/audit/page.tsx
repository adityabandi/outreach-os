import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, Pill, Empty } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select ae.*, u.display_name as actor_name from audit_events ae
         left join users u on u.id = ae.actor_id
        where ae.workspace_id = $1 order by ae.occurred_at desc limit 100`, [ctx.workspaceId]);
    return r.rows;
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-fg-mute">Append-only. Approvals, launches, sends, suppressions and integration changes land here with actor and timestamp.</p>
      </div>
      <Panel>
        {rows.length === 0 ? <Empty title="No events yet" /> : (
          <table className="w-full">
            <thead><tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Target</th><th className="th">Detail</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="td whitespace-nowrap text-xs text-fg-mute">{new Date(r.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td className="td"><Pill tone={r.actor_type === "webhook" ? "blue" : r.actor_type === "worker" ? "purple" : "gray"}>{r.actor_type}</Pill><span className="ml-2 text-xs text-fg-soft">{r.actor_name ?? ""}</span></td>
                  <td className="td"><code className="text-xs">{r.action}</code></td>
                  <td className="td font-mono text-[11px] text-fg-faint">{r.target_type ?? ""}{r.target_id ? ` · ${String(r.target_id).slice(0, 8)}` : ""}</td>
                  <td className="td max-w-xs truncate font-mono text-[11px] text-fg-faint">{JSON.stringify(r.metadata_json)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
