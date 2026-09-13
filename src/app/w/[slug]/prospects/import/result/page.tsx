import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, Pill, LinkButton } from "@/ui/primitives";
import type { ImportReport, ImportOutcome } from "@/server/prospects";

export const dynamic = "force-dynamic";

const OUTCOME_UI: Record<ImportOutcome, { tone: "green" | "blue" | "gray" | "red"; label: string }> = {
  imported: { tone: "green", label: "imported" },
  merged: { tone: "blue", label: "merged" },
  skipped: { tone: "gray", label: "skipped" },
  suppressed: { tone: "red", label: "suppressed" },
};

export default async function ImportResult({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ list?: string }> }) {
  const { slug } = await params;
  const { list } = await searchParams;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(`select name, import_report_json, created_at from prospect_lists where id = $1`, [list ?? ""]);
    return r.rows[0] ?? null;
  });
  if (!data?.import_report_json) notFound();
  const report = data.import_report_json as ImportReport;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Import report</h1>
          <p className="mt-1 text-sm text-fg-mute">{data.name} · every row accounted for. Existing people are merged, never duplicated.</p>
        </div>
        <div className="flex gap-2">
          <LinkButton href={`/w/${slug}/prospects/import`}>Import another</LinkButton>
          <LinkButton href={`/w/${slug}/prospects`} kind="primary">View prospects</LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel className="px-5 py-4"><div className="label">Imported</div><div className="mt-1 text-2xl font-semibold text-mint">{report.imported}</div></Panel>
        <Panel className="px-5 py-4"><div className="label">Merged</div><div className="mt-1 text-2xl font-semibold text-sky">{report.merged}</div><div className="mt-0.5 text-[11px] text-fg-faint">already existed; empty fields filled</div></Panel>
        <Panel className="px-5 py-4"><div className="label">Suppressed</div><div className="mt-1 text-2xl font-semibold text-rose">{report.suppressed}</div><div className="mt-0.5 text-[11px] text-fg-faint">on suppression list - not imported</div></Panel>
        <Panel className="px-5 py-4"><div className="label">Skipped</div><div className="mt-1 text-2xl font-semibold text-fg-mute">{report.skipped}</div></Panel>
      </div>

      <Panel>
        <PanelHeader title={`Row outcomes (${report.rows.length})`} />
        <table className="w-full">
          <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Outcome</th><th className="th">Reason</th></tr></thead>
          <tbody>
            {report.rows.map((r, i) => (
              <tr key={i}>
                <td className="td font-medium">{r.name || "-"}</td>
                <td className="td font-mono text-xs text-fg-mute">{r.email || "-"}</td>
                <td className="td"><Pill tone={OUTCOME_UI[r.outcome].tone}>{OUTCOME_UI[r.outcome].label}</Pill></td>
                <td className="td text-xs text-fg-faint">{r.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
