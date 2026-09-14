// Warm reply = the prospect is leaning in: these always deserve a fast human response.
export const WARM_REPLY_CATEGORIES = ["interested", "question", "negotiation"] as const;
export type WarmReplyCategory = (typeof WARM_REPLY_CATEGORIES)[number];
export const isWarmReply = (category: string | null | undefined): category is WarmReplyCategory =>
  !!category && (WARM_REPLY_CATEGORIES as readonly string[]).includes(category);
