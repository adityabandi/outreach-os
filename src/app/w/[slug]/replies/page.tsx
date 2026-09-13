import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill, Empty } from "@/ui/primitives";
import { simulateReplyAction } from "@/server/actions";

export const dynamic = "force-dynamic";

const CAT_TONE: Record<string, "green" | "blue" | "amber" | "red" | "gray" | "purple"> = {
  interested: "green", question: "blue", objection: "amber", not_now: "gray",
  unsubscribe: "red", wrong_person: "gray", out_of_office: "gray", complaint: "red",
  negotiation: "amber", other: "gray",
};

export default async function RepliesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select im.id, im.sender_contact, im.subject, im.body, im.received_at, im.thread_ref,
              p.full_name, rc.category, rc.confidence,
              rd.id as draft_id, rd.body as draft_body, rd.policy_class, rd.status as draft_status
         from inbound_messages im
         left join people p on p.id = im.person_id
         left join lateral (select * from reply_classifications c where c.inbound_message_id = im.id order by created_at desc limit 1) rc on true
         left join lateral (select * from reply_drafts d where d.inbound_message_id = im.id order by row_number() over () limit 1) rd on true
        order by im.received_at desc limit 50`);
    return r.rows;
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reply inbox</h1>
        <p className="mt-1 text-sm text-fg-mute">Classified automatically. Drafts are prepared, never auto-sent - sensitive categories always need a human.</p>
      </div>
      {rows.length === 0 ? (
        <Panel><Empty title="No replies yet" /></Panel>
      ) : (
        <div className="space-y-3">
          {rows.map((r: any) => (
            <Panel key={r.id}>
              <div className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.full_name ?? r.sender_contact}</span>
                    {r.category && <Pill tone={CAT_TONE[r.category] ?? "gray"} dot>{r.category}</Pill>}
                    {r.confidence != null && <span className="text-[11px] text-fg-faint">confidence {Number(r.confidence).toFixed(2)}</span>}
                    {r.policy_class === "sensitive" && <Pill tone="amber">needs review</Pill>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-fg-faint">{r.sender_contact} · {new Date(r.received_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · thread {r.thread_ref}</div>
                  <p className="mt-2 text-sm text-fg-soft">{r.body}</p>
                  {r.draft_body && (
                    <div className="panel-inset mt-3 p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-faint">Draft reply - not sent</span>
                        <Pill tone="gray">{r.draft_status}</Pill>
                      </div>
                      <p className="text-[13px] text-fg-soft">{r.draft_body}</p>
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
      <Panel>
        <PanelHeader title="Simulate inbound reply" sub="Dev tool: exercises the same ingestion path as a provider webhook - dedupe, suppression, classification, draft." />
        <form action={simulateReplyAction.bind(null, slug)} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-3">
          <input name="from" className="input" placeholder="from (prospect email)" required />
          <input name="subject" className="input lg:col-span-2" placeholder="subject" required />
          <textarea name="body" rows={3} className="input lg:col-span-3" placeholder="body" required />
          <div><button className="btn-ghost">Ingest reply</button></div>
        </form>
      </Panel>
    </div>
  );
}
