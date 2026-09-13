import { requireWorkspace } from "@/server/auth";
import { createCampaignAction } from "@/server/actions";
import { Panel, PanelHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function NewCampaign({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireWorkspace(slug);
  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New campaign</h1>
        <p className="mt-1 text-sm text-fg-mute">A campaign starts as a draft. Nothing sends until an approver locks a version.</p>
      </div>
      <Panel>
        <PanelHeader title="Basics" />
        <form action={createCampaignAction.bind(null, slug)} className="space-y-4 px-5 py-4">
          <div>
            <label className="label">Campaign name</label>
            <input name="name" className="input" placeholder="Creator Wave 3" required />
          </div>
          <button className="btn-primary">Create draft</button>
        </form>
      </Panel>
    </div>
  );
}
