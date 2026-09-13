import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill } from "@/ui/primitives";
import { updatePolicyAction, createOfferAction, archiveOfferAction, createIcpAction, createClaimAction, retireClaimAction } from "@/server/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const [ws, offers, icps, claims, senders, integrations, policies, members] = await Promise.all([
      db.query(`select * from workspaces where id = $1`, [ctx.workspaceId]),
      db.query(`select * from offers order by created_at`),
      db.query(`select * from ideal_customer_profiles`),
      db.query(`select ac.*, u.display_name as approver from approved_claims ac left join users u on u.id = ac.approved_by`),
      db.query(`select * from sender_identities`),
      db.query(`select provider, external_account_id, status, last_health_check_at from integrations`),
      db.query(`select * from workspace_policies order by created_at desc limit 1`),
      db.query(`select u.display_name, u.email, array_agg(wm.role order by wm.role) as roles from workspace_memberships wm join users u on u.id = wm.user_id group by u.id, u.display_name, u.email order by u.display_name`),
    ]);
    return { ws: ws.rows[0], offers: offers.rows, icps: icps.rows, claims: claims.rows, senders: senders.rows, integrations: integrations.rows, policy: policies.rows[0], members: members.rows };
  });
  const canOperateWs = ctx.isOrgOwner || ctx.roles.includes("campaign_operator") || ctx.roles.includes("workspace_admin");
  const canApproveWs = ctx.isOrgOwner || ctx.roles.includes("approver");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Workspace setup</h1>
        <p className="mt-1 text-sm text-fg-mute">{data.ws.name} · {data.ws.domain} · {data.ws.default_timezone}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Offers" />
          <ul className="divide-y divide-line-soft">
            {data.offers.filter((o: any) => o.status === "active").map((o: any) => (
              <li key={o.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{o.name}</div>
                  {canOperateWs && <form action={archiveOfferAction.bind(null, slug, o.id)}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Archive</button></form>}
                </div>
                <div className="text-xs text-fg-mute">{o.description}</div>
                <div className="mt-1 text-xs text-fg-soft">{o.pricing_text} · <span className="text-flare">{o.call_to_action}</span></div>
              </li>
            ))}
          </ul>
          {canOperateWs && (
            <form action={createOfferAction.bind(null, slug)} className="space-y-2 border-t border-line-soft px-5 py-4">
              <div className="label">New offer</div>
              <input name="name" className="input !py-1.5 text-xs" placeholder="Name" required />
              <input name="description" className="input !py-1.5 text-xs" placeholder="Description" />
              <div className="grid grid-cols-2 gap-2">
                <input name="pricing_text" className="input !py-1.5 text-xs" placeholder="Pricing text" />
                <input name="call_to_action" className="input !py-1.5 text-xs" placeholder="Call to action" />
              </div>
              <button className="btn-ghost !px-2.5 !py-1 text-xs">Add offer</button>
            </form>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Ideal customer profiles" />
          <ul className="divide-y divide-line-soft">
            {data.icps.map((i: any) => (
              <li key={i.id} className="px-5 py-3">
                <div className="text-sm font-medium">{i.name}</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-fg-mute">{JSON.stringify(i.criteria_json)}</pre>
                <div className="mt-1 text-[11px] text-fg-faint">territories {(i.territories ?? []).join(", ")} · languages {(i.languages ?? []).join(", ")}</div>
              </li>
            ))}
          </ul>
          {canOperateWs && (
            <form action={createIcpAction.bind(null, slug)} className="space-y-2 border-t border-line-soft px-5 py-4">
              <div className="label">New ICP</div>
              <input name="name" className="input !py-1.5 text-xs" placeholder="Name" required />
              <input name="criteria_json" className="input !py-1.5 font-mono !text-[11px]" placeholder='Criteria JSON, e.g. {"topics":["ayurveda"]}' />
              <div className="grid grid-cols-2 gap-2">
                <input name="territories" className="input !py-1.5 text-xs" placeholder="Territories (US, UK, IN)" />
                <input name="languages" className="input !py-1.5 text-xs" placeholder="Languages (en, es)" />
              </div>
              <button className="btn-ghost !px-2.5 !py-1 text-xs">Add ICP</button>
            </form>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Approved claims" sub="Copy may only use claims from this list." />
          <ul className="divide-y divide-line-soft">
            {data.claims.map((c: any) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{c.claim_text}</span>
                  <span className="flex items-center gap-2">
                    <Pill tone={c.status === "active" ? "green" : "gray"}>{c.status}</Pill>
                    {canApproveWs && c.status === "active" && (
                      <form action={retireClaimAction.bind(null, slug, c.id)}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Retire</button></form>
                    )}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-fg-faint">{c.evidence_url}{c.approver ? ` · approved by ${c.approver}` : ""}</div>
              </li>
            ))}
          </ul>
          {canApproveWs && (
            <form action={createClaimAction.bind(null, slug)} className="space-y-2 border-t border-line-soft px-5 py-4">
              <div className="label">New claim - recorded as approved by you</div>
              <input name="claim_text" className="input !py-1.5 text-xs" placeholder="Claim text" required />
              <input name="evidence_url" className="input !py-1.5 font-mono !text-[11px]" placeholder="Evidence URL" />
              <input name="evidence_note" className="input !py-1.5 text-xs" placeholder="Evidence note" />
              <button className="btn-ghost !px-2.5 !py-1 text-xs">Add claim</button>
            </form>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Senders & integrations" />
          <ul className="divide-y divide-line-soft">
            {data.senders.map((s: any) => (
              <li key={s.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{s.display_name}</div>
                  <div className="font-mono text-xs text-fg-mute">{s.address} · cap {s.daily_cap}/day</div>
                </div>
                <StatePill state={s.verification_status} />
              </li>
            ))}
            {data.integrations.map((i: any, k: number) => (
              <li key={k} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{i.provider}</div>
                  <div className="text-xs text-fg-mute">{i.external_account_id} · checked {i.last_health_check_at ? new Date(i.last_health_check_at).toLocaleString("en-GB") : "never"}</div>
                </div>
                <StatePill state={i.status} />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel>
          <PanelHeader title="Policy" sub={`Version ${data.policy?.version ?? 1} - every save versions forward and audits the delta.`} />
          {(ctx.isOrgOwner || ctx.roles.includes("workspace_admin")) ? (
            <form action={updatePolicyAction.bind(null, slug)} className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="label">Daily workspace cap</label><input name="daily_send_cap" type="number" min={1} max={10000} className="input" defaultValue={data.policy?.daily_send_cap ?? 50} required /></div>
                <div><label className="label">Per-domain cap</label><input name="per_domain_cap" type="number" min={1} max={1000} className="input" defaultValue={data.policy?.per_domain_cap ?? 5} required /></div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-fg-mute">Channels: {(data.policy?.allowed_channels ?? []).join(", ")} · reply auto-send: <span className="text-mint">off - locked in v1</span></div>
                <button className="btn-primary">Save as v{(data.policy?.version ?? 1) + 1}</button>
              </div>
            </form>
          ) : (
            <div className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
              <div><div className="label">Daily workspace cap</div>{data.policy?.daily_send_cap}</div>
              <div><div className="label">Per-domain cap</div>{data.policy?.per_domain_cap}</div>
              <div><div className="label">Channels</div>{(data.policy?.allowed_channels ?? []).join(", ")}</div>
              <div><div className="label">Reply auto-send</div><Pill tone="green">off - review required</Pill></div>
            </div>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Members" />
          <ul className="divide-y divide-line-soft">
            {data.members.map((m: any, k: number) => (
              <li key={k} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span>{m.display_name} <span className="text-fg-faint text-xs">{m.email}</span></span>
                <span className="flex gap-1.5">
                  {(m.roles as string[]).map((r) => (
                    <Pill key={r} tone={r === "approver" ? "amber" : r === "workspace_admin" ? "purple" : "gray"}>{r.replace(/_/g, " ")}</Pill>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
