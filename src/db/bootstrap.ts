// First-deployment bootstrap: idempotently creates the organization, one
// workspace, and the first admin user (org owner + workspace admin).
// Run with the migration role (same DATABASE_URL as db:migrate) - identity
// tables are RLS-free by design so this predates tenancy.
//   BOOTSTRAP_ADMIN_EMAIL=you@company.com pnpm db:bootstrap
import { Client } from "./client";

const req = (v: string | undefined, name: string) => {
  if (!v || !v.trim()) { console.error(`${name} is required`); process.exit(1); }
  return v.trim();
};

const email = req(process.env.BOOTSTRAP_ADMIN_EMAIL, "BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
const name = (process.env.BOOTSTRAP_ADMIN_NAME ?? email.split("@")[0]).trim();
const orgName = (process.env.BOOTSTRAP_ORG_NAME ?? "Default Organization").trim();
const wsName = (process.env.BOOTSTRAP_WORKSPACE_NAME ?? "Main").trim();
const wsSlug = (process.env.BOOTSTRAP_WORKSPACE_SLUG ?? "main").trim().toLowerCase();
const tz = (process.env.BOOTSTRAP_TIMEZONE ?? "UTC").trim();

const client = new Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://outreach:outreach@localhost:5433/outreach_os",
});
await client.connect();
const q = (t: string, p?: unknown[]) => client.query(t, p as never[]);
const one = async (t: string, p?: unknown[]) => (await q(t, p)).rows[0];

// organizations.name has no unique constraint - select first, insert only when missing
const org = (await one(`select id from organizations where name = $1 order by created_at limit 1`, [orgName]))
  ?? await one(`insert into organizations (name) values ($1) returning id`, [orgName]);
const user = await one(
  `insert into users (email, display_name) values ($1, $2)
   on conflict (email) do update set display_name = excluded.display_name
   returning id`, [email, name]);
const ws = (await one(`select id from workspaces where slug = $1`, [wsSlug]))
  ?? await one(
    `insert into workspaces (organization_id, name, slug, default_timezone) values ($1, $2, $3, $4)
     on conflict (slug) do nothing returning id`, [org.id, wsName, wsSlug, tz])
  ?? await one(`select id from workspaces where slug = $1`, [wsSlug]);
await q(
  `insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'org_owner')
   on conflict (organization_id, user_id) do nothing`, [org.id, user.id]);
await q(
  `insert into workspace_memberships (workspace_id, user_id, role) values ($1, $2, 'workspace_admin')
   on conflict (workspace_id, user_id, role) do nothing`, [ws.id, user.id]);

console.log(`bootstrap ok: ${name} <${email}> is org owner + admin of workspace "${wsName}" (/${wsSlug})`);
await client.end();
