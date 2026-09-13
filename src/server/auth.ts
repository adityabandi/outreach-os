import "server-only";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withSystem } from "@/db/client";
import type { Actor, WorkspaceContext, WorkspaceRole } from "@/domain/tenancy";

const SECRET = process.env.SESSION_SECRET ?? "dev-only-secret-change-me";
const COOKIE = "oos_session";

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(24).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withSystem((db) =>
    db.query("insert into sessions (user_id, token_hash, expires_at) values ($1,$2, now() + interval '30 days')", [
      userId, tokenHash,
    ]),
  );
  (await cookies()).set(COOKIE, `${token}.${sign(token)}`, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw) {
    const [token] = raw.split(".");
    await withSystem((db) =>
      db.query("delete from sessions where token_hash = $1", [
        createHash("sha256").update(token).digest("hex"),
      ]),
    );
  }
  jar.delete(COOKIE);
}

export async function currentActor(): Promise<Actor | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [token, sig] = raw.split(".");
  if (!token || !sig || sign(token) !== sig) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return withSystem(async (db) => {
    const r = await db.query(
      `select u.id, u.email, u.display_name from sessions s
         join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'`,
      [tokenHash],
    );
    if (r.rowCount === 0) return null;
    return { userId: r.rows[0].id, email: r.rows[0].email, displayName: r.rows[0].display_name };
  });
}

/** Resolve tenancy from the authenticated session + workspace slug. No client-supplied scope is trusted. */
export async function requireWorkspace(slug: string): Promise<WorkspaceContext> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const ctx = await withSystem(async (db) => {
    const r = await db.query(
      `select w.id as workspace_id, w.organization_id, w.slug,
              coalesce(array_agg(wm.role) filter (where wm.role is not null), '{}') as roles,
              exists(select 1 from organization_memberships om
                      where om.organization_id = w.organization_id and om.user_id = $2) as is_org_owner
         from workspaces w
         left join workspace_memberships wm on wm.workspace_id = w.id and wm.user_id = $2
        where w.slug = $1
        group by w.id`,
      [slug, actor.userId],
    );
    if (r.rowCount === 0) return null; // no existence leak
    const row = r.rows[0];
    if (!row.is_org_owner && row.roles.length === 0) return null; // member of org but not this workspace
    return {
      actor,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      workspaceSlug: row.slug,
      roles: row.roles as WorkspaceRole[],
      isOrgOwner: row.is_org_owner,
    } satisfies WorkspaceContext;
  });
  if (!ctx) redirect("/"); // hide existence
  return ctx;
}

export async function listAccessibleWorkspaces(actor: Actor) {
  return withSystem(async (db) => {
    const r = await db.query(
      `select distinct w.id, w.name, w.slug, w.default_timezone, w.kill_switch
         from workspaces w
         left join workspace_memberships wm on wm.workspace_id = w.id and wm.user_id = $1
         left join organization_memberships om on om.organization_id = w.organization_id and om.user_id = $1
        where wm.user_id is not null or om.user_id is not null
        order by w.name`,
      [actor.userId],
    );
    return r.rows as { id: string; name: string; slug: string; default_timezone: string; kill_switch: boolean }[];
  });
}
