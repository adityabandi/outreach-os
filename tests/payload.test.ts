import { describe, it, expect } from "vitest";
import { canonicalize, payloadHash } from "@/domain/payload";

describe("canonical payload hashing", () => {
  it("is invariant to object key order (property: any permutation hashes the same)", () => {
    const a = { b: 1, a: { z: [1, { q: "x", p: 2 }], y: null }, c: "hi" };
    const b = { c: "hi", a: { y: null, z: [1, { p: 2, q: "x" }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });
  it("changes when any material field changes", () => {
    const base = { sender: "a@x.com", recipients: [1, 2], caps: { daily: 50 } };
    expect(payloadHash({ ...base, caps: { daily: 51 } })).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, recipients: [1, 2, 3] })).not.toBe(payloadHash(base));
    expect(payloadHash({ ...base, sender: "b@x.com" })).not.toBe(payloadHash(base));
  });
  it("drops undefined fields deterministically", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
  it("is stable across repeated hashing", () => {
    const p = { nested: { arr: [{ x: 1 }] }, s: "stable" };
    expect(payloadHash(p)).toBe(payloadHash(JSON.parse(JSON.stringify(p))));
  });
});
