import { notFound } from "next/navigation";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill } from "@/ui/primitives";
import { verifyContactAction } from "@/server/actions";

export const dynamic = "force-dynamic";

export default async function ProspectDetail({ params }: { params: Promise<{ slug: string; personId: string }> }) {
  const { slug, personId } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const p = await db.query(
      `select p.*, co.name as company, co.normalized_domain, co.country, co.industry
         from people p left join companies co on co.id = p.company_id where p.id = $1`, [personId]);
    if (p.rowCount === 0) return null;
    const contacts = await db.query(`select * from contact_points where person_id = $1`, [personId]);
    const evidence = await db.query(`select * from evidence_items where subject_type = 'person' and subject_id = $1 order by observed_at desc`, [personId]);
    const quals = await db.query(`select * from qualification_runs where person_id = $1 order by created_at desc limit 3`, [personId]);
    const deliveries = await db.query(
      `select md.*, cv.version_number, c.name as campaign_name from message_deliveries md
         join campaign_versions cv on cv.id = md.campaign_version_id join campaigns c on c.id = cv.campaign_id
        where md.person_id = $1 order by md.scheduled_at desc`, [personId]);
    const replies = await db.query(
      `select im.*, rc.category from inbound_messages im
         left join reply_classifications rc on rc.inbound_message_id = im.id
        where im.person_id = $1 order by im.received_at desc`, [personId]);
    const conversions = await db.query(
      `select * from conversions where person_id = $1 order by occurred_at desc`, [personId]);
    return { person: p.rows[0], contacts: contacts.rows, evidence: evidence.rows, quals: quals.rows, deliveries: deliveries.rows, replies: replies.rows, conversions: conversions.rows };
  });
  if (!data) notFound();
  const { person } = data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{person.full_name}</h1>
        <p className="mt-1 text-sm text-fg-mute">{person.title}{person.company ? ` · ${person.company}` : ""}{person.country ? ` · ${person.country}` : ""}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Contact routes" sub="Only manually or provider-verified routes may be sent to." />
          <div className="space-y-3 px-5 py-4">
            {data.contacts.map((c: any) => (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono text-xs">{c.normalized_value}</div>
                  <div className="mt-1"><StatePill state={c.verification_status} />{c.verification_provider && <span className="ml-2 text-[10px] text-fg-faint">via {c.verification_provider}</span>}</div>
                </div>
                <span className="flex gap-1.5">
                  {c.verification_status !== "verified" && (
                    <form action={verifyContactAction.bind(null, slug, c.id, "verified")}><button className="btn-ghost !px-2.5 !py-1 text-xs">Mark verified</button></form>
                  )}
                  {c.verification_status === "verified" && (
                    <form action={verifyContactAction.bind(null, slug, c.id, "risky")}><button className="btn-ghost !px-2.5 !py-1 text-xs">Mark risky</button></form>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Qualification" sub="Every positive reason must cite stored evidence." />
          <div className="space-y-3 px-5 py-4">
            {data.quals.map((qn: any) => (
              <div key={qn.id}>
                <div className="flex items-center gap-2">
                  <StatePill state={qn.disposition} />
                  <span className="text-xs text-fg-mute">score {Number(qn.score).toFixed(2)} · confidence {Number(qn.confidence).toFixed(2)}</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {(qn.reasons_json as any[]).map((r, i) => (
                    <li key={i} className="text-xs text-fg-soft">· {r.reason} <span className="text-fg-faint">(evidence {String(r.evidence).slice(0, 8)})</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel>
        <PanelHeader title="Evidence" sub="Source of every fact, with observed time." />
        <ul className="divide-y divide-line-soft">
          {data.evidence.map((e: any) => (
            <li key={e.id} className="px-5 py-3">
              <div className="text-sm text-fg-soft">{e.excerpt}</div>
              <div className="mt-1 flex gap-2 text-[11px] text-fg-faint">
                <Pill tone="gray">{e.source_type}</Pill>
                {e.source_url && <span className="font-mono">{e.source_url}</span>}
                <span>observed {new Date(e.observed_at).toLocaleDateString("en-GB")}</span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      {(() => {
        type Ev = { at: string; kind: string; title: string; detail?: string; tone: string };
        const events: Ev[] = [
          ...data.deliveries.map((d: any): Ev => ({
            at: d.sent_at ?? d.scheduled_at, kind: "delivery",
            title: `${d.campaign_name} v${d.version_number} · step ${d.step_number}`,
            detail: d.status,
            tone: d.status === "sent" ? "#6AA8FF" : d.status === "scheduled" ? "#8B8F9E" : d.status === "suppressed" || d.status === "skipped" ? "#FFB224" : "#FF6B6B",
          })),
          ...data.replies.map((r: any): Ev => ({
            at: r.received_at, kind: "reply",
            title: `Replied${r.category ? ` · classified ${r.category}` : ""}`,
            detail: r.subject ?? undefined,
            tone: r.category === "unsubscribe" ? "#FF6B6B" : r.category === "interested" ? "#3ECF9A" : "#B79CFF",
          })),
          ...data.conversions.map((c: any): Ev => ({
            at: c.occurred_at, kind: "conversion",
            title: `Conversion: ${c.event_type}${c.value_amount ? ` · $${c.value_amount}` : ""}`,
            tone: "#3ECF9A",
          })),
          ...data.quals.map((qn: any): Ev => ({
            at: qn.created_at, kind: "qualification",
            title: `Qualified ${qn.disposition} · score ${Number(qn.score).toFixed(2)}`,
            tone: "#8B8F9E",
          })),
          ...data.evidence.map((e: any): Ev => ({
            at: e.observed_at, kind: "evidence",
            title: `Evidence from ${e.source_type}`, detail: e.excerpt?.slice(0, 120),
            tone: "#8B8F9E",
          })),
        ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        return (
          <Panel>
            <PanelHeader title="Timeline" sub="Everything that happened with this person, newest first." />
            <ol className="relative px-5 py-4">
              {events.map((ev, i) => (
                <li key={i} className="relative flex gap-4 pb-5 last:pb-0">
                  {i < events.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-line-soft" />}
                  <span className="mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-ink-850" style={{ background: ev.tone }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="text-sm font-medium">{ev.title}</div>
                      <div className="text-[11px] text-fg-faint">{new Date(ev.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    {ev.detail && <div className="mt-0.5 truncate text-xs text-fg-mute">{ev.detail}</div>}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        );
      })()}
    </div>
  );
}
