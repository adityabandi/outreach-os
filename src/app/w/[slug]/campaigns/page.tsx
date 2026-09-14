import Link from "next/link";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, StatePill, Empty, LinkButton } from "@/ui/primitives";

export const dynamic = "force-dynamic";

const STATUS_ORDER = ["draft", "approval_pending", "approved", "scheduled", "running", "paused", "completed", "rejected", "cancelled"];
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", approval_pending: "In review", approved: "Approved", scheduled: "Scheduled",
  running: "Running", paused: "Paused", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled",
};

export default async function CampaignsPage({
  params, searchParams,
}: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; status?: string }> }) {
  const { slug } = await params;
  const { q = "", status = "all" } = await searchParams;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select c.id, c.name, c.status, c.created_at, u.display_name as creator,
              (select count(*) from campaign_versions cv where cv.campaign_id = c.id) as versions,
              count(distinct md.id) filter (where md.status = 'sent')::int as sent,
              count(distinct md.id) filter (where md.status in ('scheduled','sending'))::int as upcoming,
              count(distinct md.id) filter (where md.status in ('suppressed','skipped','failed'))::int as held,
              count(distinct im.id)::int as replies
         from campaigns c
         left join users u on u.id = c.created_by
         left join campaign_versions cv on cv.campaign_id = c.id
         left join message_deliveries md on md.campaign_version_id = cv.id
         left join inbound_messages im on im.thread_ref = md.thread_ref and im.workspace_id = c.workspace_id
        group by c.id, u.display_name
        order by c.created_at desc`);
    return r.rows;
  });

  const query = q.trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const c of rows) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const presentStatuses = STATUS_ORDER.filter((s) => counts.has(s));
  const filtered = rows.filter((c: any) =>
    (status === "all" || c.status === status) &&
    (!query || c.name.toLowerCase().includes(query)));

  const hrefFor = (s: string) => {
    const p = new URLSearchParams();
    if (s !== "all") p.set("status", s);
    if (q.trim()) p.set("q", q.trim());
    const qs = p.toString();
    return `/w/${slug}/campaigns${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-fg-mute">Every send runs through an approved, immutable version.</p>
        </div>
        <LinkButton href={`/w/${slug}/campaigns/new`} kind="primary">New campaign</LinkButton>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={hrefFor("all")}
            className={`pill ${status === "all" ? "border-flare/40 bg-flare/10 text-flare" : "border-line-strong bg-ink-750 text-fg-mute hover:text-fg-soft"}`}>
            All · {rows.length}
          </Link>
          {presentStatuses.map((s) => (
            <Link key={s} href={hrefFor(s)}
              className={`pill ${status === s ? "border-flare/40 bg-flare/10 text-flare" : "border-line-strong bg-ink-750 text-fg-mute hover:text-fg-soft"}`}>
              {STATUS_LABELS[s]} · {counts.get(s)}
            </Link>
          ))}
        </div>
        <form method="get" className="flex items-center gap-2">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder="Search campaigns" className="input !w-52 !py-1.5 text-xs" />
          <button className="btn-ghost !px-2.5 !py-1.5 text-xs">Search</button>
        </form>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <Empty title="No campaigns yet" action={<LinkButton href={`/w/${slug}/campaigns/new`} kind="primary">Create one</LinkButton>} />
        ) : filtered.length === 0 ? (
          <Empty title="Nothing matches"
            hint={`No campaigns match ${query ? `"${q.trim()}"` : ""}${query && status !== "all" ? " in " : ""}${status !== "all" ? STATUS_LABELS[status] ?? status : ""}.`}
            action={<LinkButton href={`/w/${slug}/campaigns`}>Clear filters</LinkButton>} />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Name</th><th className="th">Status</th><th className="th">Progress</th>
              <th className="th text-right">Replies</th><th className="th">Created by</th>
              <th className="th">Created</th><th className="th text-right">Versions</th><th className="th"></th>
            </tr></thead>
            <tbody>
              {filtered.map((c: any) => {
                const total = c.sent + c.upcoming + c.held;
                const pct = total > 0 ? Math.round((c.sent / total) * 100) : 0;
                return (
                  <tr key={c.id} className="hover:bg-ink-850/60 transition">
                    <td className="td font-medium"><Link className="hover:text-flare" href={`/w/${slug}/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td className="td"><StatePill state={c.status} /></td>
                    <td className="td">
                      {total > 0 ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-750">
                            <div className="h-full rounded-full bg-mint" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-fg-mute">{c.sent}/{total} sent</span>
                        </div>
                      ) : (
                        <span className="text-xs text-fg-faint">not launched</span>
                      )}
                    </td>
                    <td className="td text-right text-fg-mute">{c.replies > 0 ? c.replies : <span className="text-fg-faint">-</span>}</td>
                    <td className="td text-fg-mute">{c.creator}</td>
                    <td className="td text-fg-mute text-xs">{new Date(c.created_at).toLocaleDateString("en-GB")}</td>
                    <td className="td text-right text-fg-mute">v{c.versions}</td>
                    <td className="td text-right"><Link className="text-xs text-flare hover:underline" href={`/w/${slug}/campaigns/${c.id}`}>Open →</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
