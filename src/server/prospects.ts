import "server-only";
import { createHash } from "node:crypto";
import { withTenant } from "@/db/client";
import { audit } from "@/domain/audit";
import { canOperate, type WorkspaceContext } from "@/domain/tenancy";
import { matchesSuppression, normalizeEmail } from "@/domain/compliance";

export type ImportOutcome = "imported" | "merged" | "skipped" | "suppressed";
export interface ImportRowReport { email: string; name: string; outcome: ImportOutcome; reason?: string }
export interface ImportReport { listId: string; imported: number; merged: number; skipped: number; suppressed: number; rows: ImportRowReport[] }

/** CSV import: header row required: full_name,email,title,company,domain,country.
 *  Existing people are merged (missing fields filled, added to the list), never duplicated;
 *  every row's outcome is reported and stored on the list. */
export async function importProspectsCsv(ctx: WorkspaceContext, listName: string, csv: string): Promise<ImportReport> {
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
    const suppr = await db.query(
      `select scope, normalized_value, expires_at from suppression_entries where expires_at is null or expires_at > now()`);
    const suppressions = suppr.rows as { scope: string; normalized_value: string; expires_at: string | null }[];
    const rows: ImportRowReport[] = [];
    let imported = 0, merged = 0, skipped = 0, suppressed = 0;
    const seenEmails = new Set<string>();
    for (const line of lines.slice(1)) {
      const cells = line.split(",").map((c) => c.trim());
      const email = normalizeEmail(cells[col("email")] ?? "");
      const name = cells[col("full_name")] ?? "";
      const fail = (reason: string) => { skipped++; rows.push({ email, name, outcome: "skipped", reason }); };
      if (!email || !email.includes("@")) { fail("invalid email"); continue; }
      if (!name) { fail("missing name"); continue; }
      if (seenEmails.has(email)) { fail("duplicate in file"); continue; }
      seenEmails.add(email);
      if (matchesSuppression(suppressions, email).suppressed) {
        suppressed++; rows.push({ email, name, outcome: "suppressed", reason: "on suppression list" }); continue;
      }
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
      let personId: string;
      let outcome: ImportOutcome = "imported";
      if (p.rowCount === 0) {
        // existing person: merge - fill only empty fields, never overwrite
        const ex = await db.query(
          `update people set company_id = coalesce(company_id, $3), title = coalesce(title, $4)
            where workspace_id = $1 and normalized_email = $2 returning id`,
          [ctx.workspaceId, email, companyId, cells[col("title")] || null]);
        personId = ex.rows[0].id as string;
        outcome = "merged";
      } else {
        personId = p.rows[0].id as string;
      }
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
      if (outcome === "imported") imported++; else merged++;
      rows.push({ email, name, outcome });
    }
    const report: ImportReport = { listId, imported, merged, skipped, suppressed, rows };
    await db.query(`update prospect_lists set import_report_json = $2 where id = $1`, [listId, JSON.stringify(report)]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "prospects.import_csv", targetType: "prospect_list", targetId: listId,
      metadata: { list: listName, imported, merged, skipped, suppressed },
    });
    return report;
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

export async function addSuppression(ctx: WorkspaceContext, value: string, scope: string, reason: string, expiresAt?: string | null) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    await db.query(
      `insert into suppression_entries (organization_id, workspace_id, scope, normalized_value, reason, source, expires_at)
       values ($1,$2,$3,$4,$5,'manual',$6) on conflict do nothing`,
      [ctx.organizationId, ctx.workspaceId, scope, value.trim().toLowerCase(), reason, expiresAt || null]);
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "suppression.add", targetType: "suppression_entry",
      metadata: { scope, value: value.trim().toLowerCase(), reason, expires_at: expiresAt || null },
    });
    return { ok: true };
  });
}

/** Lift a suppression by expiring it now. The entry stays for the audit trail. */
export async function liftSuppression(ctx: WorkspaceContext, entryId: string) {
  canOperate(ctx);
  return withTenant(ctx.workspaceId, async (db) => {
    const r = await db.query(
      `update suppression_entries set expires_at = now()
        where id = $1 and workspace_id = $2 and (expires_at is null or expires_at > now())
        returning normalized_value`, [entryId, ctx.workspaceId]);
    if (r.rowCount === 0) return { ok: false };
    await audit(db, {
      organizationId: ctx.organizationId, workspaceId: ctx.workspaceId,
      actorType: "user", actorId: ctx.actor.userId,
      action: "suppression.lift", targetType: "suppression_entry", targetId: entryId,
      metadata: { value: r.rows[0].normalized_value },
    });
    return { ok: true };
  });
}
