import { requireWorkspace } from "@/server/auth";
import { importCsvAction } from "@/server/actions";
import { Panel, PanelHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireWorkspace(slug);
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Import prospects</h1>
        <p className="mt-1 text-sm text-fg-mute">CSV with header: full_name,email,title,company,domain,country. Rows are normalized, deduplicated by email, and stored with source evidence.</p>
      </div>
      <Panel>
        <PanelHeader title="CSV import" />
        <form action={importCsvAction.bind(null, slug)} className="space-y-4 px-5 py-4">
          <div><label className="label">List name</label><input name="list_name" className="input" placeholder="Creators - September" /></div>
          <div><label className="label">CSV content</label><textarea name="csv" rows={10} className="input font-mono !text-xs" placeholder={"full_name,email,title,company,domain,country\nSam Example,sam@example.com,Creator,Example Co,example.com,US"} required /></div>
          <button className="btn-primary">Import</button>
        </form>
      </Panel>
    </div>
  );
}
