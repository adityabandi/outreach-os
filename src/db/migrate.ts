import { readdirSync, readFileSync } from "node:fs";
import { Client } from "./client";

const url = process.env.DATABASE_URL ?? "postgres://outreach:outreach@localhost:5433/outreach_os";
const client = new Client({ connectionString: url });
await client.connect();
await client.query(`create table if not exists schema_migrations (
  name text primary key, applied_at timestamptz not null default now())`);
const applied = new Set(
  (await client.query("select name from schema_migrations")).rows.map((r) => r.name),
);
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  console.log("applying", file);
  await client.query("begin");
  try {
    await client.query(readFileSync(`migrations/${file}`, "utf8"));
    await client.query("insert into schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}
console.log("migrations up to date");
await client.end();
