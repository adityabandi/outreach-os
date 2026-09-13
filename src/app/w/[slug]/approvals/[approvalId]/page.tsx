import { notFound } from "next/navigation";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill, HashChip } from "@/ui/primitives";
import { decideApprovalAction } from "@/server/actions";
import { validateReadiness, renderTemplate } from "@/server/campaigns";
import type { CampaignPayload } from "@/domain/payload";

export const dynamic = "force-dynamic";

export default async function ApprovalReview({ params }: { params: Promise<{ slug: string; approvalId: string }> }) {
  const { slug, approvalId } = await params;
  const ctx = await requireWorkspace(slug);
  const data = await withTenant(ctx.workspaceId, async (db) => {
    const ar = await db.query(
      `select ar.*, u.display_name as requester, u.email as requester_email
         from approval_requests ar left join users u on u.id = ar.requested_by where ar.id = $1`, [approvalId]);
    if (ar.rowCount === 0) return null;
    const req = ar.rows[0];
    const v = await db.query(
      `select cv.*, c.name as campaign_name from campaign_versions cv join campaigns c on c.id = cv.campaign_id where cv.id = $1`,
      [req.resource_id]);
    const payload = v.rows[0].payload_json as CampaignPayload;
    const sender = await db.query(`select * from sender_identities where id = $1`, [payload.sender_identity_id]);
    const recipients = await db.query(
      `select p.full_name, p.title, co.name as company, cp.normalized_value, cp.verification_status, cvr.person_id, cvr.contact_point_id
         from campaign_version_recipients cvr
         join people p on p.id = cvr.person_id
         join contact_points cp on cp.id = cvr.contact_point_id
         left join companies co on co.id = p.company_id
        where cvr.campaign_version_id = $1 order by p.full_name`, [req.resource_id]);
    const readiness = await validateReadiness(db, ctx, req.resource_id);
    return { req, version: v.rows[0], payload, sender: sender.rows[0], recipients: recipients.rows, readiness };
  });
  if (!data) notFound();
  const { req, version, payload, sender, recipients, readiness } = data;
  const canDecide = req.status === "pending" && (ctx.isOrgOwner || ctx.roles.includes("approver")) && req.requested_by !== ctx.actor.userId;
  const samples = recipients.slice(0, 2).map((r: any) => {
    const vars = {
      first_name: r.full_name.split(" ")[0], full_name: r.full_name,
      company: r.company ?? "", title: r.title ?? "", sender_name: sender?.display_name ?? "",
    };
    return {
      name: r.full_name,
      steps: payload.sequence.map((s) => ({
        step: s.step_number,
        subject: renderTemplate(s.subject_template, vars, payload.personalization_rules.allowed_variables),
        body: renderTemplate(s.body_template, vars, payload.personalization_rules.allowed_variables),
      })),
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Approval review</h1>
          <StatePill state={req.status === "pending" ? "approval_pending" : req.status} />
        </div>
        <p className="mt-1 text-sm text-fg-mute">
          {version.campaign_name} · v{version.version_number} · requested by {req.requester} ·{" "}
          {new Date(req.requested_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>

      <div className="panel border-flare/30 bg-flare/[0.03] px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <div className="label">You are approving</div>
            <div className="text-sm font-medium">This exact payload, hash-locked</div>
          </div>
          <div>
            <div className="label">Payload hash</div>
            <HashChip hash={req.payload_hash} />
          </div>
          <div>
            <div className="label">Effect of approval</div>
            <div className="text-xs text-fg-mute max-w-md">Launch becomes possible. Any later edit changes the hash and silently launching under this approval becomes impossible.</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Sender & channel" />
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{sender?.display_name}</div>
                <div className="font-mono text-xs text-fg-mute">{sender?.address}</div>
              </div>
              <StatePill state={sender?.verification_status ?? "unverified"} />
            </div>
            <div className="grid grid-cols-3 gap-3 border-t border-line-soft pt-3 text-center">
              <div><div className="label">Workspace cap</div><div className="text-lg font-semibold">{payload.delivery.daily_workspace_cap}<span className="text-xs text-fg-faint">/day</span></div></div>
              <div><div className="label">Sender cap</div><div className="text-lg font-semibold">{payload.delivery.sender_daily_cap}<span className="text-xs text-fg-faint">/day</span></div></div>
              <div><div className="label">Per domain</div><div className="text-lg font-semibold">{payload.delivery.per_domain_cap}</div></div>
            </div>
            <div className="border-t border-line-soft pt-3 text-xs text-fg-mute">
              Sends only {payload.delivery.send_window.start_hour}:00-{payload.delivery.send_window.end_hour}:00 {payload.delivery.timezone} ·
              follow-ups {payload.follow_up.enabled ? "on" : "off"} · replies never auto-send · suppression re-checked before every send
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title={`Audience manifest (${recipients.length})`} sub="The exact people this approval covers. No one else." />
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Company</th><th className="th">Email</th><th className="th">Contact</th></tr></thead>
            <tbody>
              {recipients.map((r: any) => (
                <tr key={r.contact_point_id}>
                  <td className="td font-medium">{r.full_name}</td>
                  <td className="td text-fg-mute">{r.company}</td>
                  <td className="td font-mono text-xs text-fg-mute">{r.normalized_value}</td>
                  <td className="td"><StatePill state={r.verification_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Exact message copy" sub="Rendered with real recipient data. Placeholders cannot inject anything outside the allowed variable set." />
        <div className="grid grid-cols-1 gap-4 px-5 py-4 lg:grid-cols-2">
          {samples.map((s: any) => (
            <div key={s.name} className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Preview for {s.name}</div>
              {s.steps.map((st: any) => (
                <div key={st.step} className="panel-inset p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-fg-faint">Step {st.step}</span>
                  </div>
                  <div className="border-b border-line-soft pb-2 text-sm font-medium">{st.subject}</div>
                  <pre className="whitespace-pre-wrap pt-2 font-sans text-[13px] leading-relaxed text-fg-soft">{st.body}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Panel>

      {readiness.issues.length > 0 && (
        <Panel>
          <PanelHeader title="Warnings" />
          <ul className="space-y-2 px-5 py-4">
            {readiness.issues.map((i, k) => (
              <li key={k} className={`flex gap-2 text-sm ${i.level === "error" ? "text-rose" : "text-flare"}`}>
                <span>{i.level === "error" ? "✕" : "⚠"}</span><span>{i.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {req.status === "pending" ? (
        canDecide ? (
          <Panel>
            <PanelHeader title="Decision" sub="Recorded with your identity, timestamp and the payload hash in the audit log." />
            <form action={decideApprovalAction.bind(null, slug, approvalId)} className="space-y-4 px-5 py-4">
              <textarea name="note" rows={2} className="input" placeholder="Decision note (optional, kept in the audit trail)…" />
              <div className="flex gap-3">
                <button name="decision" value="approved" className="btn-primary">Approve this version</button>
                <button name="decision" value="rejected" className="btn-danger">Reject</button>
              </div>
            </form>
          </Panel>
        ) : (
          <Panel>
            <div className="px-5 py-4 text-sm text-fg-mute">
              {req.requested_by === ctx.actor.userId
                ? "You requested this approval, so you cannot decide it. Separation of duties: another approver must review."
                : "You do not hold the approver role in this workspace."}
            </div>
          </Panel>
        )
      ) : (
        <Panel>
          <div className="px-5 py-4 text-sm">
            <StatePill state={req.status} />
            <span className="ml-3 text-fg-mute">{req.decision_note}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}
