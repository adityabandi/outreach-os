import { describe, it, expect } from "vitest";
import { diffLines, diffVersions } from "@/domain/diff";

const base = {
  sender_identity_id: "s1", channel: "email",
  sequence: [{ step_number: 1, delay_minutes: 0, subject_template: "Hi {{first_name}}", body_template: "line one\nline two\nline three" }],
  delivery: { timezone: "Europe/Madrid", send_window: { start_hour: 8, end_hour: 20 }, daily_workspace_cap: 50, sender_daily_cap: 25, per_domain_cap: 5 },
  follow_up: { enabled: true }, reply_policy: { auto_send: false }, suppression_policy: { check_before_send: true },
};
const rcpts = (emails: string[]) => emails.map((email) => ({ email }));

describe("diffLines", () => {
  it("marks unchanged lines same", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((l) => l.type === "same")).toBe(true);
  });
  it("marks insertions and deletions", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
    ]);
  });
});

describe("diffVersions", () => {
  it("reports unchanged for identical versions", () => {
    const d = diffVersions({ payload: base, recipients: rcpts(["a@x.com"]) }, { payload: { ...base }, recipients: rcpts(["a@x.com"]) });
    expect(d.unchanged).toBe(true);
  });
  it("reports audience deltas case-insensitively", () => {
    const d = diffVersions(
      { payload: base, recipients: rcpts(["a@x.com", "b@x.com"]) },
      { payload: base, recipients: rcpts(["A@x.com", "c@x.com"]) });
    expect(d.audienceAdded.map((r) => r.email)).toEqual(["c@x.com"]);
    expect(d.audienceRemoved.map((r) => r.email)).toEqual(["b@x.com"]);
  });
  it("reports setting changes with labels", () => {
    const next = { ...base, delivery: { ...base.delivery, daily_workspace_cap: 30 }, follow_up: { enabled: false } };
    const d = diffVersions({ payload: base, recipients: [] }, { payload: next, recipients: [] });
    const labels = d.settingChanges.map((c) => c.label);
    expect(labels).toContain("Workspace daily cap");
    expect(labels).toContain("Follow-ups");
    expect(d.settingChanges.find((c) => c.label === "Workspace daily cap")).toMatchObject({ from: "50", to: "30" });
  });
  it("reports changed, added and removed steps", () => {
    const next = {
      ...base,
      sequence: [
        { ...base.sequence[0], subject_template: "New subject" },
        { step_number: 2, delay_minutes: 60, subject_template: "Follow up", body_template: "nudge" },
      ],
    };
    const d = diffVersions({ payload: base, recipients: [] }, { payload: next, recipients: [] });
    expect(d.stepChanges.find((s) => s.step === 1)?.kind).toBe("changed");
    expect(d.stepChanges.find((s) => s.step === 1)?.subjectTo).toBe("New subject");
    expect(d.stepChanges.find((s) => s.step === 2)?.kind).toBe("added");
  });
  it("formats sender via formatter", () => {
    const next = { ...base, sender_identity_id: "s2" };
    const d = diffVersions({ payload: base, recipients: [] }, { payload: next, recipients: [] }, (id) => `sender-${id}`);
    expect(d.settingChanges[0]).toEqual({ label: "Sender", from: "sender-s1", to: "sender-s2" });
  });
});
