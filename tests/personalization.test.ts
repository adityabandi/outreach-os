import { describe, it, expect } from "vitest";
import { MockModelAdapter } from "@/domain/adapters/mock-model";
import { payloadHash } from "@/domain/payload";

const input = {
  firstName: "Meera", fullName: "Meera Rao", company: "Flow & Root",
  title: "Creator", offerName: "Ayurveda Nest",
  evidence: ["posts weekly about Ayurveda  and morning rituals"],
};

describe("mock personalization generation", () => {
  it("grounds the line in stored evidence verbatim (normalized whitespace)", async () => {
    const { line } = await new MockModelAdapter().generatePersonalization(input);
    expect(line).toBe("posts weekly about Ayurveda and morning rituals.");
  });
  it("falls back to a plain title/company fact pattern when no evidence exists", async () => {
    const { line } = await new MockModelAdapter().generatePersonalization({ ...input, evidence: [] });
    expect(line).toBe("Your creator at Flow & Root is exactly the audience we built this for.");
  });
  it("never invents facts: the fallback uses only provided fields", async () => {
    const { line } = await new MockModelAdapter().generatePersonalization({ ...input, evidence: [], title: "" });
    expect(line).toContain("work");
    expect(line).not.toContain("Creator");
  });
});

describe("payload hash sensitivity to personalization lines", () => {
  const base = { recipients: [{ person_id: "p1", contact_point_id: "c1" }] };
  it("adding a line changes the hash", () => {
    const withLine = { recipients: [{ person_id: "p1", contact_point_id: "c1", line: "hi there" }] };
    expect(payloadHash(withLine)).not.toBe(payloadHash(base));
  });
  it("changing a line changes the hash", () => {
    const a = { recipients: [{ person_id: "p1", contact_point_id: "c1", line: "a" }] };
    const b = { recipients: [{ person_id: "p1", contact_point_id: "c1", line: "b" }] };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });
});
