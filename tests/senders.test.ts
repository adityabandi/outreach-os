import { describe, expect, it } from "vitest";
import {
  checkVerificationCode, generateVerificationCode, hashVerificationCode,
  isValidEmail, normalizeAddress,
} from "@/domain/senders";

describe("sender address rules", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeAddress("  Lara@AyurvedaNest.ORG ")).toBe("lara@ayurvedanest.org");
  });
  it("accepts valid emails, rejects malformed ones", () => {
    expect(isValidEmail("lara@ayurvedanest.org")).toBe(true);
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("missing@tld")).toBe(false);
    expect(isValidEmail("two@@at.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("verification codes", () => {
  it("generates zero-padded 6-digit codes", () => {
    expect(generateVerificationCode(() => 42)).toBe("000042");
    expect(generateVerificationCode(() => 999999)).toBe("999999");
    expect(generateVerificationCode()).toMatch(/^\d{6}$/);
  });
  it("hashes are deterministic and domain-separated", () => {
    expect(hashVerificationCode("123456")).toBe(hashVerificationCode(" 123456 "));
    expect(hashVerificationCode("123456")).not.toBe(hashVerificationCode("123457"));
    expect(hashVerificationCode("123456")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("checkVerificationCode", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  const req = { tokenHash: hashVerificationCode("654321"), expiresAt: future };
  it("accepts the right code before expiry", () => {
    expect(checkVerificationCode(req, "654321")).toBe("ok");
  });
  it("rejects a wrong code without expiring the request", () => {
    expect(checkVerificationCode(req, "111111")).toBe("mismatch");
  });
  it("rejects when no request was ever made", () => {
    expect(checkVerificationCode({ tokenHash: null, expiresAt: null }, "654321")).toBe("no_request");
  });
  it("rejects expired requests even with the right code", () => {
    expect(checkVerificationCode({ tokenHash: req.tokenHash, expiresAt: past }, "654321")).toBe("expired");
  });
});
