import { describe, expect, it } from "vitest";
import { unsubToken, unsubUrl, verifyUnsubToken } from "@/domain/unsubscribe";

const WS = "01a09ed6-83b1-7231-8b6f-6322fc721fb0";
const CP = "01a09ed6-83b1-7231-8b6f-6322fc721fc0";

describe("unsubscribe tokens", () => {
  it("round-trips workspace, contact and email", () => {
    const t = unsubToken(WS, CP, "Maya@WildrootWellness.com");
    expect(verifyUnsubToken(t)).toEqual({ workspaceId: WS, contactPointId: CP, email: "maya@wildrootwellness.com" });
  });
  it("rejects tampered payloads and signatures", () => {
    const t = unsubToken(WS, CP, "maya@wildrootwellness.com");
    const [raw] = t.split(".");
    expect(verifyUnsubToken(`${raw}.forged`)).toBeNull();
    // re-signing is impossible: a payload forged with another token's signature fails
    const sig = unsubToken(WS, CP, "attacker@example.com").split(".").pop();
    const forged = `${Buffer.from(`${WS}.${CP}.maya@wildrootwellness.com`, "utf8").toString("base64url")}.${sig}`;
    expect(verifyUnsubToken(forged)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifyUnsubToken("")).toBeNull();
    expect(verifyUnsubToken("no-dots-here")).toBeNull();
    expect(verifyUnsubToken("!!!.???")).toBeNull();
  });
  it("tokens differ across workspaces for the same address", () => {
    expect(unsubToken(WS, CP, "a@b.c")).not.toBe(unsubToken("01a09ed6-83e6-7f23-b025-da8d1756985a", CP, "a@b.c"));
  });
  it("builds clean urls", () => {
    expect(unsubUrl("http://localhost:3100/", WS, CP, "a@b.c")).toMatch(/^http:\/\/localhost:3100\/u\/.+\..+$/);
  });
});
