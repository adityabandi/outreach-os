// Durable queue worker: polls job_runs with SKIP LOCKED and processes due
// deliveries for every workspace with an active run.
import { getPool, withSystem } from "@/db/client";
import { processDueDeliveries } from "@/server/delivery";

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 3000);

async function tick() {
  // 1. claim queued jobs
  await withSystem(async (db) => {
    const jobs = await db.query(
      `update job_runs set status = 'running', started_at = now(), attempts = attempts + 1
        where id in (select id from job_runs where status = 'queued' and scheduled_at <= now()
                     order by scheduled_at limit 5 for update skip locked)
        returning id, job_type, payload_json, workspace_id, attempts`);
    for (const job of jobs.rows) {
      try {
        if (job.job_type === "campaign.schedule" && job.workspace_id) {
          await processDueDeliveries(job.workspace_id);
        }
        await db.query(`update job_runs set status = 'succeeded', completed_at = now() where id = $1`, [job.id]);
      } catch (e) {
        const dead = job.attempts >= 5;
        await db.query(
          `update job_runs set status = $2, last_error = $3,
             scheduled_at = case when $2 = 'dead' then scheduled_at else now() + interval '30 seconds' end
           where id = $1`, [job.id, dead ? "dead" : "queued", String(e)]);
      }
    }
  });
  // 2. sweep due deliveries across workspaces with running campaigns
  const pools = getPool();
  const wss = await pools.query(
    `select distinct md.workspace_id from message_deliveries md
       join campaign_runs cr on cr.id = md.campaign_run_id
      where md.status = 'scheduled' and md.scheduled_at <= now() and cr.status = 'running'`);
  for (const row of wss.rows) {
    try {
      await processDueDeliveries(row.workspace_id);
    } catch (e) {
      console.error("delivery sweep failed for workspace", row.workspace_id, e);
    }
  }
}

export async function runWorker() {
  console.log(`worker up, polling every ${POLL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick().catch((e) => console.error("tick error", e));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
