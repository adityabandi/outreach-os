import Link from "next/link";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, StatePill, Empty, LinkButton, Pill } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ProspectsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  const filter = sp.filter ?? "all";
  const rows = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `select p.id, p.full_name, p.title, co.name as company, cp.normalized_value, cp.verification_status, cp.do_not_contact,
              q.disposition, q.score, q.confidence,
              exists(select 1 from suppression_entries s where s.normalized_value = cp.normalized_value) as suppressed
         from people p
         left join companies co on co.id = p.company_id
         left join lateral (select * from contact_points c where c.person_id = p.id and c.type = 'email' limit 1) cp on true
         left join lateral (select disposition, score, confidence from qualification_runs qr where qr.person_id = p.id order by created_at desc limit 1) q on true
        order by p.full_name`);
    return r.rows;
  });
  const q = (sp.q ?? "").toLowerCase();
  const shown = rows.filter((r: any) =>
    (filter === "research" ? r.disposition === "research_queue" :
     filter === "qualified" ? r.disposition === "qualified" :
     filter === "suppressed" ? r.suppressed : true) &&
    (!q || r.full_name.toLowerCase().includes(q) || (r.normalized_value ?? "").includes(q) || (r.company ?? "").toLowerCase().includes(q)));
  const counts = {
    all: rows.length,
    qualified: rows.filter((r: any) => r.disposition === "qualified").length,
    research: rows.filter((r: any) => r.disposition === "research_queue").length,
    suppressed: rows.filter((r: any) => r.suppressed).length,
  };
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Prospects</h1>
          <p className="mt-1 text-sm text-fg-mute">Sourced, deduplicated, qualified with cited evidence.</p>
        </div>
        <LinkButton href={`/w/${slug}/prospects/import`} kind="primary">Import CSV</LinkButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {([["all", "All"], ["qualified", "Qualified"], ["research", "Research queue"], ["suppressed", "Suppressed"]] as const).map(([k, label]) => (
          <Link key={k} href={`/w/${slug}/prospects?filter=${k}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`}>
            <Pill tone={filter === k ? "amber" : "gray"}>{label} · {counts[k]}</Pill>
          </Link>
        ))}
        <form method="get" className="ml-auto flex gap-2">
          <input type="hidden" name="filter" value={filter} />
          <input name="q" className="input !w-64 !py-1.5 text-xs" placeholder="Search name, email, company" defaultValue={sp.q ?? ""} />
          <button className="btn-ghost !px-2.5 !py-1 text-xs">Search</button>
        </form>
      </div>
      <Panel>
        {shown.length === 0 ? <Empty title="Nothing here" hint="Import a CSV to add prospects." /> : (
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Company</th><th className="th">Email</th><th className="th">Contact</th><th className="th">Qualification</th><th className="th text-right">Score</th></tr></thead>
            <tbody>
              {shown.map((r: any) => (
                <tr key={r.id} className="hover:bg-ink-850/60 transition">
                  <td className="td"><Link className="font-medium hover:text-flare" href={`/w/${slug}/prospects/${r.id}`}>{r.full_name}</Link><span className="ml-2 text-xs text-fg-faint">{r.title}</span></td>
                  <td className="td text-fg-mute">{r.company}</td>
                  <td className="td font-mono text-xs text-fg-mute">{r.normalized_value}{r.suppressed && <Pill tone="red">suppressed</Pill>}</td>
                  <td className="td">{r.verification_status ? <StatePill state={r.verification_status} /> : "-"}</td>
                  <td className="td">{r.disposition ? <StatePill state={r.disposition} /> : <span className="text-xs text-fg-faint">unscored</span>}</td>
                  <td className="td text-right text-fg-mute">{r.score != null ? Number(r.score).toFixed(2) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
