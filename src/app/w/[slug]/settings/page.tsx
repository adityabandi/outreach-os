import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill } from "@/ui/primitives";
import {
  updatePolicyAction, createOfferAction, archiveOfferAction, createIcpAction, createClaimAction, retireClaimAction,
  createSenderAction, requestSenderVerificationAction, confirmSenderVerificationAction, setSenderStatusAction,
} from "@/server/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params, searchParams,
}: { params: Promise<{ slug: string }>; searchParams: Promise<{ sender_error?: string }> }) {
  const { slug } = await params;
  const { sender_error } = await searchParams;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    // sequential: one tenant transaction = one pg client, which serializes anyway
    const ws = await db.query(`select * from workspaces where id = $1`, [ctx.workspaceId]);
    const offers = await db.query(`select * from offers order by created_at`);
    const icps = await db.query(`select * from ideal_customer_profiles`);
    const claims = await db.query(`select ac.*, u.display_name as approver from approved_claims ac left join users u on u.id = ac.approved_by`);
    const senders = await db.query(`select * from sender_identities order by address`);
    const integrations = await db.query(`select provider, external_account_id, encrypted_secret_ref, status, last_health_check_at from integrations`);
    const policies = await db.query(`select * from workspace_policies order by created_at desc limit 1`);
    const members = await db.query(`select u.display_name, u.email, array_agg(wm.role order by wm.role) as roles from workspace_memberships wm join users u on u.id = wm.user_id group by u.id, u.display_name, u.email order by u.display_name`);
    return { ws: ws.rows[0], offers: offers.rows, icps: icps.rows, claims: claims.rows, senders: senders.rows, integrations: integrations.rows, policy: policies.rows[0], members: members.rows };
  });
  const canOperateWs = ctx.isOrgOwner || ctx.roles.includes("campaign_operator") || ctx.roles.includes("workspace_admin");
  const canApproveWs = ctx.isOrgOwner || ctx.roles.includes("approver");
  const canAdminWs = ctx.isOrgOwner || ctx.roles.includes("workspace_admin");
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
          <PanelHeader title="Senders & integrations" sub="Campaigns only send from verified, active senders - re-checked before every send." />
          {sender_error === "mismatch" && (
            <p className="border-b border-line-soft px-5 py-2.5 text-xs text-rose">That code does not match - check the latest verification email and try again.</p>
          )}
          {sender_error === "expired" && (
            <p className="border-b border-line-soft px-5 py-2.5 text-xs text-rose">The verification code expired - send a new one and try again.</p>
          )}
          <ul className="divide-y divide-line-soft">
            {data.senders.map((s: any) => (
              <li key={s.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {s.display_name}
                      {s.status !== "active" && <Pill tone="red">disabled</Pill>}
                    </div>
                    <div className="font-mono text-xs text-fg-mute">{s.address} · cap {s.daily_cap}/day</div>
                    <div className="mt-0.5 text-[11px] text-fg-faint">
                      {s.verification_status === "verified" && s.verified_at && `verified ${new Date(s.verified_at).toLocaleDateString("en-GB")}`}
                      {s.verification_status === "pending" && s.verification_expires_at && `code sent ${new Date(s.verification_sent_at).toLocaleString("en-GB")} · expires ${new Date(s.verification_expires_at).toLocaleString("en-GB")}`}
                      {s.verification_status === "failed" && "last verification failed - request a new code"}
                      {s.verification_status === "unverified" && "never verified"}
                    </div>
                  </div>
                  <span className="flex items-center gap-2">
                    <StatePill state={s.verification_status} />
                    {canAdminWs && s.status === "active" && (s.verification_status === "unverified" || s.verification_status === "failed") && (
                      <form action={requestSenderVerificationAction.bind(null, slug, s.id)}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Send code</button></form>
                    )}
                    {canAdminWs && s.status === "active" && s.verification_status === "verified" && (
                      <form action={setSenderStatusAction.bind(null, slug, s.id, "disabled")}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Disable</button></form>
                    )}
                    {canAdminWs && s.status !== "active" && (
                      <form action={setSenderStatusAction.bind(null, slug, s.id, "active")}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Enable</button></form>
                    )}
                  </span>
                </div>
                {canAdminWs && s.status === "active" && s.verification_status === "pending" && (
                  <div className="mt-2 flex items-center gap-2">
                    <form action={confirmSenderVerificationAction.bind(null, slug, s.id)} className="flex items-center gap-2">
                      <input name="code" className="input !w-32 !py-1 text-center font-mono text-xs tracking-[0.3em]" placeholder="000000" maxLength={6} pattern="[0-9]{6}" required />
                      <button className="btn-primary !px-2.5 !py-1 text-xs">Confirm</button>
                    </form>
                    <form action={requestSenderVerificationAction.bind(null, slug, s.id)}><button className="btn-ghost !px-2 !py-0.5 text-[11px]">Resend</button></form>
                  </div>
                )}
              </li>
            ))}
            {data.integrations.map((i: any, k: number) => (
              <li key={k} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{i.provider}</div>
                  <div className="text-xs text-fg-mute">
                    {i.external_account_id} · checked {i.last_health_check_at ? new Date(i.last_health_check_at).toLocaleString("en-GB") : "never"}
                    {i.provider === "gmail" && i.status !== "healthy" && i.encrypted_secret_ref && (
                      <span className="text-fg-faint"> · staged - goes live when env {i.encrypted_secret_ref} (+ GMAIL_CLIENT_ID/SECRET) is set and the row is marked healthy</span>
                    )}
                  </div>
                </div>
                <StatePill state={i.status} />
              </li>
            ))}
          </ul>
          {canAdminWs && (
            <form action={createSenderAction.bind(null, slug)} className="space-y-2 border-t border-line-soft px-5 py-4">
              <div className="label">New sender - verified by emailed code before it can send</div>
              <div className="grid grid-cols-2 gap-2">
                <input name="display_name" className="input !py-1.5 text-xs" placeholder="Display name" required />
                <input name="address" type="email" className="input !py-1.5 font-mono !text-[11px]" placeholder="address@domain.org" required />
              </div>
              <div className="flex items-center justify-between">
                <input name="daily_cap" type="number" min={1} max={10000} defaultValue={25} className="input !w-28 !py-1.5 text-xs" required />
                <button className="btn-ghost !px-2.5 !py-1 text-xs">Add sender</button>
              </div>
            </form>
          )}
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
