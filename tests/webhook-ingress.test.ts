import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { handleWebhookPost, verifyWebhookSignature, webhookSecretFor, type WebhookDb } from "@/server/webhooks";

const SECRET = "test-secret";
const BODY = JSON.stringify({ id: "evt_1", account: "acct-1", type: "reply" });
const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");

function fakeDb(opts: { workspace?: string | null; conflictOnInsert?: boolean } = {}) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const db: WebhookDb = {
    async query(text, params) {
      queries.push({ text, params });
      if (text.includes("lookup_integration"))
        return { rows: opts.workspace ? [{ workspace_id: opts.workspace, organization_id: "org-1" }] : [], rowCount: opts.workspace ? 1 : 0 };
      if (text.includes("provider_webhook_events"))
        return { rows: opts.conflictOnInsert ? [] : [{ id: "row-1" }], rowCount: opts.conflictOnInsert ? 0 : 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, queries };
}
const withDb = (db: WebhookDb) => async <T>(fn: (d: WebhookDb) => Promise<T>) => fn(db);

describe("verifyWebhookSignature", () => {
  it("accepts a valid HMAC", () => expect(verifyWebhookSignature(SECRET, BODY, sign(BODY))).toBe(true));
  it("rejects wrong signature and wrong secret", () => {
    expect(verifyWebhookSignature(SECRET, BODY, sign(BODY, "other"))).toBe(false);
    expect(verifyWebhookSignature(SECRET, BODY, "deadbeef")).toBe(false);
  });
  it("rejects when no secret is configured", () => expect(verifyWebhookSignature(undefined, BODY, sign(BODY))).toBe(false));
  it("rejects tampered body", () => expect(verifyWebhookSignature(SECRET, BODY + " ", sign(BODY))).toBe(false));
});

describe("webhookSecretFor", () => {
  it("prefers provider-specific secret, falls back to dev", () => {
    expect(webhookSecretFor("mock-mailbox", { WEBHOOK_SECRET_MOCK_MAILBOX: "a", WEBHOOK_SECRET_DEV: "b" } as never)).toBe("a");
    expect(webhookSecretFor("mock-mailbox", { WEBHOOK_SECRET_DEV: "b" } as never)).toBe("b");
  });
});

describe("handleWebhookPost", () => {
  it("400 on invalid JSON", async () => {
    const out = await handleWebhookPost("p", "{nope", "", SECRET, withDb(fakeDb().db));
    expect(out.status).toBe(400);
  });
  it("400 on missing event id", async () => {
    const raw = JSON.stringify({ account: "a" });
    const out = await handleWebhookPost("p", raw, sign(raw), SECRET, withDb(fakeDb().db));
    expect(out.status).toBe(400);
  });
  it("401 on bad signature and writes nothing", async () => {
    const { db, queries } = fakeDb({ workspace: "ws-1" });
    const out = await handleWebhookPost("p", BODY, "deadbeef", SECRET, withDb(db));
    expect(out.status).toBe(401);
    expect(queries).toHaveLength(0);
  });
  it("202 records event and enqueues webhook.process for a known account", async () => {
    const { db, queries } = fakeDb({ workspace: "ws-1" });
    const out = await handleWebhookPost("mock-mailbox", BODY, sign(BODY), SECRET, withDb(db));
    expect(out.status).toBe(202);
    expect(out.body).toEqual({ recorded: true, workspace: "ws-1" });
    const job = queries.find((q) => q.text.includes("job_runs"));
    expect(job?.params?.[2]).toBe("webhook:mock-mailbox:evt_1");
  });
  it("202 records event without a job when account is unmapped", async () => {
    const { db, queries } = fakeDb();
    const out = await handleWebhookPost("mock-mailbox", BODY, sign(BODY), SECRET, withDb(db));
    expect(out.status).toBe(202);
    expect(out.body).toEqual({ recorded: true, workspace: null });
    expect(queries.find((q) => q.text.includes("job_runs"))).toBeUndefined();
  });
  it("200 on duplicate delivery, no second job", async () => {
    const { db, queries } = fakeDb({ workspace: "ws-1", conflictOnInsert: true });
    const out = await handleWebhookPost("mock-mailbox", BODY, sign(BODY), SECRET, withDb(db));
    expect(out.status).toBe(200);
    expect(queries.find((q) => q.text.includes("job_runs"))).toBeUndefined();
  });
});
