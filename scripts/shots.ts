import { chromium } from "playwright";
import pg from "pg";

const base = "http://localhost:3100";
const db = new pg.Client("postgres://outreach:outreach@localhost:5433/outreach_os");
await db.connect();
const ws = (await db.query(`select id from workspaces where slug='ayurveda-nest'`)).rows[0].id;
const camp = (await db.query(`select id from campaigns where name='Creator Wave 1'`)).rows[0].id;
const approval = (await db.query(`select id from approval_requests where status='pending' limit 1`)).rows[0].id;
const person = (await db.query(`select id from people where normalized_email='maya@wildrootwellness.com'`)).rows[0].id;
const importList = (await db.query(`select id from prospect_lists where import_report_json is not null order by created_at desc limit 1`)).rows[0]?.id;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.selectOption("select#email", { label: "Aditya Bandi - adi@bandi.dev" });
await page.click("button[type=submit]");
await page.waitForURL(`${base}/w/ayurveda-nest`, { timeout: 15000 });

const shots: [string, string][] = [
  ["dashboard", `/w/ayurveda-nest`],
  ["campaigns", `/w/ayurveda-nest/campaigns`],
  ["campaign-running", `/w/ayurveda-nest/campaigns/${camp}`],
  ["approval-review", `/w/ayurveda-nest/approvals/${approval}`],
  ["prospects", `/w/ayurveda-nest/prospects`],
  ["prospects-search", `/w/ayurveda-nest/prospects?q=herbal`],
  ["prospect-detail", `/w/ayurveda-nest/prospects/${person}`],
  ["replies", `/w/ayurveda-nest/replies`],
  ["analytics", `/w/ayurveda-nest/analytics`],
  ["suppressions", `/w/ayurveda-nest/suppressions`],
  ["suppressions-check", `/w/ayurveda-nest/suppressions?check=nina@slowapothecary.com`],
  ["audit", `/w/ayurveda-nest/audit`],
  ["audit-filtered", `/w/ayurveda-nest/audit?actor=user&action=approval`],
  ["outbox", `/w/ayurveda-nest/outbox`],
  ...(importList ? [["import-result", `/w/ayurveda-nest/prospects/import/result?list=${importList}`] as [string, string]] : []),
  ["settings", `/w/ayurveda-nest/settings`],
];
for (const [name, path] of shots) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true });
  console.log("shot", name);
}
await browser.close();
await db.end();
