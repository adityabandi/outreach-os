import { describe, expect, it } from "vitest";
import { base64url, buildMimeMessage, encodeHeaderValue, tokensFromEnv } from "@/domain/adapters/gmail-mailbox";
import { chooseMailbox } from "@/domain/adapters/resolve";

describe("mime builder", () => {
  it("builds RFC 5322 with CRLF, threading headers, and plain-ASCII passthrough", () => {
    const msg = buildMimeMessage({
      from: "lara@ayurvedanest.org", fromName: "Lara from Ayurveda Nest",
      to: "maya@wildrootwellness.com", subject: "Partnership idea",
      body: "Hi Maya,\n\nQuick note.", inReplyTo: "<abc@mail.gmail.com>", references: "<abc@mail.gmail.com>",
    });
    expect(msg).toContain("From: Lara from Ayurveda Nest <lara@ayurvedanest.org>\r\n");
    expect(msg).toContain("To: maya@wildrootwellness.com\r\n");
    expect(msg).toContain("Subject: Partnership idea\r\n");
    expect(msg).toContain("In-Reply-To: <abc@mail.gmail.com>\r\n");
    expect(msg).toContain("\r\n\r\nHi Maya,\r\n\r\nQuick note.");
    expect(msg).not.toContain("\n\n");
  });
  it("RFC 2047-encodes non-ASCII headers, leaves ASCII alone", () => {
    expect(encodeHeaderValue("Lara")).toBe("Lara");
    expect(encodeHeaderValue("Aditiá Ñ")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
  it("base64url strips padding and unsafe chars", () => {
    expect(base64url("a+b/c=d")).toBe("YStiL2M9ZA");
  });
});

describe("mailbox selection", () => {
  it("prefers a healthy, configured gmail integration", () => {
    expect(chooseMailbox([
      { provider: "mock-mailbox", status: "healthy", encrypted_secret_ref: null },
      { provider: "gmail", status: "healthy", encrypted_secret_ref: "GMAIL_REFRESH_TOKEN_LARA" },
    ])).toEqual({ kind: "gmail", secretRef: "GMAIL_REFRESH_TOKEN_LARA" });
  });
  it("falls back to mock with no gmail row, an unhealthy row, or no secret ref", () => {
    expect(chooseMailbox([])).toEqual({ kind: "mock" });
    expect(chooseMailbox([{ provider: "gmail", status: "error", encrypted_secret_ref: "X" }])).toEqual({ kind: "mock" });
    expect(chooseMailbox([{ provider: "gmail", status: "healthy", encrypted_secret_ref: null }])).toEqual({ kind: "mock" });
  });
  it("env tokens resolve only when all three pieces exist", () => {
    const env = { GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "sec", REF_A: "tok" } as never;
    expect(tokensFromEnv("REF_A", env)).toEqual({ clientId: "id", clientSecret: "sec", refreshToken: "tok" });
    expect(tokensFromEnv("REF_MISSING", env)).toBeNull();
  });
});
