import { NextResponse } from "next/server";
import { requireWorkspace } from "@/server/auth";
import { withTenant } from "@/db/client";

/** CSV export of the dev outbox. Tenant-scoped; same auth as the outbox screen. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireWorkspace(slug);
  const rows = await withTenant(ctx.workspaceId, async (db) =>
    (await db.query(`select from_address, to_address, subject, body, provider_message_id, thread_ref, created_at from outbox_messages order by created_at desc`)).rows);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "from,to,subject,body,provider_message_id,thread_ref,created_at";
  const csv = [header, ...rows.map((m: any) =>
    [m.from_address, m.to_address, m.subject, m.body, m.provider_message_id, m.thread_ref, new Date(m.created_at).toISOString()].map(esc).join(",")),
  ].join("\n");
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="outbox-${slug}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
