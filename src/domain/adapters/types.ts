// Provider boundaries. Every external system sits behind one of these.
export interface SendInput {
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  body: string;
  threadRef?: string | null;
  idempotencyKey: string;
}
export interface SendResult {
  providerMessageId: string;
  threadRef: string;
}

export interface MailboxAdapter {
  provider: string;
  validateSender(address: string): Promise<{ ok: boolean; reason?: string }>;
  send(input: SendInput): Promise<SendResult>;
}

export interface ReplyClassification {
  category:
    | "interested" | "question" | "objection" | "not_now" | "unsubscribe"
    | "wrong_person" | "out_of_office" | "complaint" | "negotiation" | "other";
  confidence: number;
  rationale: string;
}

export interface ModelAdapter {
  provider: string;
  classifyReply(input: { subject: string; body: string }): Promise<ReplyClassification>;
  draftReply(input: { subject: string; body: string; category: string }): Promise<{ body: string }>;
}

export interface ContactVerificationAdapter {
  provider: string;
  verify(email: string): Promise<{ status: "verified" | "risky" | "invalid"; reason: string }>;
}
