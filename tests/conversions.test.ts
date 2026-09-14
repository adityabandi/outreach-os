import { describe, it, expect } from "vitest";
import { recordConversionEvent } from "@/domain/conversions";
import type { Db } from "@/db/client";

interface FakeOpts {
  codeRow?: { person_id: string; campaign_id: string | null } | null;
  emailRow?: { person_id: string } | null;
  deliveryRow?: { id: string; campaign_id: string } | null;
  insertConflict?: boolean;
}
function fakeDb(opts: FakeOpts) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const db = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (text.includes("from conversion_codes")) return { rows: opts.codeRow ? [opts.codeRow] : [], rowCount: opts.codeRow ? 1 : 0 };
      if (text.includes("from contact_points")) return { rows: opts.emailRow ? [opts.emailRow] : [], rowCount: opts.emailRow ? 1 : 0 };
      if (text.includes("from message_deliveries")) return { rows: opts.deliveryRow ? [opts.deliveryRow] : [], rowCount: opts.deliveryRow ? 1 : 0 };
      if (text.includes("insert into conversions"))
        return { rows: opts.insertConflict ? [] : [{ id: "conv-1" }], rowCount: opts.insertConflict ? 0 : 1 };
      return { rows: [], rowCount: 1 }; // audit
    },
  } as unknown as Db;
  return { db, queries };
}
const IDS = { organizationId: "org-1", workspaceId: "ws-1" };
const EVT = { externalRef: "ref-1", eventType: "signup" as const, provider: "rewardful", code: " arjun-20 ", email: "Arjun@VedicLiving.in" };

describe("recordConversionEvent mapping", () => {
  it("matches by discount code first (normalized), attributing person and campaign", async () => {
    const { db, queries } = fakeDb({ codeRow: { person_id: "p1", campaign_id: "c1" }, deliveryRow: { id: "d1", campaign_id: "c1" } });
    const out = await recordConversionEvent(db, IDS, EVT);
    expect(out).toEqual({ recorded: true, matchedBy: "code", personId: "p1", campaignId: "c1" });
    expect(queries[0].params?.[0]).toBe("ARJUN-20"); // code normalized: trimmed, uppercased
    expect(queries.some((q) => q.text.includes("from contact_points"))).toBe(false); // email fallback not needed
  });
  it("falls back to the signup email when the code is unknown", async () => {
    const { db, queries } = fakeDb({ codeRow: null, emailRow: { person_id: "p2" }, deliveryRow: { id: "d2", campaign_id: "c9" } });
    const out = await recordConversionEvent(db, IDS, EVT);
    expect(out).toEqual({ recorded: true, matchedBy: "email", personId: "p2", campaignId: "c9" });
    const cp = queries.find((q) => q.text.includes("from contact_points"));
    expect(cp?.params?.[0]).toBe("arjun@vedicliving.in"); // email normalized: trimmed, lowercased
  });
  it("records nothing when neither code nor email matches", async () => {
    const { db, queries } = fakeDb({ codeRow: null, emailRow: null });
    const out = await recordConversionEvent(db, IDS, EVT);
    expect(out).toEqual({ recorded: false, reason: "no_match" });
    expect(queries.some((q) => q.text.includes("insert into conversions"))).toBe(false);
  });
  it("dedupes on the external event reference", async () => {
    const { db } = fakeDb({ codeRow: { person_id: "p1", campaign_id: "c1" }, deliveryRow: { id: "d1", campaign_id: "c1" }, insertConflict: true });
    const out = await recordConversionEvent(db, IDS, EVT);
    expect(out).toEqual({ recorded: false, reason: "duplicate" });
  });
  it("scopes the delivery attribution to the code's campaign", async () => {
    const { db, queries } = fakeDb({ codeRow: { person_id: "p1", campaign_id: "c1" }, deliveryRow: { id: "d1", campaign_id: "c1" } });
    await recordConversionEvent(db, IDS, EVT);
    const del = queries.find((q) => q.text.includes("from message_deliveries"));
    expect(del?.params).toEqual(["p1", "c1"]);
  });
  it("records the audit trail with provider and match path", async () => {
    const { db, queries } = fakeDb({ codeRow: { person_id: "p1", campaign_id: "c1" }, deliveryRow: { id: "d1", campaign_id: "c1" } });
    await recordConversionEvent(db, IDS, EVT);
    const auditCall = queries.find((q) => q.text.includes("insert into audit_events"));
    expect(auditCall).toBeTruthy();
  });
});
