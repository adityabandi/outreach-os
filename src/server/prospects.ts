import "server-only";
import { createHash } from "node:crypto";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canOperate, type WorkspaceContext } from "@/domain/tenancy";
import { normalizeEmail } from "@/domain/compliance";

/** CSV import: header row required: full_name,email,title,company,domain,country */
export async function importProspectsCsv(ctx: WorkspaceContext, listName: string, csv: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const list = await db.query(
      `insert into prospect_lists (organization_id, workspace_id, name, source_type, created_by)
       values ($1,$2,$3,'csv',$4) returning id`,
      [ctx.organizationId, ctx.workspaceId, listName, ctx.actor.userId]);
    const listId = list.rows[0].id as string;
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    let imported = 0, skipped = 0;
    const seenEmails = new Set<string>();
    for (const line of lines.slice(1)) {
      const cells = line.split(",").map((c) => c.trim());
      const email = normalizeEmail(cells[col("email")] ?? "");
      const name = cells[col("full_name")] ?? "";
      if (!email || !email.includes("@") || !name || seenEmails.has(email)) { skipped++; continue; }
      seenEmails.add(email);
      const domain = cells[col("domain")] || email.split("@")[1];
      const companyName = cells[col("company")] ?? "";
      let companyId: string | null = null;
      if (companyName) {
        const c = await db.query(
          `insert into companies (organization_id, workspace_id, name, normalized_domain, country)
           values ($1,$2,$3,$4,$5)
           on conflict (workspace_id, normalized_domain) do update set name = excluded.name
           returning id`,
          [ctx.organizationId, ctx.workspaceId, companyName, domain, cells[col("country")] || null]);
        companyId = c.rows[0].id;
      }
      const p = await db.query(
        `insert into people (organization_id, workspace_id, company_id, full_name, title, location, normalized_email)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (workspace_id, normalized_email) do nothing returning id`,
        [ctx.organizationId, ctx.workspaceId, companyId, name, cells[col("title")] || null, null, email]);
      if (p.rowCount === 0) { skipped++; continue; }
      const personId = p.rows[0].id as string;
      await db.query(
        `insert into contact_points (organization_id, workspace_id, person_id, type, normalized_value, verification_status)
         values ($1,$2,$3,'email',$4,'unverified') on conflict do nothing`,
        [ctx.organizationId, ctx.workspaceId, personId, email]);
      const hash = createHash("sha256").update(line).digest("hex");
      const ev = await db.query(
        `insert into evidence_items (organization_id, workspace_id, subject_type, subject_id, source_type, excerpt, content_hash)
         values ($1,$2,'person',$3,'csv',$4,$5) returning id`,
        [ctx.organizationId, ctx.workspaceId, personId, `Imported row: ${name} <${email}>${companyName ? `, ${companyName}` : ""}`, hash]);
      await db.query(
        `update contact_points set evidence_id = $2 where person_id = $1 and normalized_value = $3 and evidence_id is null`,
        [personId, ev.rows[0].id, email]);
      await db.query(
        `insert into prospect_list_members (prospect_list_id, person_id) values ($1,$2) on conflict do nothing`,
        [listId, personId]);
      imported++;
    }
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "prospects.import_csv", targetType: "prospect_list", targetId: listId,
      metadata: { list: listName, imported, skipped },
    });
    return { listId, imported, skipped };
  });
}

export async function setContactVerification(
  ctx: WorkspaceContext, contactPointId: string, status: "verified" | "risky" | "invalid",
) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update contact_points set verification_status = $2, verification_provider = 'manual', verified_at = now()
        where id = $1 returning person_id, normalized_value`, [contactPointId, status]);
    if (r.rowCount === 0) throw new Error("contact point not found");
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "contact.verify", targetType: "contact_point", targetId: contactPointId,
      metadata: { status, value: r.rows[0].normalized_value },
    });
    return { ok: true };
  });
}

export async function addSuppression(ctx: WorkspaceContext, value: string, scope: string, reason: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    await db.query(
      `insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source)
       values ($1,$2,$3,$4,$5,'manual') on conflict do nothing`,
      [ctx.organizationId, ctx.workspaceId, scope, value.trim().toLowerCase(), reason]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "suppression.add", targetType: "suppression_entry",
      metadata: { scope, value: value.trim().toLowerCase(), reason },
    });
    return { ok: true };
  });
}
