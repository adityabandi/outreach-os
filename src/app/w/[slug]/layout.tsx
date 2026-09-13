import { redirect } from "next/navigation";
import { currentActor, listAccessibleWorkspaces, requireWorkspace } from "@/server/auth";
import { killSwitchAction, logoutAction } from "@/server/actions";
import { withTenant } from "@/db/client";
import { NavLink } from "@/ui/nav";
import { Pill } from "@/ui/primitives";

export const dynamic = "force-dynamic";

const NAV: [string, string][] = [
  ["Dashboard", ""], ["Prospects", "/prospects"], ["Campaigns", "/campaigns"],
  ["Replies", "/replies"], ["Analytics", "/analytics"], ["Suppressions", "/suppressions"],
  ["Audit log", "/audit"], ["Outbox", "/outbox"], ["Settings", "/settings"],
];

export default async function WorkspaceLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const actor = (await currentActor())!;
  const workspaces = await listAccessibleWorkspaces(actor);
  const ws = workspaces.find((w) => w.slug === slug);
  if (!ws) redirect("/");

  const stats = await withTenant(ctx.workspaceId, async (db) => {
    const running = await db.query(
      `select count(*)::int as n from campaign_runs cr
         join campaign_versions cv on cv.id = cr.campaign_version_id
         join campaigns c on c.id = cv.campaign_id
        where c.workspace_id = $1 and cr.status = 'running'`, [ctx.workspaceId]);
    const pending = await db.query(
      `select count(*)::int as n from approval_requests where workspace_id = $1 and status = 'pending'`, [ctx.workspaceId]);
    const replies = await db.query(
      `select count(*)::int as n from inbound_messages where workspace_id = $1 and received_at > now() - interval '7 days'`, [ctx.workspaceId]);
    return { running: running.rows[0].n, pending: pending.rows[0].n, replies: replies.rows[0].n };
  });

  const killOn = ws.kill_switch;
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 flex w-60 flex-col border-r border-line bg-ink-900">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-ink-850">
            <span className="text-sm font-semibold text-flare">⌁</span>
          </div>
          <div>
            <div className="text-[13px] font-semibold tracking-tight">Outreach OS</div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">internal</div>
          </div>
        </div>
        <div className="border-b border-line px-3 py-3">
          <label className="label px-1">Workspace</label>
          <div className="space-y-1">
            {workspaces.map((w) => (
              <a key={w.id} href={`/w/${w.slug}`}
                 className={`block rounded-lg px-3 py-2 text-[13px] transition ${w.slug === slug ? "bg-ink-800 border border-line text-fg" : "text-fg-mute hover:text-fg hover:bg-ink-850 border border-transparent"}`}>
                <span className="font-medium">{w.name}</span>
                <span className="ml-2 text-[10px] text-fg-faint">{w.default_timezone}</span>
              </a>
            ))}
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
          {NAV.map(([name, path]) => <NavLink key={name} slug={slug} name={name} path={path} />)}
        </nav>
        <div className="border-t border-line px-3 py-3 space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-line bg-ink-850 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${killOn ? "bg-rose" : stats.running > 0 ? "bg-mint animate-pulse" : "bg-fg-faint"}`} />
              <span className="text-[11px] font-medium text-fg-soft">
                {killOn ? "Sends halted" : stats.running > 0 ? `${stats.running} campaign${stats.running > 1 ? "s" : ""} live` : "Senders idle"}
              </span>
            </div>
            <form action={killSwitchAction.bind(null, slug, !killOn)}>
              <button className={`text-[10px] font-semibold uppercase tracking-wider ${killOn ? "text-mint" : "text-rose"} hover:underline`}>
                {killOn ? "Resume" : "Stop all"}
              </button>
            </form>
          </div>
          {stats.pending > 0 && (
            <a href={`/w/${slug}/campaigns`} className="flex items-center justify-between rounded-lg border border-flare/30 bg-flare/5 px-3 py-2 text-[11px] text-flare">
              {stats.pending} approval{stats.pending > 1 ? "s" : ""} waiting <span>→</span>
            </a>
          )}
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[11px] text-fg-mute">{actor.displayName}</span>
            <form action={logoutAction}><button className="text-[11px] text-fg-faint hover:text-fg">Sign out</button></form>
          </div>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-6 max-w-[1200px]">{children}</main>
    </div>
  );
}
