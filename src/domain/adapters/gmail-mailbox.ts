// Gmail mailbox adapter: real sends via the Gmail API. OAuth tokens come from
// env vars named by the integration row's encrypted_secret_ref - tokens are
// never stored in the database, logged, or audited.
import type { MailboxAdapter, SendInput, SendResult } from "./types";

export interface MimeInput {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}

/** RFC 2047-encode a header value only when it leaves printable ASCII. */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 5322 message with CRLF line endings, ready for gmail users.messages.send raw. */
export function buildMimeMessage(i: MimeInput): string {
  const headers = [
    `From: ${i.fromName ? `${encodeHeaderValue(i.fromName)} <${i.from}>` : i.from}`,
    `To: ${i.to}`,
    `Subject: ${encodeHeaderValue(i.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  if (i.inReplyTo) headers.push(`In-Reply-To: ${i.inReplyTo}`);
  if (i.references) headers.push(`References: ${i.references}`);
  return `${headers.join("\r\n")}\r\n\r\n${i.body.replace(/\r?\n/g, "\r\n")}`;
}

interface GmailTokens { clientId: string; clientSecret: string; refreshToken: string }

/** Token config comes from env vars; secretRef names the refresh-token variable. */
export function tokensFromEnv(secretRef: string, env: NodeJS.ProcessEnv = process.env): GmailTokens | null {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  const refreshToken = env[secretRef];
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

export class GmailMailboxAdapter implements MailboxAdapter {
  provider = "gmail";
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private tokens: GmailTokens,
    private fetchFn: typeof fetch = fetch,
    private apiBase = "https://gmail.googleapis.com/gmail/v1/users/me",
  ) {}

  private async access(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.token;
    const res = await this.fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.tokens.clientId, client_secret: this.tokens.clientSecret,
        refresh_token: this.tokens.refreshToken, grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`gmail token refresh failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.accessToken.token;
  }

  async validateSender(address: string) {
    const token = await this.access();
    const res = await this.fetchFn(`${this.apiBase}/profile`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, reason: `gmail profile check failed: ${res.status}` };
    const profile = (await res.json()) as { emailAddress?: string };
    return profile.emailAddress?.toLowerCase() === address.toLowerCase()
      ? { ok: true }
      : { ok: false, reason: `authenticated account is ${profile.emailAddress}, not ${address}` };
  }

  async send(input: SendInput): Promise<SendResult> {
    const token = await this.access();
    // threadRef carries the RFC 5322 Message-ID of the message being answered
    const raw = base64url(buildMimeMessage({
      from: input.fromAddress, fromName: input.fromName, to: input.toAddress,
      subject: input.subject, body: input.body, inReplyTo: input.threadRef ?? null,
      references: input.threadRef ?? null,
    }));
    const res = await this.fetchFn(`${this.apiBase}/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`gmail send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id: string; threadId: string };
    return { providerMessageId: json.id, threadRef: json.threadId };
  }
}
