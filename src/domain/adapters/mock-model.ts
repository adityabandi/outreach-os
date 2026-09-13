// Deterministic model adapter for development: no external AI calls, but the
// same structured-output contract a real ModelAdapter must satisfy.
import type { ModelAdapter, ReplyClassification } from "./types";

const RULES: [RegExp, ReplyClassification["category"], number][] = [
  [/unsubscribe|remove me|stop email|opt.?out/i, "unsubscribe", 0.98],
  [/out of (the )?office|annual leave|vacation|ooo/i, "out_of_office", 0.95],
  [/wrong person|not (the )?right (person|contact)|try my colleague/i, "wrong_person", 0.9],
  [/pricing|discount|cheaper|budget|negotiate|too expensive/i, "negotiation", 0.85],
  [/legal|gdpr|complaint|report you|spam complaint/i, "complaint", 0.9],
  [/not (right )?now|later|next quarter|maybe next/i, "not_now", 0.8],
  [/sounds (good|interesting)|tell me more|let'?s talk|book|interested|love to/i, "interested", 0.88],
  [/\?|how does|what is|can you explain/i, "question", 0.7],
  [/no thanks|not interested|we('re| are) happy with/i, "objection", 0.75],
];

export class MockModelAdapter implements ModelAdapter {
  provider = "mock-model";
  async classifyReply(input: { subject: string; body: string }): Promise<ReplyClassification> {
    const text = `${input.subject}\n${input.body}`;
    for (const [re, category, confidence] of RULES) {
      if (re.test(text)) return { category, confidence, rationale: `matched rule for ${category}` };
    }
    return { category: "other", confidence: 0.4, rationale: "no rule matched; low confidence" };
  }
  async draftReply(input: { subject: string; body: string; category: string }) {
    const openers: Record<string, string> = {
      interested: "Thanks for getting back to me - great to hear. Would a short call this week work?",
      question: "Great question - happy to clarify.",
      not_now: "Totally understand. I'll check back next quarter - feel free to reach out sooner if anything changes.",
      objection: "Fair point, and thanks for the honest reply.",
      negotiation: "Thanks for the context. Let me look into what we can do and come back to you.",
    };
    return {
      body: openers[input.category] ?? "Thanks for your reply - I'll look into this and get back to you shortly.",
    };
  }
}
