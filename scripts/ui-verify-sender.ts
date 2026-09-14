// UI walkthrough: admin sends a verification code, enters it, sender flips to verified.
import { chromium } from "playwright";
import pg from "pg";

const base = "http://localhost:3100";
const db = new pg.Client("postgres://outreach:outreach@localhost:5433/outreach_os");
await db.connect();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.selectOption("select#email", { label: "Aditya Bandi - adi@bandi.dev" });
await page.click("button[type=submit]");
await page.waitForURL(`${base}/w/ayurveda-nest`, { timeout: 15000 });

await page.goto(`${base}/w/ayurveda-nest/settings`, { waitUntil: "networkidle" });
// find the growth sender row and click Send code
const row = page.locator("li", { hasText: "growth@ayurvedanest.org" });
await row.getByRole("button", { name: "Send code" }).click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);
await page.locator("text=Senders & integrations").scrollIntoViewIfNeeded();
await page.screenshot({ path: "/tmp/shots/sender-pending.png" });
console.log("shot sender-pending");

const mail = (await db.query(
  `select body from outbox_messages where to_address='growth@ayurvedanest.org' order by created_at desc limit 1`)).rows[0];
const code = mail.body.match(/ {2}(\d{6})\n/)[1];
console.log("code from outbox:", code);

await row.locator("input[name=code]").fill(code);
await row.getByRole("button", { name: "Confirm" }).click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);
await page.locator("text=Senders & integrations").scrollIntoViewIfNeeded();
await page.screenshot({ path: "/tmp/shots/sender-verified.png" });
console.log("shot sender-verified");

const status = (await db.query(
  `select verification_status, verified_at from sender_identities where address='growth@ayurvedanest.org'`)).rows[0];
console.log("db state:", status.verification_status, !!status.verified_at);
await browser.close();
await db.end();
