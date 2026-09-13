import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill } from "@/ui/primitives";

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
      db.query(`select wm.role, u.display_name, u.email from workspace_memberships wm join users u on u.id = wm.user_id order by u.display_name`),
    ]);
    return { ws: ws.rows[0], offers: offers.rows, icps: icps.rows, claims: claims.rows, senders: senders.rows, integrations: integrations.rows, policy: policies.rows[0], members: members.rows };
  });
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
            {data.offers.map((o: any) => (
              <li key={o.id} className="px-5 py-3">
                <div className="text-sm font-medium">{o.name}</div>
                <div className="text-xs text-fg-mute">{o.description}</div>
                <div className="mt-1 text-xs text-fg-soft">{o.pricing_text} · <span className="text-flare">{o.call_to_action}</span></div>
              </li>
            ))}
          </ul>
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
        </Panel>
        <Panel>
          <PanelHeader title="Approved claims" sub="Copy may only use claims from this list." />
          <ul className="divide-y divide-line-soft">
            {data.claims.map((c: any) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{c.claim_text}</span>
                  <Pill tone={c.status === "active" ? "green" : "gray"}>{c.status}</Pill>
                </div>
                <div className="mt-1 font-mono text-[11px] text-fg-faint">{c.evidence_url}{c.approver ? ` · approved by ${c.approver}` : ""}</div>
              </li>
            ))}
          </ul>
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
          <PanelHeader title="Policy" />
          <div className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
            <div><div className="label">Daily workspace cap</div>{data.policy?.daily_send_cap}</div>
            <div><div className="label">Per-domain cap</div>{data.policy?.per_domain_cap}</div>
            <div><div className="label">Channels</div>{(data.policy?.allowed_channels ?? []).join(", ")}</div>
            <div><div className="label">Reply auto-send</div><Pill tone="green">off - review required</Pill></div>
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="Members" />
          <ul className="divide-y divide-line-soft">
            {data.members.map((m: any, k: number) => (
              <li key={k} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span>{m.display_name} <span className="text-fg-faint text-xs">{m.email}</span></span>
                <Pill tone={m.role === "approver" ? "amber" : m.role === "workspace_admin" ? "purple" : "gray"}>{m.role.replace(/_/g, " ")}</Pill>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
