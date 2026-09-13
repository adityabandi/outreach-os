import { describe, it, expect } from "vitest";
import { canTransition, assertTransition } from "@/domain/state-machine";

describe("campaign state machine", () => {
  it("follows the approved path", () => {
    for (const [from, to] of [
      ["draft", "ready_for_review"], ["ready_for_review", "approval_pending"],
      ["approval_pending", "approved"], ["approved", "scheduled"], ["scheduled", "running"],
      ["running", "paused"], ["paused", "running"], ["running", "completed"],
    ] as const) expect(canTransition(from, to)).toBe(true);
  });
  it("rejects skipping approval", () => {
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("draft", "running")).toBe(false);
    expect(canTransition("approval_pending", "running")).toBe(false);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("stopped", "running")).toBe(false);
  });
  it("never resumes from terminal states", () => {
    for (const s of ["completed", "cancelled", "stopped"] as const) {
      expect(canTransition(s, "running")).toBe(false);
      expect(canTransition(s, "scheduled")).toBe(false);
    }
  });
  it("throws on illegal transitions", () => {
    expect(() => assertTransition("draft", "running")).toThrow(/illegal/);
  });
});
