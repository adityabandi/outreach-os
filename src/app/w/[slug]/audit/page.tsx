import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import Link from "next/link";
import { Panel, Pill, Empty } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ actor?: string; action?: string; from?: string; to?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  const where: string[] = ["ae.workspace_id = $1"];
  const params2: unknown[] = [ctx.workspaceId];
  if (sp.actor) { params2.push(sp.actor); where.push(`ae.actor_type = $${params2.length}`); }
  if (sp.action) { params2.push(`%${sp.action}%`); where.push(`ae.action ilike $${params2.length}`); }
  if (sp.from) { params2.push(sp.from); where.push(`ae.occurred_at >= $${params2.length}::date`); }
  if (sp.to) { params2.push(sp.to); where.push(`ae.occurred_at < ($${params2.length}::date + 1)`); }
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select ae.*, u.display_name as actor_name from audit_events ae
         left join users u on u.id = ae.actor_id
        where ${where.join(" and ")} order by ae.occurred_at desc limit 200`, params2);
    const actions = await db.query(`select distinct action from audit_events where workspace_id = $1 order by action`, [ctx.workspaceId]);
    return { rows: r.rows, actions: actions.rows.map((a: any) => a.action as string) };
  });
  const actorPills: [string, string][] = [["", "All actors"], ["user", "Users"], ["worker", "Worker"], ["webhook", "Webhooks"], ["system", "System"]];
  const mkHref = (over: Record<string, string>) => {
    const cur: Record<string, string> = { actor: sp.actor ?? "", action: sp.action ?? "", from: sp.from ?? "", to: sp.to ?? "", ...over };
    const qs = Object.entries(cur).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `/w/${slug}/audit${qs ? `?${qs}` : ""}`;
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-fg-mute">Append-only. Approvals, launches, sends, suppressions and integration changes land here with actor and timestamp.</p>
      </div>
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-3">
          {actorPills.map(([k, label]) => (
            <Link key={k} href={mkHref({ actor: k })}><Pill tone={(sp.actor ?? "") === k ? "amber" : "gray"}>{label}</Pill></Link>
          ))}
          <form method="get" className="ml-auto flex flex-wrap items-center gap-2">
            {sp.actor && <input type="hidden" name="actor" value={sp.actor} />}
            <input name="action" className="input !w-48 !py-1.5 text-xs" placeholder="action contains..." defaultValue={sp.action ?? ""} list="audit-actions" />
            <datalist id="audit-actions">{rows.actions.map((a) => <option key={a} value={a} />)}</datalist>
            <input name="from" type="date" className="input !w-36 !py-1.5 text-xs" defaultValue={sp.from ?? ""} />
            <input name="to" type="date" className="input !w-36 !py-1.5 text-xs" defaultValue={sp.to ?? ""} />
            <button className="btn-ghost !px-2.5 !py-1 text-xs">Filter</button>
          </form>
        </div>
        {rows.rows.length === 0 ? <Empty title="No events match" hint="Widen the filters." /> : (
          <table className="w-full">
            <thead><tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Target</th><th className="th">Detail</th></tr></thead>
            <tbody>
              {rows.rows.map((r: any) => (
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
