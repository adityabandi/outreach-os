import pg from "pg";

const { Pool, Client } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://outreach:outreach@localhost:5433/outreach_os";

let pool: pg.Pool | null = null;
export function getPool(): pg.Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  return pool;
}

export type Db = pg.PoolClient;

/**
 * Run `fn` inside a transaction with the tenant GUC set, so RLS policies
 * (current_ws()) scope every statement to the workspace. Tenant comes from
 * the authenticated server context, never from client input alone.
 */
export async function withTenant<T>(workspaceId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Tenant-free access, only for identity/login/lookup paths that predate tenancy resolution. */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export { Client };
