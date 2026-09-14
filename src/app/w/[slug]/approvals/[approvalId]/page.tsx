import { notFound } from "next/navigation";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";
import { Panel, PanelHeader, StatePill, Pill, HashChip } from "@/ui/primitives";
import { decideApprovalAction } from "@/server/actions";
import { validateReadiness, renderTemplate } from "@/server/campaigns";
import type { CampaignPayload } from "@/domain/payload";
import { diffVersions, type DiffRecipient } from "@/domain/diff";

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
    let prev: { version: Record<string, any>; payload: CampaignPayload; recipients: DiffRecipient[] } | null = null;
    if (v.rows[0].version_number > 1) {
      const pv = await db.query(
        `select * from campaign_versions where campaign_id = $1 and version_number < $2 order by version_number desc limit 1`,
        [v.rows[0].campaign_id, v.rows[0].version_number]);
      if (pv.rows[0]) {
        const pr = await db.query(
          `select p.full_name as name, cp.normalized_value as email
             from campaign_version_recipients cvr join people p on p.id = cvr.person_id
             join contact_points cp on cp.id = cvr.contact_point_id where cvr.campaign_version_id = $1`, [pv.rows[0].id]);
        prev = { version: pv.rows[0], payload: pv.rows[0].payload_json as CampaignPayload, recipients: pr.rows as DiffRecipient[] };
      }
    }
    const senderIds = [...new Set([payload.sender_identity_id, prev?.payload.sender_identity_id].filter(Boolean))] as string[];
    const senders = await db.query(`select id, display_name, address from sender_identities where id = any($1::uuid[])`, [senderIds]);
    return { req, version: v.rows[0], payload, sender: sender.rows[0], recipients: recipients.rows, readiness, prev, senders: senders.rows };
  });
  if (!data) notFound();
  const { req, version, payload, sender, recipients, readiness, prev, senders } = data;
  const senderLabel = (id: string) => {
    const s = (senders as any[]).find((x) => x.id === id);
    return s ? `${s.display_name} <${s.address}>` : id;
  };
  const diff = prev
    ? diffVersions(
        { payload: prev.payload as any, recipients: prev.recipients },
        { payload: payload as any, recipients: (recipients as any[]).map((r) => ({ email: r.normalized_value, name: r.full_name })) },
        senderLabel)
    : null;
  const canDecide = req.status === "pending" && (ctx.isOrgOwner || ctx.roles.includes("approver")) && req.requested_by !== ctx.actor.userId;
  const samples = recipients.slice(0, 2).map((r: any) => {
    const pline = (payload.recipients ?? []).find((pr) => pr.person_id === r.person_id && pr.contact_point_id === r.contact_point_id)?.line?.trim() ?? "";
    const vars = {
      first_name: r.full_name.split(" ")[0], full_name: r.full_name,
      company: r.company ?? "", title: r.title ?? "", sender_name: sender?.display_name ?? "",
      personalization_line: pline,
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

      {diff && prev && (
        <Panel>
          <PanelHeader
            title={`Changes since v${prev.version.version_number}`}
            sub={diff.unchanged ? "Identical payload and audience - resubmitted for a fresh decision." : "Only what differs. Everything else is byte-identical to the previously reviewed version."}
            actions={<StatePill state={prev.version.status} />}
          />
          {!diff.unchanged && (
            <div className="space-y-5 px-5 py-4">
              {(diff.audienceAdded.length > 0 || diff.audienceRemoved.length > 0) && (
                <div>
                  <div className="label mb-2">Audience</div>
                  <div className="flex flex-wrap gap-2">
                    {diff.audienceAdded.map((r) => (
                      <span key={`a-${r.email}`} className="rounded-md bg-[#3ECF9A]/10 px-2.5 py-1 font-mono text-xs text-[#3ECF9A]">+ {r.name ? `${r.name} · ` : ""}{r.email}</span>
                    ))}
                    {diff.audienceRemoved.map((r) => (
                      <span key={`r-${r.email}`} className="rounded-md bg-rose/10 px-2.5 py-1 font-mono text-xs text-rose">- {r.name ? `${r.name} · ` : ""}{r.email}</span>
                    ))}
                  </div>
                </div>
              )}
              {diff.settingChanges.length > 0 && (
                <div>
                  <div className="label mb-2">Settings</div>
                  <table className="w-full">
                    <tbody>
                      {diff.settingChanges.map((c) => (
                        <tr key={c.label} className="border-b border-line-soft last:border-0">
                          <td className="py-2 pr-4 text-xs text-fg-mute">{c.label}</td>
                          <td className="py-2 pr-2 font-mono text-xs text-rose line-through decoration-rose/50">{c.from}</td>
                          <td className="py-2 font-mono text-xs text-[#3ECF9A]">{c.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {diff.stepChanges.length > 0 && (
                <div className="space-y-4">
                  <div className="label">Message copy</div>
                  {diff.stepChanges.map((sc) => (
                    <div key={sc.step} className="panel-inset p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[11px] font-medium text-fg-faint">Step {sc.step}</span>
                        {sc.kind === "added" && <Pill tone="green">new step</Pill>}
                        {sc.kind === "removed" && <Pill tone="red">removed</Pill>}
                      </div>
                      {sc.subjectFrom && (
                        <div className="mb-2 space-y-1 border-b border-line-soft pb-2">
                          <div className="font-mono text-xs text-rose line-through decoration-rose/50">{sc.subjectFrom}</div>
                          <div className="font-mono text-xs text-[#3ECF9A]">{sc.subjectTo}</div>
                        </div>
                      )}
                      {sc.bodyDiff && (
                        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                          {sc.bodyDiff.filter((l) => l.type !== "same").length > 0
                            ? sc.bodyDiff.map((l, i) => (
                                <div key={i} className={l.type === "add" ? "bg-[#3ECF9A]/10 text-[#3ECF9A]" : l.type === "del" ? "bg-rose/10 text-rose line-through decoration-rose/40" : "text-fg-faint"}>
                                  {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}{l.text || " "}
                                </div>
                              ))
                            : <span className="text-fg-faint">Body unchanged.</span>}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

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
            <thead><tr><th className="th">Name</th><th className="th">Company</th><th className="th">Email</th><th className="th">Contact</th><th className="th w-[34%]">Personalization line</th></tr></thead>
            <tbody>
              {recipients.map((r: any) => {
                const line = (payload.recipients ?? []).find((pr) => pr.person_id === r.person_id && pr.contact_point_id === r.contact_point_id)?.line;
                return (
                  <tr key={r.contact_point_id}>
                    <td className="td font-medium">{r.full_name}</td>
                    <td className="td text-fg-mute">{r.company}</td>
                    <td className="td font-mono text-xs text-fg-mute">{r.normalized_value}</td>
                    <td className="td"><StatePill state={r.verification_status} /></td>
                    <td className="td text-xs text-fg-mute">{line?.trim() ? <span>&ldquo;{line}&rdquo;</span> : <span className="text-fg-faint">-</span>}</td>
                  </tr>
                );
              })}
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
