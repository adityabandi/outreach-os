import { describe, it, expect } from "vitest";
import { matchesSuppression, capAllowance, withinSendWindow, domainOf, normalizeEmail } from "@/domain/compliance";

describe("suppression matching", () => {
  const entries = [
    { scope: "workspace", normalized_value: "james@x.com", expires_at: null },
    { scope: "domain", normalized_value: "spammy.io", expires_at: null },
    { scope: "workspace", normalized_value: "expired@x.com", expires_at: "2020-01-01T00:00:00Z" },
  ];
  it("matches exact addresses", () => {
    expect(matchesSuppression(entries, "James@X.com").suppressed).toBe(true);
  });
  it("matches whole domains", () => {
    expect(matchesSuppression(entries, "anyone@spammy.io").suppressed).toBe(true);
    expect(matchesSuppression(entries, "anyone@good.io").suppressed).toBe(false);
  });
  it("ignores expired entries", () => {
    expect(matchesSuppression(entries, "expired@x.com").suppressed).toBe(false);
  });
  it("normalizes case and whitespace", () => {
    expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
    expect(domainOf("a@b.com")).toBe("b.com");
  });
});

describe("caps", () => {
  it("computes remaining allowance per axis", () => {
    const a = capAllowance({ workspaceToday: 49, senderToday: 25, domainToday: 5 }, { workspaceDaily: 50, senderDaily: 25, perDomain: 5 });
    expect(a).toEqual({ workspace: 1, sender: 0, domain: 0 });
  });
});

describe("send windows", () => {
  it("respects the timezone window", () => {
    const noonUTC = new Date("2026-09-13T12:00:00Z"); // 14:00 in Europe/Madrid
    expect(withinSendWindow(noonUTC, "Europe/Madrid", { start_hour: 8, end_hour: 20 })).toBe(true);
    expect(withinSendWindow(noonUTC, "Europe/Madrid", { start_hour: 15, end_hour: 20 })).toBe(false);
  });
  it("handles overnight windows", () => {
    const late = new Date("2026-09-13T22:00:00Z");
    expect(withinSendWindow(late, "UTC", { start_hour: 20, end_hour: 6 })).toBe(true);
  });
});
