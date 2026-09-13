import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, Empty, Pill, LinkButton } from "@/ui/primitives";
import { processQueueAction } from "@/server/actions";

export const dynamic = "force-dynamic";

export default async function OutboxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select * from outbox_messages order by created_at desc limit 50`);
    const jobs = await db.query(`select job_type, status, count(*)::int n from job_runs group by job_type, status`);
    return { outbox: r.rows, jobs: jobs.rows };
  });
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Outbox</h1>
          <p className="mt-1 text-sm text-fg-mute">Dev test mailbox. The first sending adapter writes here instead of a real provider.</p>
        </div>
        <div className="flex gap-2">
          <LinkButton href={`/w/${slug}/outbox/export`}>Export CSV</LinkButton>
          <form action={processQueueAction.bind(null, slug)}><button className="btn-ghost">Process due deliveries</button></form>
        </div>
      </div>
      <div className="flex gap-2">
        {rows.jobs.map((j: any, i: number) => <Pill key={i} tone={j.status === "dead" ? "red" : j.status === "succeeded" ? "green" : "gray"}>{j.job_type} · {j.status} · {j.n}</Pill>)}
      </div>
      <Panel>
        <PanelHeader title="Sent through mock-mailbox" />
        {rows.outbox.length === 0 ? <Empty title="Outbox empty" hint="Launch a campaign, then process due deliveries." /> : (
          <ul className="divide-y divide-line-soft">
            {rows.outbox.map((m: any) => (
              <li key={m.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-fg-faint">
                  <span className="font-mono">{m.from_address}</span><span>→</span><span className="font-mono">{m.to_address}</span>
                  <span className="ml-auto">{new Date(m.created_at).toLocaleString("en-GB")}</span>
                </div>
                <div className="mt-1 text-sm font-medium">{m.subject}</div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg-mute">{m.body}</pre>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
